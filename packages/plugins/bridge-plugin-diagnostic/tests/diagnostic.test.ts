/**
 * 同梱診断プラグインの単体試験。
 *
 * 偽サーバー管理境界と基盤を組み合わせ、echo・ping の応答形状、
 * 不正形状での中断、応答統計、改訂番号の単調増加、状態購読を確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createBridgeAppCore, type BridgeAppCore } from "bridge-app-core/core";
import { wrapServerSession } from "bridge-app-core/core";
import {
  DIAGNOSTIC_PORT_ID,
  diagnosticPlugin,
  type DiagnosticOperations,
  type DiagnosticStats,
} from "../src/index.ts";
import type { PluginInstanceHandle } from "bridge-app-core/core";
import { 偽サーバー, type 偽ReliableSession } from "./fakes.ts";

const cores: BridgeAppCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close();
  }
});

/** 診断インスタンスを生成し、reliable セッションを割り当てる。 */
function 診断割当て(
  fake: 偽サーバー,
  sessionId: string,
): {
  readonly core: BridgeAppCore;
  readonly handle: PluginInstanceHandle<DiagnosticStats, DiagnosticOperations>;
  readonly localSessionId: string;
  readonly session: 偽ReliableSession;
} {
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const handle = core.createInstance(diagnosticPlugin);
  const started = fake.開始Reliable(sessionId);
  core.assign(started.info.localSessionId, handle.instanceId, DIAGNOSTIC_PORT_ID);
  return { core, handle, localSessionId: started.info.localSessionId, session: started.session };
}

test("echo要求に応答形状どおり返す", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId, session } = 診断割当て(fake, "diag");
  void handle;
  void localSessionId;

  fake.受信(localSessionId, {
    op: "echo",
    id: "応答形状-1",
    value: { data: "あ" },
  });
  expect(session.sent).toEqual([{ op: "echo", id: "応答形状-1", value: { data: "あ" } }]);
});

test("ping要求にpongで応答する", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId, session } = 診断割当て(fake, "diag");
  void handle;

  fake.受信(localSessionId, { op: "ping", id: "応答形状-1" });
  expect(session.sent).toEqual([{ op: "pong", id: "応答形状-1" }]);
});

test("不正形状では応答せずそのセッションを中断する", () => {
  const 不正値: unknown[] = [
    { op: "echo", id: "欠落" },
    { op: "echo", id: "欠落", value: 1, 余分: true },
    { op: "ping" },
    { op: "ping", id: "", 余分: 0 },
    { op: "ping", id: "余分", 余分: 0 },
    { op: "未知", id: "x" },
    null,
    [],
    "文字列",
  ];
  for (const [index, payload] of 不正値.entries()) {
    const fake = new 偽サーバー();
    const { handle, localSessionId, session } = 診断割当て(fake, `diag-${index}`);
    void handle;
    void localSessionId;
    fake.受信(localSessionId, payload);
    // 応答は送らず、当該セッションのみ中断する。
    expect(session.sent).toEqual([]);
    expect(session.aborted).toHaveLength(1);
    expect(session.isAlive).toBe(false);
  }
});

test("応答統計をUI非依存で取得できる", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId } = 診断割当て(fake, "diag");

  fake.受信(localSessionId, { op: "echo", id: "統計-1", value: 1 });
  fake.受信(localSessionId, { op: "echo", id: "統計-2", value: null });
  fake.受信(localSessionId, { op: "ping", id: "統計-3" });
  // 応答を送信試行した件数を数える。改訂番号は応答ごとに1進む。
  expect(handle.getState()).toEqual({ diagnosticEcho: 2, diagnosticPing: 1, revision: 3 });
});

test("改訂番号は応答ごとに進み読み取りでは進まない", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId } = 診断割当て(fake, "diag");

  expect(handle.getState().revision).toBe(0);
  // 読み取りを重ねても進まない。
  expect(handle.getState().revision).toBe(0);
  fake.受信(localSessionId, { op: "ping", id: "改訂-1" });
  expect(handle.getState().revision).toBe(1);
  expect(handle.getState().revision).toBe(1);
  fake.受信(localSessionId, { op: "echo", id: "改訂-2", value: 0 });
  expect(handle.getState()).toEqual({ diagnosticEcho: 1, diagnosticPing: 1, revision: 2 });
});

test("不正形状では改訂番号が進まず購読へ通知しない", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId } = 診断割当て(fake, "diag");

  const operations = handle.getOperations?.();
  if (operations === undefined) throw new Error("診断の操作口が無い。");
  const received: DiagnosticStats[] = [];
  const unsubscribe = operations.onStateChanged((state) => {
    received.push(state);
  });
  try {
    fake.受信(localSessionId, { op: "ping" });
    expect(handle.getState()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0, revision: 0 });
    expect(received).toEqual([]);
  } finally {
    unsubscribe();
  }
});

test("状態購読で最新状態が届き解除後は届かない", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId } = 診断割当て(fake, "diag");

  const operations = handle.getOperations?.();
  if (operations === undefined) throw new Error("診断の操作口が無い。");
  const received: DiagnosticStats[] = [];
  const unsubscribe = operations.onStateChanged((state) => {
    received.push(state);
  });
  fake.受信(localSessionId, { op: "ping", id: "購読-1" });
  expect(received).toEqual([{ diagnosticEcho: 0, diagnosticPing: 1, revision: 1 }]);
  unsubscribe();
  fake.受信(localSessionId, { op: "ping", id: "購読-2" });
  // 解除後の変化は届かないが、本体の状態は進む。
  expect(received).toEqual([{ diagnosticEcho: 0, diagnosticPing: 1, revision: 1 }]);
  expect(handle.getState()).toEqual({ diagnosticEcho: 0, diagnosticPing: 2, revision: 2 });
});

test("購読者の例外は隔離し他の購読を止めない", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId } = 診断割当て(fake, "diag");

  const operations = handle.getOperations?.();
  if (operations === undefined) throw new Error("診断の操作口が無い。");
  const received: DiagnosticStats[] = [];
  const throwing = operations.onStateChanged(() => {
    throw new Error("購読者の失敗");
  });
  const unsubscribe = operations.onStateChanged((state) => {
    received.push(state);
  });
  try {
    fake.受信(localSessionId, { op: "ping", id: "隔離-1" });
    expect(received).toEqual([{ diagnosticEcho: 0, diagnosticPing: 1, revision: 1 }]);
  } finally {
    throwing();
    unsubscribe();
  }
});

test("診断の接続口に合わない操作口ではattachできない", () => {
  const fake = new 偽サーバー();
  const latest = fake.開始Latest("pose");
  const latest操作口 = wrapServerSession(latest.session, latest.info).session;
  const reliable = fake.開始Reliable("diag");
  const reliable操作口 = wrapServerSession(reliable.session, reliable.info).session;

  const instance = diagnosticPlugin.create();
  try {
    // 接続口違いは `RangeError` になる。
    expect(() => instance.attach("存在しない口", reliable操作口)).toThrow(RangeError);
    // 種別違いは `RangeError` になる。
    expect(() => instance.attach(DIAGNOSTIC_PORT_ID, latest操作口)).toThrow(RangeError);
    expect(instance.getState()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0, revision: 0 });
  } finally {
    instance.dispose();
  }
  // 破棄後の割当ては `RangeError` になる。
  expect(() => instance.attach(DIAGNOSTIC_PORT_ID, reliable操作口)).toThrow(RangeError);
});

test("診断ハンドルは状態購読の操作口を持ち初期統計を返す", () => {
  // 診断プラグインの固有操作は状態購読だけであり、送信操作は持たない。
  // 割当て前の初期統計は echo・ping・改訂番号ともに 0 である。
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const handle = core.createInstance(diagnosticPlugin);
  const operations = handle.getOperations?.();
  if (operations === undefined) throw new Error("診断の操作口が無い。");
  expect(typeof operations.onStateChanged).toBe("function");
  expect(handle.getState()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0, revision: 0 });
  // 破棄後の購読は `RangeError` になる。
  core.removeInstance(handle.instanceId);
  expect(() => operations.onStateChanged(() => {})).toThrow(RangeError);
});
