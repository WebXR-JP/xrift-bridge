/**
 * UDP の GUI 登録単位（`./gui`）の単体試験。
 *
 * 管理記述子の選択・endpoint の要求処理（`getState`・`start`・`stop`・
 * 未知 method の不透明なエラー値）・購読の解放・高頻度通知の集約を確かめる。
 * 投げた例外は中継失敗であり、`RangeError` を束縛失効と解釈しないことも
 * 確かめる。子の破棄で本体・Session・ソケットを終了しないことは型と
 * 実装の対応で担保し、ここでは購読解除だけを確かめる。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { udpGuiRegistration } from "../src/gui.ts";
import {
  UDP_MOUNT_KIND,
  UDP_RELAY_EVENT_STATE,
  UDP_VIEW_ENTRY,
  isUdpCompanionSnapshot,
} from "../src/gui-contract.ts";
import { udpPlugin, type UdpPluginOperations, type UdpPluginState } from "../src/plugin.ts";
import type { BoundPluginRef, PluginBindingInfo } from "bridge-gui-plugin-sdk/management";
import type { PluginEmissionPort } from "bridge-gui-plugin-sdk/companion";
import type { PluginRelayEvent } from "bridge-gui-contract/plugin-instance";

/** 束縛情報のひな形を作る。 */
function 束縛(): PluginBindingInfo {
  return {
    kind: UDP_MOUNT_KIND,
    pluginId: "udp",
    instanceId: "instance-1",
    localSessionId: "local-1",
    portId: "udp",
  };
}

/** 本体状態のひな形を作る。 */
function 状態(revision: number): UdpPluginState {
  return {
    revision,
    phase: "stopped",
    requestedBind: null,
    boundAddress: null,
    stats: {
      receivedDatagrams: 0,
      receivedBytes: 0,
      forwardedDatagrams: 0,
      forwardedBytes: 0,
      droppedOversize: 0,
      droppedBusy: 0,
      droppedInvalidMetadata: 0,
      sendFailures: 0,
    },
    lastError: null,
    canStart: true,
    isRunning: false,
  };
}

test("登録単位は管理記述子・companion 宣言・endpoint 工場の三つ組である", () => {
  expect(udpGuiRegistration.management.kind).toBe(UDP_MOUNT_KIND);
  expect(udpGuiRegistration.management.definition).toBe(udpPlugin);
  expect(udpGuiRegistration.management.assignment.maxInstances).toBe(null);
  expect(udpGuiRegistration.companion.kind).toBe(UDP_MOUNT_KIND);
  expect(udpGuiRegistration.companion.label).toBe("UDP");
  expect(udpGuiRegistration.companion.viewEntry).toBe(UDP_VIEW_ENTRY);
  expect(typeof udpGuiRegistration.createEndpoint).toBe("function");
});

test("割当て選択は生存・未割当て・論理名・capability 一致の唯一候補だけを選ぶ", () => {
  const 候補 = (localSessionId: string, sessionId: string) => ({
    localSessionId,
    connectionId: "conn-1",
    sessionId,
    capability: { kind: "reliable", direction: "bidirectional" } as const,
    alive: true,
    assignment: null,
  });
  const 割当て方針 = udpGuiRegistration.management.assignment;
  // 唯一候補は選べる。
  expect(
    割当て方針.select({
      request: { mode: "auto" },
      candidates: [候補("local-1", "udp")],
      bindings: [],
    }),
  ).toEqual({ localSessionId: "local-1", portId: "udp" });
  // 候補ゼロ・複数は理由付きで拒否する。
  expect(() =>
    割当て方針.select({ request: { mode: "auto" }, candidates: [], bindings: [] }),
  ).toThrow(RangeError);
  expect(() =>
    割当て方針.select({
      request: { mode: "auto" },
      candidates: [候補("local-1", "udp"), 候補("local-2", "udp")],
      bindings: [],
    }),
  ).toThrow(RangeError);
  // 論理名違いは対象外である。
  expect(() =>
    割当て方針.select({
      request: { mode: "session", localSessionId: "local-9" },
      candidates: [候補("local-1", "udp")],
      bindings: [],
    }),
  ).toThrow(RangeError);
});

test("getState は本体の状態と束縛の要約を返す", async () => {
  const binding = 束縛();
  const ref = {
    getBinding: () => binding,
    readState: () => 状態(7),
    withOperations: <R>(use: (operations: UdpPluginOperations) => R): R =>
      use({
        start: () => Promise.resolve({ ok: true as const }),
        stop: () => Promise.resolve({ ok: true as const }),
        onStateChanged: () => () => {},
      }),
  } as unknown as BoundPluginRef<UdpPluginState, UdpPluginOperations>;
  const 放出: PluginRelayEvent[] = [];
  const emission: PluginEmissionPort = { emit: (event) => void 放出.push(event) };
  const endpoint = udpGuiRegistration.createEndpoint(ref, emission);
  try {
    const 応答 = await endpoint.handleRequest({ method: "getState", params: {} });
    expect(isUdpCompanionSnapshot(応答)).toBe(true);
    if (!isUdpCompanionSnapshot(応答)) throw new Error("表示用 DTO ではない。");
    expect(応答.revision).toBe(7);
    expect(応答.instanceId).toBe("instance-1");
    expect(応答.localSessionId).toBe("local-1");
  } finally {
    endpoint.dispose();
  }
});

test("start と stop は本体操作へ委譲し未知 method は不透明なエラー値で返す", async () => {
  const binding = 束縛();
  const 開始引数: unknown[] = [];
  let 購読解除回数 = 0;
  const ref = {
    getBinding: () => binding,
    readState: () => 状態(1),
    withOperations: <R>(use: (operations: UdpPluginOperations) => R): R =>
      use({
        start: (params: unknown) => {
          開始引数.push(params);
          return Promise.resolve({ ok: true as const });
        },
        stop: () => Promise.resolve({ ok: true as const }),
        onStateChanged: () => () => {
          購読解除回数 += 1;
        },
      }),
  } as unknown as BoundPluginRef<UdpPluginState, UdpPluginOperations>;
  const emission: PluginEmissionPort = { emit: () => {} };
  const endpoint = udpGuiRegistration.createEndpoint(ref, emission);
  try {
    const 開始 = await endpoint.handleRequest({
      method: "start",
      params: { bind: { address: "127.0.0.1", port: 50001 }, allowNonLoopback: false },
    });
    expect(開始).toEqual({ ok: true });
    expect(開始引数).toHaveLength(1);
    expect(await endpoint.handleRequest({ method: "stop", params: {} })).toEqual({ ok: true });
    // 不正な params は投げず業務エラー値で返す。
    const 不正 = await endpoint.handleRequest({ method: "start", params: null });
    expect(不正).toMatchObject({ ok: false, reason: "invalid-config" });
    // 未知 method は不透明なエラー値であり、反射呼出しはしない。
    const 未知 = await endpoint.handleRequest({ method: "onStateChanged", params: {} });
    expect(未知).toMatchObject({ ok: false, reason: "unknown-method" });
  } finally {
    endpoint.dispose();
    endpoint.dispose();
  }
  expect(購読解除回数).toBe(1);
});

test("高頻度通知は最新値へ集約し解放後は届けない", async () => {
  const binding = 束縛();
  let 最新 = 状態(1);
  let 通知口: ((state: UdpPluginState) => void) | null = null;
  let 購読解除回数 = 0;
  const ref = {
    getBinding: () => binding,
    readState: () => 最新,
    withOperations: <R>(use: (operations: UdpPluginOperations) => R): R =>
      use({
        start: () => Promise.resolve({ ok: true as const }),
        stop: () => Promise.resolve({ ok: true as const }),
        onStateChanged: (handler: (state: UdpPluginState) => void) => {
          通知口 = handler;
          return () => {
            購読解除回数 += 1;
          };
        },
      }),
  } as unknown as BoundPluginRef<UdpPluginState, UdpPluginOperations>;
  const 放出: PluginRelayEvent[] = [];
  const emission: PluginEmissionPort = { emit: (event) => void 放出.push(event) };
  const endpoint = udpGuiRegistration.createEndpoint(ref, emission);
  try {
    if (通知口 === null) throw new Error("購読が無い。");
    const 通知 = 通知口 as (state: UdpPluginState) => void;
    // 同一マイクロタスク内の複数変化は一度の emit に束ねる。
    最新 = 状態(2);
    通知(最新);
    最新 = 状態(3);
    通知(最新);
    await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(放出).toHaveLength(1);
    expect(放出[0]?.event).toBe(UDP_RELAY_EVENT_STATE);
    expect(放出[0]?.payload).toMatchObject({ revision: 3 });
  } finally {
    endpoint.dispose();
  }
  expect(購読解除回数).toBe(1);
});
