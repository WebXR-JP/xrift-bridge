/**
 * プラグイン基盤の単体試験。
 *
 * 偽サーバー管理境界と偽 Session で、適合判定・一対一・失効・中断・
 * 未割当て中断・終了時失効を確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createBridgeAppCore, type BridgeAppCore } from "../src/app-core.ts";
import { wrapServerSession, type AssignedSession } from "../src/assigned-session.ts";
import type {
  PluginDefinition,
  PluginInstance,
  PluginInstanceHandle,
  PluginPort,
} from "../src/plugin.ts";
import { 偽サーバー } from "./fakes.ts";

const cores: BridgeAppCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close();
  }
});

/** 試験用の記録プラグイン定義を作る。 */
function 記録定義(options?: {
  readonly ports?: readonly PluginPort[];
  readonly attachThrows?: Error;
}): {
  readonly definition: PluginDefinition<unknown>;
  readonly attached: { readonly portId: string; readonly session: AssignedSession }[];
  readonly disposed: { readonly count: number };
} {
  const attached: { readonly portId: string; readonly session: AssignedSession }[] = [];
  const disposed = { count: 0 };
  const definition: PluginDefinition<unknown> = {
    pluginId: "記録",
    ports: options?.ports ?? [
      { portId: "主", accepts: [{ kind: "reliable", direction: "bidirectional" }] },
    ],
    create(): PluginInstance<unknown> {
      return {
        attach(portId: string, session: AssignedSession): void {
          attached.push({ portId, session });
          if (options?.attachThrows !== undefined) throw options.attachThrows;
        },
        getState(): unknown {
          return { attached: attached.length };
        },
        dispose(): void {
          disposed.count += 1;
        },
      };
    },
  };
  return { definition, attached, disposed };
}

function 割当て操作口(
  attached: readonly { readonly portId: string; readonly session: AssignedSession }[],
  index: number,
): AssignedSession {
  const record = attached[index];
  if (record === undefined) throw new Error("割当て記録がない。");
  return record.session;
}

/** 割当て記録から reliable 操作口を取り出す。 */
function 信頼できる操作口(
  attached: readonly { readonly portId: string; readonly session: AssignedSession }[],
  index: number,
): Extract<AssignedSession, { kind: "reliable" }> {
  const session = 割当て操作口(attached, index);
  if (session.kind !== "reliable") throw new Error("reliable 操作口ではない。");
  return session;
}

test("接続口に合わない・不明な割当てはできず生セッションは残る", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition } = 記録定義();
  const handle = core.createInstance(definition);
  const latest = fake.開始Latest("pose");
  const reliable = fake.開始Reliable("diag");

  // 種別の不一致は `RangeError` になる。
  expect(() => core.assign(latest.info.localSessionId, handle.instanceId, "主")).toThrow(
    RangeError,
  );
  // 不明な識別子は `RangeError` になる。
  expect(() => core.assign(reliable.info.localSessionId, "instance-存在しない", "主")).toThrow(
    RangeError,
  );
  expect(() =>
    core.assign(reliable.info.localSessionId, handle.instanceId, "存在しない口"),
  ).toThrow(RangeError);
  expect(() => core.assign("local-存在しない", handle.instanceId, "主")).toThrow(RangeError);
  // 終了したセッションは割当てできない。
  fake.終了(reliable.info.localSessionId);
  expect(() => core.assign(reliable.info.localSessionId, handle.instanceId, "主")).toThrow(
    RangeError,
  );

  expect(core.listAssignments()).toEqual([]);
  // 判定失敗では生セッションを中断しない。
  expect(latest.session.isAlive).toBe(true);
});

test("同一セッションと同一接続口への二重割当てはできない", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const first = 記録定義();
  const second = 記録定義();
  const firstHandle = core.createInstance(first.definition);
  const secondHandle = core.createInstance(second.definition);
  const one = fake.開始Reliable("一つ目");
  const two = fake.開始Reliable("二つ目");

  core.assign(one.info.localSessionId, firstHandle.instanceId, "主");
  // 同一セッションへの二重割当ては `RangeError` になる。
  expect(() => core.assign(one.info.localSessionId, secondHandle.instanceId, "主")).toThrow(
    RangeError,
  );
  // 同一接続口への二重割当ては `RangeError` になる。
  expect(() => core.assign(two.info.localSessionId, firstHandle.instanceId, "主")).toThrow(
    RangeError,
  );
  expect(core.listAssignments()).toEqual([
    { localSessionId: one.info.localSessionId, instanceId: firstHandle.instanceId, portId: "主" },
  ]);
  // 二つ目のインスタンスの接続口は空いている。
  core.assign(two.info.localSessionId, secondHandle.instanceId, "主");
  expect(core.listAssignments()).toHaveLength(2);
});

test("解除後は操作口の送信と購読登録が拒否され生セッションは中断する", async () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition, attached } = 記録定義();
  const handle = core.createInstance(definition);
  const started = fake.開始Reliable("diag");
  core.assign(started.info.localSessionId, handle.instanceId, "主");
  const 操作口 = 信頼できる操作口(attached, 0);

  const 届いた: unknown[] = [];
  操作口.onMessage((payload) => {
    届いた.push(payload);
  });
  fake.受信(started.info.localSessionId, { 挨拶: "割当て中" });
  expect(届いた).toEqual([{ 挨拶: "割当て中" }]);

  core.unassign(started.info.localSessionId);
  // 解除は対象セッションを中断する。
  expect(started.session.aborted).toHaveLength(1);
  expect(core.listAssignments()).toEqual([]);
  // 不明な割当ての解除は `RangeError` になる。
  expect(() => core.unassign(started.info.localSessionId)).toThrow(RangeError);

  // 失効後の送信は拒否される。
  await expect(操作口.sendReliable({ 挨拶: "解除後" })).rejects.toThrow(RangeError);
  await expect(操作口.closeWrite()).rejects.toThrow(RangeError);
  // 失効後の購読登録は例外になる。
  expect(() => 操作口.onMessage(() => {})).toThrow(RangeError);
  expect(() => 操作口.onEnd(() => {})).toThrow(RangeError);
  expect(() => 操作口.onRemoteEnd(() => {})).toThrow(RangeError);
  // 失効後の配送スナップショットからは購読者を呼ばない。
  started.session.notifyEnd({ kind: "closed" });
  fake.受信(started.info.localSessionId, { 挨拶: "解除後" });
  expect(届いた).toEqual([{ 挨拶: "割当て中" }]);
  expect(操作口.isAlive).toBe(false);
});

test("インスタンス削除で割当てが外れ対象セッションが中断する", async () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition, attached, disposed } = 記録定義({
    ports: [
      { portId: "一つ目", accepts: [{ kind: "reliable", direction: "bidirectional" }] },
      { portId: "二つ目", accepts: [{ kind: "reliable", direction: "bidirectional" }] },
    ],
  });
  const handle = core.createInstance(definition);
  const one = fake.開始Reliable("一つ目");
  const two = fake.開始Reliable("二つ目");
  core.assign(one.info.localSessionId, handle.instanceId, "一つ目");
  core.assign(two.info.localSessionId, handle.instanceId, "二つ目");
  expect(core.listAssignments()).toHaveLength(2);

  core.removeInstance(handle.instanceId);
  expect(core.listAssignments()).toEqual([]);
  expect(one.session.aborted).toHaveLength(1);
  expect(two.session.aborted).toHaveLength(1);
  expect(disposed.count).toBe(1);
  // 削除済みの操作口は拒否される。
  const 一つ目 = 信頼できる操作口(attached, 0);
  await expect(一つ目.sendReliable({})).rejects.toThrow(RangeError);
  // 二重削除は `RangeError` になる。
  expect(() => core.removeInstance(handle.instanceId)).toThrow(RangeError);
});

test("未割当てのreliableに届いたデータはそのセッションを中断する", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition } = 記録定義();
  const handle: PluginInstanceHandle<unknown> = core.createInstance(definition);

  // 未割当てのままデータが届くと理由付きで中断する。
  const 未割当て = fake.開始Reliable("未割当て");
  expect(core.listAssignments()).toEqual([]);
  fake.受信(未割当て.info.localSessionId, { op: "echo", id: "1", value: 1 });
  expect(未割当て.session.aborted).toHaveLength(1);
  expect(未割当て.session.isAlive).toBe(false);

  // 割当て済みなら中断しない。
  const 割当て済み = fake.開始Reliable("割当て済み");
  core.assign(割当て済み.info.localSessionId, handle.instanceId, "主");
  fake.受信(割当て済み.info.localSessionId, { op: "echo", id: "2", value: 2 });
  expect(割当て済み.session.aborted).toHaveLength(0);
  expect(割当て済み.session.isAlive).toBe(true);

  // latest の受信は基盤では中断しない（記録はサーバー側の既存機能）。
  const 最新 = fake.開始Latest("pose");
  fake.受信(最新.info.localSessionId, { x: 1 });
  expect(最新.session.aborted).toHaveLength(0);
  expect(最新.session.isAlive).toBe(true);
});

test("セッション終了で割当てと操作口が失効しインスタンスは残る", async () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition, attached } = 記録定義();
  const handle = core.createInstance(definition);
  const started = fake.開始Reliable("diag");
  core.assign(started.info.localSessionId, handle.instanceId, "主");
  const 操作口 = 信頼できる操作口(attached, 0);

  fake.終了(started.info.localSessionId, { kind: "closed" });
  expect(core.listAssignments()).toEqual([]);
  await expect(操作口.sendReliable({})).rejects.toThrow(RangeError);
  expect(() => 操作口.onMessage(() => {})).toThrow(RangeError);

  // インスタンス自体は自動削除しないため、次のセッションを割り当てられる。
  const 次 = fake.開始Reliable("diag");
  expect(次.info.localSessionId).not.toBe(started.info.localSessionId);
  core.assign(次.info.localSessionId, handle.instanceId, "主");
  expect(core.listAssignments()).toEqual([
    { localSessionId: 次.info.localSessionId, instanceId: handle.instanceId, portId: "主" },
  ]);
});

test("attach失敗時は失効・解除・中断する", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const 失敗 = new Error("プラグインの割当て失敗");
  const { definition, attached } = 記録定義({ attachThrows: 失敗 });
  const handle = core.createInstance(definition);
  const started = fake.開始Reliable("diag");

  expect(() => core.assign(started.info.localSessionId, handle.instanceId, "主")).toThrow(失敗);
  expect(core.listAssignments()).toEqual([]);
  expect(started.session.aborted).toHaveLength(1);
  // 渡しかけた操作口も失効している。
  const 操作口 = 信頼できる操作口(attached, 0);
  expect(() => 操作口.onMessage(() => {})).toThrow(RangeError);
});

test("基盤終了で全割当てが失効し以後は使えない", async () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition, attached, disposed } = 記録定義();
  const handle = core.createInstance(definition);
  const started = fake.開始Reliable("diag");
  core.assign(started.info.localSessionId, handle.instanceId, "主");

  core.close();
  expect(core.listAssignments()).toEqual([]);
  expect(started.session.aborted).toHaveLength(1);
  expect(disposed.count).toBe(1);
  const 操作口 = 信頼できる操作口(attached, 0);
  await expect(操作口.sendReliable({})).rejects.toThrow(RangeError);
  // 終了後の生成・割当て・解除・削除は `RangeError` になる。
  expect(() => core.createInstance(definition)).toThrow(RangeError);
  expect(() => core.assign(started.info.localSessionId, handle.instanceId, "主")).toThrow(
    RangeError,
  );
  expect(() => core.unassign(started.info.localSessionId)).toThrow(RangeError);
  expect(() => core.removeInstance(handle.instanceId)).toThrow(RangeError);
  // 終了は冪等である。
  core.close();
});

test("latestセッションも適合すれば割当てできる", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const { definition, attached } = 記録定義({
    ports: [{ portId: "受信", accepts: [{ kind: "latest", direction: "to_server" }] }],
  });
  const handle = core.createInstance(definition);
  const started = fake.開始Latest("pose");
  core.assign(started.info.localSessionId, handle.instanceId, "受信");
  expect(core.listAssignments()).toEqual([
    { localSessionId: started.info.localSessionId, instanceId: handle.instanceId, portId: "受信" },
  ]);
  // latest 受信の操作口に送信口は存在しない（型と実行時の両方で制限）。
  const 操作口 = 割当て操作口(attached, 0);
  if (操作口.kind === "latest" && 操作口.direction === "to_server") {
    expect("sendReliable" in 操作口).toBe(false);
    expect("sendLatest" in 操作口).toBe(false);
    expect(typeof 操作口.onMessage).toBe("function");
  } else {
    throw new Error("latest 受信の操作口ではない。");
  }
  core.unassign(started.info.localSessionId);
  expect(started.session.aborted).toHaveLength(1);
});

test("操作口の失効後は配送スナップショットから購読者を呼ばない", async () => {
  const fake = new 偽サーバー();
  const started = fake.開始Reliable("diag");
  const { session, revoke } = wrapServerSession(started.session, started.info);
  if (session.kind !== "reliable") throw new Error("reliable 操作口ではない。");

  const 届いた: unknown[] = [];
  session.onMessage((payload) => {
    届いた.push(payload);
  });
  started.session.emitMessage({ 挨拶: "失効前" });
  expect(届いた).toEqual([{ 挨拶: "失効前" }]);

  // 生セッションが生存中でも、失効後の配送は購読者へ届けない。
  revoke();
  started.session.emitMessage({ 挨拶: "失効後" });
  expect(届いた).toEqual([{ 挨拶: "失効前" }]);
  expect(started.session.isAlive).toBe(true);
  // 失効は冪等であり、送信と購読登録は拒否される。
  revoke();
  await expect(session.sendReliable({})).rejects.toThrow(RangeError);
  expect(() => session.onMessage(() => {})).toThrow(RangeError);
});
