/**
 * 固定テキストプラグインの単体試験。
 *
 * 偽サーバー管理境界と基盤を組み合わせ、正常な送信→確認、二重送信拒否、
 * 応答期限切れ・切断の結果不明、遅延・重複確認の非対応、不正応答での
 * セッション中断、破棄後の決着、統計の集計、状態購読の通知を確かめる。
 * 本文を検証や状態に残さないことも確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createBridgeAppCore, type BridgeAppCore } from "bridge-app-core/core";
import { wrapServerSession } from "bridge-app-core/core";
import type { PluginDefinition, PluginInstance, PluginInstanceHandle } from "bridge-app-core/core";
import {
  TEXT_PORT_ID,
  createTextPlugin,
  textPlugin,
  type TextPluginOperations,
  type TextPluginState,
  type TextSendResult,
} from "../src/plugin.ts";
import { isTextShowRequest } from "../src/contract.ts";
import { 偽サーバー, type 偽ReliableSession } from "./fakes.ts";

/**
 * 操作口を持たない検証用のプラグイン定義。
 *
 * 基盤が操作口なしの個体をどう扱うか（`getOperations` が `undefined`・
 * 状態はそのまま通す）を確かめる材料であり、診断プラグイン本体には
 * 依存しない（パッケージ間の build 循環を作らない）。
 */
interface StubNoOperationsState {
  readonly stubCount: number;
}

/** 操作口を持たない検証用の個体。割当て・破棄だけを受け付ける。 */
class StubNoOperationsInstance implements PluginInstance<StubNoOperationsState> {
  /** {@inheritDoc PluginInstance.attach} */
  attach(): void {}
  /** {@inheritDoc PluginInstance.getState} */
  getState(): StubNoOperationsState {
    return { stubCount: 0 };
  }
  /** {@inheritDoc PluginInstance.dispose} */
  dispose(): void {}
}

/** 操作口を持たない検証用のプラグイン定義。 */
const stubNoOperationsPlugin: PluginDefinition<StubNoOperationsState> = {
  pluginId: "stub-operations-less",
  ports: [{ portId: "stub", accepts: [{ kind: "reliable", direction: "bidirectional" }] }],
  create(): PluginInstance<StubNoOperationsState> {
    return new StubNoOperationsInstance();
  },
};

const cores: BridgeAppCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close();
  }
});

/** テキストインスタンスを生成し、reliable セッションを割り当てる。 */
function テキスト割当て(
  fake: 偽サーバー,
  sessionId: string,
  responseTimeoutMs = 30,
): {
  readonly core: BridgeAppCore;
  readonly handle: PluginInstanceHandle<TextPluginState, TextPluginOperations>;
  readonly ops: TextPluginOperations;
  readonly localSessionId: string;
  readonly session: 偽ReliableSession;
} {
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const handle = core.createInstance(createTextPlugin({ responseTimeoutMs }));
  const started = fake.開始Reliable(sessionId);
  core.assign(started.info.localSessionId, handle.instanceId, TEXT_PORT_ID);
  const ops = handle.getOperations?.();
  if (ops === undefined) throw new Error("テキスト操作口がない。");
  return {
    core,
    handle,
    ops,
    localSessionId: started.info.localSessionId,
    session: started.session,
  };
}

/**
 * 送信記録を取り出し、表示要求の形状を検証する。
 *
 * @param session - 送信記録を持つ偽セッション。
 * @returns 検証済みの表示要求。
 */
function 送信要求(session: 偽ReliableSession): { readonly id: string; readonly text: string } {
  expect(session.sent).toHaveLength(1);
  const 記録 = session.sent[0];
  if (!isTextShowRequest(記録)) throw new Error("表示要求の形状ではない。");
  return 記録;
}

test("正常な送信は反映確認で決着する", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId, session } = テキスト割当て(fake, "text");

  const 決着約束 = ops.sendText("こんにちは\n世界", localSessionId);
  const 要求 = 送信要求(session);
  expect(要求.text).toBe("こんにちは\n世界");
  // 実行中は送信不可になる。
  expect(handle.getState().canSend).toBe(false);
  expect(handle.getState().pendingId).toBe(要求.id);

  fake.受信(localSessionId, { op: "shown", id: 要求.id });
  const 決着 = await 決着約束;
  expect(決着).toEqual({ status: "acknowledged", id: 要求.id });
  expect(handle.getState()).toEqual({
    canSend: true,
    pendingId: null,
    lastResult: 決着,
    stats: { attempts: 1, acknowledged: 1, unknown: 0 },
  });
});

test("送信中の重複送信は拒否される", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId, session } = テキスト割当て(fake, "text");

  const 一件目 = ops.sendText("一つ目", localSessionId);
  // 同時実行は一件であり、二件目はプラグイン本体が拒否する。
  await expect(ops.sendText("二つ目", localSessionId)).rejects.toThrow(RangeError);
  expect(session.sent).toHaveLength(1);
  expect(handle.getState().stats.attempts).toBe(1);

  const 要求 = 送信要求(session);
  fake.受信(localSessionId, { op: "shown", id: 要求.id });
  expect(await 一件目).toEqual({ status: "acknowledged", id: 要求.id });
});

test("応答期限切れは結果不明になり遅延確認は無視される", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId, session } = テキスト割当て(fake, "text", 20);

  const 決着 = await ops.sendText("期限切れ", localSessionId);
  const 要求 = 送信要求(session);
  expect(決着.status).toBe("unknown");
  if (決着.status !== "unknown") throw new Error("結果不明ではない。");
  expect(決着.reason).toBe("timeout");
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 0, unknown: 1 });

  // 遅延確認は次の要求に対応しない。
  fake.受信(localSessionId, { op: "shown", id: 要求.id });
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 0, unknown: 1 });
  expect(handle.getState().lastResult).toEqual(決着);

  // 次の送信はできる。
  const 次の決着約束 = ops.sendText("次の要求", localSessionId);
  expect(session.sent).toHaveLength(2);
  const 次の記録 = session.sent[1];
  if (!isTextShowRequest(次の記録)) throw new Error("表示要求の形状ではない。");
  expect(次の記録.id).not.toBe(要求.id);
  fake.受信(localSessionId, { op: "shown", id: 次の記録.id });
  expect(await 次の決着約束).toEqual({ status: "acknowledged", id: 次の記録.id });
  expect(handle.getState().stats).toEqual({ attempts: 2, acknowledged: 1, unknown: 1 });
});

test("切断は結果不明になる", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId } = テキスト割当て(fake, "text");

  const 決着約束 = ops.sendText("切断", localSessionId);
  fake.終了(localSessionId, { kind: "aborted", error: new Error("切断") });
  const 決着 = await 決着約束;
  expect(決着.status).toBe("unknown");
  if (決着.status !== "unknown") throw new Error("結果不明ではない。");
  expect(決着.reason).toBe("disconnected");
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 0, unknown: 1 });
  expect(handle.getState().canSend).toBe(false);
});

test("遅延・重複確認は次の要求に対応しない", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId, session } = テキスト割当て(fake, "text");

  const 決着約束 = ops.sendText("確認", localSessionId);
  const 要求 = 送信要求(session);
  fake.受信(localSessionId, { op: "shown", id: 要求.id });
  const 決着 = await 決着約束;

  // 重複確認は無視する。
  fake.受信(localSessionId, { op: "shown", id: 要求.id });
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 1, unknown: 0 });
  expect(handle.getState().lastResult).toEqual(決着);

  // 対応する要求のない確認は無視し、中断しない。
  fake.受信(localSessionId, { op: "shown", id: "存在しない識別子" });
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 1, unknown: 0 });
  expect(session.aborted).toEqual([]);
  expect(session.isAlive).toBe(true);
});

test("不正な応答ではそのセッションを中断する", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId, session } = テキスト割当て(fake, "text");

  const 決着約束 = ops.sendText("不正応答", localSessionId);
  // 形状の不正な応答は対象セッションのみ中断する。
  fake.受信(localSessionId, { op: "shown" });
  expect(session.sent).toHaveLength(1);
  expect(session.aborted).toHaveLength(1);
  expect(session.isAlive).toBe(false);
  // 中断で応答待ちは結果不明（切断）になる。
  const 決着 = await 決着約束;
  expect(決着.status).toBe("unknown");
  if (決着.status !== "unknown") throw new Error("結果不明ではない。");
  expect(決着.reason).toBe("disconnected");
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 0, unknown: 1 });

  // 応答待ちがなくても不正な応答は中断する。
  const 別fake = new 偽サーバー();
  const 別割当て = テキスト割当て(別fake, "text-別");
  別fake.受信(別割当て.localSessionId, { op: "ping", id: "診断の形状" });
  expect(別割当て.session.sent).toEqual([]);
  expect(別割当て.session.aborted).toHaveLength(1);
});

test("破棄後は応答待ちが結果不明で確定する", async () => {
  const fake = new 偽サーバー();
  const { core, handle, ops, localSessionId, session } = テキスト割当て(fake, "text");

  const 決着約束 = ops.sendText("破棄", localSessionId);
  core.removeInstance(handle.instanceId);
  const 決着 = await 決着約束;
  expect(決着.status).toBe("unknown");
  if (決着.status !== "unknown") throw new Error("結果不明ではない。");
  expect(決着.reason).toBe("disposed");
  expect(handle.getState().stats).toEqual({ attempts: 1, acknowledged: 0, unknown: 1 });

  // 遅延確認が届いても決着は変わらない。
  expect(handle.getState().lastResult).toEqual(決着);
  // 破棄後の送信と購読登録は拒否・例外になる。
  await expect(ops.sendText("以後", localSessionId)).rejects.toThrow(RangeError);
  expect(() => ops.onStateChanged(() => {})).toThrow(RangeError);
  expect(session.aborted).toHaveLength(1);
});

test("統計は送信試行・反映確認・結果不明を数える", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId, session } = テキスト割当て(fake, "text", 20);

  // 反映確認を数える。
  const 確認約束 = ops.sendText("確認", localSessionId);
  const 確認要求 = 送信要求(session);
  fake.受信(localSessionId, { op: "shown", id: 確認要求.id });
  await 確認約束;

  // 期限切れを数える。
  await ops.sendText("期限切れ", localSessionId);

  // 切断を数える。
  const 切断約束 = ops.sendText("切断", localSessionId);
  fake.終了(localSessionId, { kind: "closed" });
  await 切断約束;

  expect(handle.getState().stats).toEqual({ attempts: 3, acknowledged: 1, unknown: 2 });
  // 輸送統計には混ぜず、本文も状態に残さない。
  expect(JSON.stringify(handle.getState())).not.toMatch(/確認|期限切れ|切断/);
});

test("状態購読で変化が通知される", async () => {
  const fake = new 偽サーバー();
  const { ops, localSessionId, session } = テキスト割当て(fake, "text");

  const 届いた: TextPluginState[] = [];
  const 購読解除 = ops.onStateChanged((状態) => {
    届いた.push(状態);
  });
  // 購読者の例外は隔離し、他の購読者へは届ける。
  ops.onStateChanged(() => {
    throw new Error("購読者の失敗");
  });

  const 決着約束 = ops.sendText("購読", localSessionId);
  expect(届いた.at(-1)?.pendingId).not.toBe(null);
  expect(届いた.at(-1)?.canSend).toBe(false);

  const 要求 = 送信要求(session);
  fake.受信(localSessionId, { op: "shown", id: 要求.id });
  await 決着約束;
  const 最終 = 届いた.at(-1);
  expect(最終?.canSend).toBe(true);
  expect(最終?.pendingId).toBe(null);

  // 解除後は通知が止まる。
  const 件数 = 届いた.length;
  購読解除();
  const 次の約束 = ops.sendText("解除後", localSessionId);
  const 次の記録 = session.sent[1];
  if (!isTextShowRequest(次の記録)) throw new Error("表示要求の形状ではない。");
  fake.受信(localSessionId, { op: "shown", id: 次の記録.id });
  await 次の約束;
  expect(届いた).toHaveLength(件数);
});

test("送信前の検証と割当ての検査で拒否される", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, localSessionId } = テキスト割当て(fake, "text");

  // 不正入力は送信前に拒否し、試行に数えない。
  await expect(ops.sendText("", localSessionId)).rejects.toThrow(RangeError);
  await expect(ops.sendText("あ".repeat(513), localSessionId)).rejects.toThrow(RangeError);
  // ADR: `as` は実行時検証の試験のための境界突破であり、非文字列入力の拒否を確かめる。
  await expect(ops.sendText(123 as unknown as string, localSessionId)).rejects.toThrow(RangeError);
  expect(handle.getState().stats.attempts).toBe(0);

  // 現在の割当てと識別子が一致しない送信は拒否する。
  await expect(ops.sendText("本文", "local-存在しない")).rejects.toThrow(RangeError);
  expect(handle.getState().stats.attempts).toBe(0);

  // 未割当ての送信は拒否する。
  const 未割当て定義 = createTextPlugin({ responseTimeoutMs: 30 });
  const 未割当て = 未割当て定義.create();
  try {
    const 未割当て操作口 = 未割当て.getOperations?.();
    if (未割当て操作口 === undefined) throw new Error("テキスト操作口がない。");
    await expect(未割当て操作口.sendText("本文", localSessionId)).rejects.toThrow(RangeError);
  } finally {
    未割当て.dispose();
  }

  // 応答期限の指定が不正なら定義を作れない。
  expect(() => createTextPlugin({ responseTimeoutMs: 0 })).toThrow(RangeError);
  expect(() => createTextPlugin({ responseTimeoutMs: Number.NaN })).toThrow(RangeError);
});

test("テキストの接続口に合わない操作口ではattachできない", () => {
  const fake = new 偽サーバー();
  const latest = fake.開始Latest("pose");
  const latest操作口 = wrapServerSession(latest.session, latest.info).session;
  const reliable = fake.開始Reliable("text");
  const reliable操作口 = wrapServerSession(reliable.session, reliable.info).session;

  const instance = textPlugin.create();
  try {
    // 接続口違いは `RangeError` になる。
    expect(() => instance.attach("存在しない口", reliable操作口)).toThrow(RangeError);
    // 種別違いは `RangeError` になる。
    expect(() => instance.attach(TEXT_PORT_ID, latest操作口)).toThrow(RangeError);
    expect(instance.getState().stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  } finally {
    instance.dispose();
  }
  // 破棄後の割当ては `RangeError` になる。
  expect(() => instance.attach(TEXT_PORT_ID, reliable操作口)).toThrow(RangeError);
});

test("操作口はハンドル経由で取得できる", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);

  // テキストの操作口は型付きで取得できる。
  const テキストハンドル = core.createInstance(textPlugin);
  const テキスト操作口 = テキストハンドル.getOperations?.();
  expect(typeof テキスト操作口?.sendText).toBe("function");
  expect(typeof テキスト操作口?.onStateChanged).toBe("function");
  // 汎用の任意 payload 送信口は作らない。
  expect(テキスト操作口).not.toHaveProperty("sendReliable");

  // 操作口を持たない個体の振る舞いは変わらない。
  const スタブハンドル = core.createInstance(stubNoOperationsPlugin);
  expect(スタブハンドル.getOperations?.()).toBe(undefined);
  expect(スタブハンドル.getState()).toEqual({ stubCount: 0 });
});

test("切替え時は旧要求を持ち越さない", async () => {
  const fake = new 偽サーバー();
  const { core, handle, ops, localSessionId } = テキスト割当て(fake, "text");

  const 旧決着約束 = ops.sendText("旧要求", localSessionId);
  // 新しいセッションへ割り当て直す（未決着通信を混在させない）。
  const 次 = fake.開始Reliable("text-次");
  const 次の割当て = core.listAssignments()[0];
  if (次の割当て === undefined) throw new Error("割当てがない。");
  core.unassign(次の割当て.localSessionId);
  core.assign(次.info.localSessionId, handle.instanceId, TEXT_PORT_ID);

  // 旧要求は結果不明（切断）で確定する。
  const 旧決着: TextSendResult = await 旧決着約束;
  expect(旧決着.status).toBe("unknown");
  // 旧セッションの遅延確認は次の要求に対応しない。
  const 次の操作口 = handle.getOperations?.();
  if (次の操作口 === undefined) throw new Error("テキスト操作口がない。");
  const 新決着約束 = 次の操作口.sendText("新要求", 次.info.localSessionId);
  fake.受信(次.info.localSessionId, { op: "shown", id: "text-1" });
  const 新決着 = await 新決着約束;
  // 旧識別子の確認では決着しないため、期限切れで結果不明になる。
  expect(新決着.status).toBe("unknown");
});
