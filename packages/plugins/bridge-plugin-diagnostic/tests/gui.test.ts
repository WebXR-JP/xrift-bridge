/**
 * 診断の GUI 登録単位の試験。
 *
 * 新中継契約（`diagnosticGuiRegistration`）の形状、割当て選択、
 * endpoint の要求処理・状態購読・解放を確かめる。ホストの汎用管理層・
 * transport は使わず、束縛個体限定の参照口と emission port の偽物で閉じる。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import type {
  BoundPluginRef,
  PluginAssignmentCandidate,
  PluginBindingInfo,
} from "bridge-gui-plugin-sdk/management";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { PluginRelayEvent } from "bridge-gui-contract/plugin-instance";
import {
  DIAGNOSTIC_PORT_ID,
  type DiagnosticOperations,
  type DiagnosticStats,
} from "../src/index.ts";
import { diagnosticGuiRegistration } from "../src/gui.ts";
import {
  DIAGNOSTIC_MOUNT_KIND,
  DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED,
  DIAGNOSTIC_RELAY_METHOD_GET_STATE,
  DIAGNOSTIC_VIEW_ENTRY,
  isDiagnosticInstanceView,
  isDiagnosticRelayError,
} from "../src/gui-contract.ts";

/** 束縛個体限定の参照口の偽物。本体の状態購読だけを模す。 */
class 偽参照 implements BoundPluginRef<DiagnosticStats, DiagnosticOperations> {
  private readonly binding: PluginBindingInfo = {
    kind: DIAGNOSTIC_MOUNT_KIND,
    pluginId: "diagnostic",
    instanceId: "instance-1",
    localSessionId: "local-1",
    portId: DIAGNOSTIC_PORT_ID,
  };
  private state: DiagnosticStats = { diagnosticEcho: 1, diagnosticPing: 2, revision: 3 };
  private readonly listeners = new Set<(state: DiagnosticStats) => void>();
  private 失効中 = false;

  /** ホスト自身の照合の代わりに失効印を持つ。 */
  失効させる(): void {
    this.失効中 = true;
  }

  getBinding(): PluginBindingInfo {
    if (this.失効中) throw new RangeError("失効済みである。");
    return this.binding;
  }

  readState(): DiagnosticStats {
    if (this.失効中) throw new RangeError("失効済みである。");
    return this.state;
  }

  withOperations<R>(use: (operations: DiagnosticOperations, binding: PluginBindingInfo) => R): R {
    if (this.失効中) throw new RangeError("失効済みである。");
    const operations: DiagnosticOperations = {
      onStateChanged: (handler) => {
        this.listeners.add(handler);
        return () => {
          this.listeners.delete(handler);
        };
      },
    };
    return use(operations, this.binding);
  }

  /**
   * 本体の状態変化を模す。
   *
   * @param next - 変化後の状態。
   */
  状態変化(next: DiagnosticStats): void {
    this.state = next;
    for (const listener of Array.from(this.listeners)) {
      listener(next);
    }
  }

  /** 現在の購読数。解放の確認に使う。 */
  get 購読数(): number {
    return this.listeners.size;
  }
}

/** emission port の偽物。送られた通知を記録する。 */
class 偽Emission implements PluginEmissionPort {
  readonly 通知: PluginRelayEvent[] = [];

  emit(event: PluginRelayEvent): void {
    this.通知.push(event);
  }
}

/** endpoint を組み立てる。 */
function 組立て(
  ref?: 偽参照,
  emission?: 偽Emission,
): {
  readonly ref: 偽参照;
  readonly emission: 偽Emission;
  readonly endpoint: PluginEndpoint;
} {
  const actualRef = ref ?? new 偽参照();
  const actualEmission = emission ?? new 偽Emission();
  const endpoint = diagnosticGuiRegistration.createEndpoint(actualRef, actualEmission);
  return { ref: actualRef, emission: actualEmission, endpoint };
}

/**
 * 割当て候補を作る。
 *
 * @param sessionId - 論理名。
 * @param localSessionId - ローカル識別子。
 * @param overrides - 生存・割当ての上書き。
 * @returns 候補。
 */
function 候補(
  sessionId: string,
  localSessionId: string,
  overrides?: { readonly alive?: boolean; readonly assigned?: boolean },
): PluginAssignmentCandidate {
  return {
    localSessionId,
    connectionId: "conn-1",
    sessionId,
    capability: { kind: "reliable", direction: "bidirectional" },
    alive: overrides?.alive ?? true,
    assignment:
      overrides?.assigned === true
        ? { localSessionId, instanceId: "instance-他", portId: DIAGNOSTIC_PORT_ID }
        : null,
  };
}

test("登録単位の形状は管理記述子とcompanion宣言とendpoint工場の組である", () => {
  expect(diagnosticGuiRegistration.management.kind).toBe(DIAGNOSTIC_MOUNT_KIND);
  expect(diagnosticGuiRegistration.management.definition.pluginId).toBe("diagnostic");
  expect(diagnosticGuiRegistration.management.assignment.maxInstances).toBe(null);
  expect(diagnosticGuiRegistration.companion).toEqual({
    kind: DIAGNOSTIC_MOUNT_KIND,
    label: "診断",
    viewEntry: DIAGNOSTIC_VIEW_ENTRY,
  });
  expect(typeof diagnosticGuiRegistration.createEndpoint).toBe("function");
});

test("割当て選択は診断の論理名だけを対象にする", () => {
  const assignment = diagnosticGuiRegistration.management.assignment;
  // 診断外の論理名は候補にならず、auto では対象外になる。
  expect(() =>
    assignment.select({
      request: { mode: "auto" },
      candidates: [候補("text", "local-1")],
      bindings: [],
    }),
  ).toThrow(RangeError);
  // allowlist の両名は対象になる（ただし auto は唯一候補のみ）。
  const echo = assignment.select({
    request: { mode: "session", localSessionId: "local-echo" },
    candidates: [候補("diag-echo", "local-echo"), 候補("diag-ping", "local-ping")],
    bindings: [],
  });
  expect(echo).toEqual({ localSessionId: "local-echo", portId: DIAGNOSTIC_PORT_ID });
});

test("割当て選択はautoで唯一候補のみ受け付ける", () => {
  const assignment = diagnosticGuiRegistration.management.assignment;
  expect(() =>
    assignment.select({ request: { mode: "auto" }, candidates: [], bindings: [] }),
  ).toThrow(RangeError);
  expect(() =>
    assignment.select({
      request: { mode: "auto" },
      candidates: [候補("diag-echo", "local-1"), 候補("diag-ping", "local-2")],
      bindings: [],
    }),
  ).toThrow(RangeError);
  const single = assignment.select({
    request: { mode: "auto" },
    candidates: [候補("diag-ping", "local-9")],
    bindings: [],
  });
  expect(single).toEqual({ localSessionId: "local-9", portId: DIAGNOSTIC_PORT_ID });
});

test("割当て選択は割当て済みと終了済みを除く", () => {
  const assignment = diagnosticGuiRegistration.management.assignment;
  expect(() =>
    assignment.select({
      request: { mode: "auto" },
      candidates: [候補("diag-echo", "local-1", { assigned: true })],
      bindings: [],
    }),
  ).toThrow(RangeError);
  expect(() =>
    assignment.select({
      request: { mode: "auto" },
      candidates: [候補("diag-echo", "local-1", { alive: false })],
      bindings: [],
    }),
  ).toThrow(RangeError);
});

test("初期取得の要求に束縛個体の表示を返す", async () => {
  const { endpoint } = 組立て();
  try {
    const value = await endpoint.handleRequest({
      method: DIAGNOSTIC_RELAY_METHOD_GET_STATE,
      params: {},
    });
    expect(isDiagnosticInstanceView(value)).toBe(true);
    if (!isDiagnosticInstanceView(value)) throw new Error("表示の形状ではない。");
    expect(value.instanceId).toBe("instance-1");
    expect(value.localSessionId).toBe("local-1");
    expect(value.portId).toBe(DIAGNOSTIC_PORT_ID);
    expect(value.stats).toEqual({ diagnosticEcho: 1, diagnosticPing: 2 });
    expect(value.revision).toBe(3);
  } finally {
    endpoint.dispose();
  }
});

test("未知の要求は投げず不透明なエラー値を返す", async () => {
  const { endpoint } = 組立て();
  try {
    // 反射呼出しをしないこと。未知名でも例外にならない。
    const value = await endpoint.handleRequest({ method: "存在しない要求", params: {} });
    expect(isDiagnosticRelayError(value)).toBe(true);
    if (!isDiagnosticRelayError(value)) throw new Error("エラー値の形状ではない。");
    expect(value.code).toBe("unknown-method");
  } finally {
    endpoint.dispose();
  }
});

test("不正な引数は不透明なエラー値を返す", async () => {
  const { endpoint } = 組立て();
  try {
    for (const params of [{ 余分: 1 }, null, [], "文字列"]) {
      const value = await endpoint.handleRequest({
        method: DIAGNOSTIC_RELAY_METHOD_GET_STATE,
        params,
      });
      expect(isDiagnosticRelayError(value)).toBe(true);
      if (!isDiagnosticRelayError(value)) throw new Error("エラー値の形状ではない。");
      expect(value.code).toBe("bad-params");
    }
  } finally {
    endpoint.dispose();
  }
});

test("本体の状態変化で表示用DTOを送る", () => {
  const { ref, emission, endpoint } = 組立て();
  try {
    expect(emission.通知).toEqual([]);
    ref.状態変化({ diagnosticEcho: 1, diagnosticPing: 3, revision: 4 });
    expect(emission.通知).toHaveLength(1);
    const event = emission.通知[0];
    if (event === undefined) throw new Error("通知が無い。");
    expect(event.event).toBe(DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED);
    expect(isDiagnosticInstanceView(event.payload)).toBe(true);
    if (!isDiagnosticInstanceView(event.payload)) throw new Error("表示の形状ではない。");
    expect(event.payload.stats).toEqual({ diagnosticEcho: 1, diagnosticPing: 3 });
    expect(event.payload.revision).toBe(4);
  } finally {
    endpoint.dispose();
  }
});

test("解放で購読を外し二重解放しない", () => {
  const { ref, emission, endpoint } = 組立て();
  expect(ref.購読数).toBe(1);
  endpoint.dispose();
  expect(ref.購読数).toBe(0);
  // 二重解放は例外にならない。
  endpoint.dispose();
  ref.状態変化({ diagnosticEcho: 9, diagnosticPing: 9, revision: 9 });
  expect(emission.通知).toEqual([]);
});

test("失効後の通知は送らない", () => {
  const { ref, emission, endpoint } = 組立て();
  try {
    ref.失効させる();
    // 失効印の後の本体通知は表示にしない。例外にもしない。
    ref.状態変化({ diagnosticEcho: 9, diagnosticPing: 9, revision: 9 });
    expect(emission.通知).toEqual([]);
  } finally {
    endpoint.dispose();
  }
});
