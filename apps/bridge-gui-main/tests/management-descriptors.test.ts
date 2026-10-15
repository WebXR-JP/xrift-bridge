/**
 * 管理記述子・companion 宣言・endpoint 工場の単体検証。
 *
 * 生成元・上限・候補選択の宣言だけを確かめ、本番配線（backend）には触らない。
 * 状態の解釈・表示用 DTO の組立ては endpoint 工場が担い、汎用管理層・共有契約は
 * 関与しない。不透明中継の応答は値に載せ、投げた例外は中継失敗に落とす。
 * 反射的呼出しはしない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { diagnosticPlugin } from "bridge-plugin-diagnostic";
import { textPlugin } from "bridge-plugin-text";
import { udpPlugin } from "bridge-plugin-udp";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import {
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
} from "bridge-plugin-diagnostic/contract";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import { textGuiRegistration } from "bridge-plugin-text/gui";
import type { TextPluginOperations, TextPluginState } from "bridge-plugin-text";
import { diagnosticGuiRegistration } from "bridge-plugin-diagnostic/gui";
import { udpGuiRegistration } from "bridge-plugin-udp/gui";
import {
  TEXT_GET_STATE_METHOD,
  TEXT_MOUNT_KIND,
  TEXT_VIEW_ENTRY,
} from "bridge-plugin-text/gui-contract";
import {
  DIAGNOSTIC_MOUNT_KIND,
  DIAGNOSTIC_VIEW_ENTRY,
} from "bridge-plugin-diagnostic/gui-contract";
import { UDP_MOUNT_KIND, UDP_VIEW_ENTRY } from "bridge-plugin-udp/gui-contract";
import type { PluginAssignmentCandidate } from "bridge-gui-plugin-sdk/management";
import type { PluginEmissionPort } from "bridge-gui-plugin-sdk/companion";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import { setupFixture, makeSession } from "./plugin-instance-manager-fakes.ts";

const textManagement = textGuiRegistration.management;
const diagnosticManagement = diagnosticGuiRegistration.management;
const udpManagement = udpGuiRegistration.management;

/** 割当て候補の雛形。検証対象は記述子の選択のみである。 */
function candidateOf(overrides?: Partial<PluginAssignmentCandidate>): PluginAssignmentCandidate {
  return {
    localSessionId: "local-1",
    connectionId: "connection-1",
    sessionId: TEXT_SESSION_ID,
    capability: { kind: "reliable", direction: "bidirectional" },
    alive: true,
    assignment: null,
    ...overrides,
  };
}

/** 捨てる emission port。通知の到達は中継テストで確かめる。 */
function nullEmission(collected?: unknown[]): PluginEmissionPort {
  return {
    emit: (event) => {
      collected?.push(event);
    },
  };
}

test("テキスト記述子は生成元と上限を持つ", () => {
  expect(textManagement.kind).toBe("text");
  expect(textManagement.definition).toBe(textPlugin);
  expect(textManagement.assignment.maxInstances).toBe(1);
});

test("テキスト選択は全接続通じて唯一の候補だけを通す", () => {
  const only = [candidateOf()];
  expect(
    textManagement.assignment.select({ request: { mode: "auto" }, candidates: only, bindings: [] }),
  ).toEqual({ localSessionId: "local-1", portId: "text" });
  // 候補ゼロ・複数は拒否する。
  expect(() =>
    textManagement.assignment.select({ request: { mode: "auto" }, candidates: [], bindings: [] }),
  ).toThrowError(RangeError);
  expect(() =>
    textManagement.assignment.select({
      request: { mode: "auto" },
      candidates: [candidateOf(), candidateOf({ localSessionId: "local-2" })],
      bindings: [],
    }),
  ).toThrowError(RangeError);
});

test("テキスト選択は指定方式でも唯一条件を緩めない", () => {
  const only = [candidateOf()];
  expect(
    textManagement.assignment.select({
      request: { mode: "session", localSessionId: "local-1" },
      candidates: only,
      bindings: [],
    }),
  ).toEqual({ localSessionId: "local-1", portId: "text" });
  // 指定と唯一候補の不一致は拒否する。
  expect(() =>
    textManagement.assignment.select({
      request: { mode: "session", localSessionId: "別" },
      candidates: only,
      bindings: [],
    }),
  ).toThrowError(RangeError);
  // 複数候補では指定があっても選ばない。
  expect(() =>
    textManagement.assignment.select({
      request: { mode: "session", localSessionId: "local-1" },
      candidates: [candidateOf(), candidateOf({ localSessionId: "local-2" })],
      bindings: [],
    }),
  ).toThrowError(RangeError);
});

test("テキスト選択は生存・未割当て・論理名・適合だけを候補にする", () => {
  const cases: Array<Partial<PluginAssignmentCandidate>> = [
    { alive: false },
    { assignment: { localSessionId: "local-1", instanceId: "i9", portId: "text" } },
    { sessionId: "other" },
    { capability: { kind: "latest", direction: "to_server" } },
  ];
  for (const patch of cases) {
    expect(() =>
      textManagement.assignment.select({
        request: { mode: "auto" },
        candidates: [candidateOf(patch)],
        bindings: [],
      }),
    ).toThrowError(RangeError);
  }
});

test("テキスト companion 宣言は種別・表示名・相対 entry だけを持つ", () => {
  expect(textGuiRegistration.companion.kind).toBe(TEXT_MOUNT_KIND);
  expect(textGuiRegistration.companion.viewEntry).toBe(TEXT_VIEW_ENTRY);
  expect(textGuiRegistration.companion.label.length).toBeGreaterThan(0);
  // 解決済み view パス・子画面 URL の組立ては持たない。
  const surface = textGuiRegistration.companion as unknown as Record<string, unknown>;
  expect(surface["viewPath"]).toBeUndefined();
});

test("テキスト endpoint は初期取得要求に表示用 DTO で応答する", async () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a", TEXT_SESSION_ID)]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(textManagement);
  const binding = manager.assign("text");
  const ref = manager.createBoundRef<TextPluginState, TextPluginOperations>(
    textManagement.kind,
    binding.instanceId,
  );
  const endpoint = textGuiRegistration.createEndpoint(ref, nullEmission());
  try {
    const value = (await endpoint.handleRequest({
      method: TEXT_GET_STATE_METHOD,
      params: {},
    })) as Record<string, unknown>;
    // 表示用 DTO は束縛情報と送信状態を写すだけであり、本文は載せない。
    expect(value["instanceId"]).toBe(binding.instanceId);
    expect(value["localSessionId"]).toBe("local-1");
    expect(JSON.stringify(value)).not.toContain("ダミー本文");
  } finally {
    endpoint.dispose();
  }
});

test("テキスト endpoint は未知要求を値に載せ反射呼出ししない", async () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a", TEXT_SESSION_ID)]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(textManagement);
  const binding = manager.assign("text");
  const ref = manager.createBoundRef<TextPluginState, TextPluginOperations>(
    textManagement.kind,
    binding.instanceId,
  );
  const endpoint = textGuiRegistration.createEndpoint(ref, nullEmission());
  try {
    const value = (await endpoint.handleRequest({
      method: "無い要求",
      params: {},
    })) as Record<string, unknown>;
    expect(value["error"]).toContain("未知の要求である");
    const surface = endpoint as unknown as Record<string, unknown>;
    expect(surface["operations"]).toBeUndefined();
  } finally {
    endpoint.dispose();
  }
});

test("診断記述子は生成元と上限なしを持つ", () => {
  expect(diagnosticManagement.kind).toBe("diagnostic");
  expect(diagnosticManagement.definition).toBe(diagnosticPlugin);
  expect(diagnosticManagement.assignment.maxInstances).toBeNull();
  expect(diagnosticGuiRegistration.companion.kind).toBe(DIAGNOSTIC_MOUNT_KIND);
  expect(diagnosticGuiRegistration.companion.viewEntry).toBe(DIAGNOSTIC_VIEW_ENTRY);
});

test("診断選択は指定方式で適格候補から指定個体を選ぶ", () => {
  const candidates = [
    candidateOf({ localSessionId: "local-1", sessionId: DIAGNOSTIC_ECHO_SESSION_ID }),
    candidateOf({ localSessionId: "local-2", sessionId: DIAGNOSTIC_PING_SESSION_ID }),
  ];
  expect(
    diagnosticManagement.assignment.select({
      request: { mode: "session", localSessionId: "local-2" },
      candidates,
      bindings: [],
    }),
  ).toEqual({ localSessionId: "local-2", portId: "diagnostic" });
  // 指定外・テキスト表示用・割当て済みは選ばない。
  expect(() =>
    diagnosticManagement.assignment.select({
      request: { mode: "session", localSessionId: "無い" },
      candidates,
      bindings: [],
    }),
  ).toThrowError(RangeError);
  expect(() =>
    diagnosticManagement.assignment.select({
      request: { mode: "session", localSessionId: "local-1" },
      candidates: [candidateOf({ sessionId: TEXT_SESSION_ID })],
      bindings: [],
    }),
  ).toThrowError(RangeError);
});

test("診断選択はallowlist外（text・udp・その他）を候補にしない", () => {
  // allowlist（diag-echo／diag-ping）のみを対象とし、text・udp・任意名を
  // 診断の候補にしない。指定・自動のいずれでも通さない。
  for (const sessionId of [TEXT_SESSION_ID, UDP_SESSION_ID, "work-1"]) {
    const candidates = [candidateOf({ localSessionId: "local-1", sessionId })];
    expect(() =>
      diagnosticManagement.assignment.select({
        request: { mode: "session", localSessionId: "local-1" },
        candidates,
        bindings: [],
      }),
    ).toThrowError(RangeError);
    expect(() =>
      diagnosticManagement.assignment.select({
        request: { mode: "auto" },
        candidates,
        bindings: [],
      }),
    ).toThrowError(RangeError);
  }
});

test("診断選択の自動方式は唯一候補のみで先頭選択しない", () => {
  expect(
    diagnosticManagement.assignment.select({
      request: { mode: "auto" },
      candidates: [
        candidateOf({ localSessionId: "local-1", sessionId: DIAGNOSTIC_ECHO_SESSION_ID }),
      ],
      bindings: [],
    }),
  ).toEqual({ localSessionId: "local-1", portId: "diagnostic" });
  expect(() =>
    diagnosticManagement.assignment.select({
      request: { mode: "auto" },
      candidates: [],
      bindings: [],
    }),
  ).toThrowError(RangeError);
  // 複数候補では一件目を選ばず拒否する（一括割当てしない）。
  expect(() =>
    diagnosticManagement.assignment.select({
      request: { mode: "auto" },
      candidates: [
        candidateOf({ localSessionId: "local-1", sessionId: DIAGNOSTIC_ECHO_SESSION_ID }),
        candidateOf({ localSessionId: "local-2", sessionId: DIAGNOSTIC_PING_SESSION_ID }),
      ],
      bindings: [],
    }),
  ).toThrowError(RangeError);
});

test("UDP記述子は生成元と companion 宣言を持つ", () => {
  expect(udpManagement.definition).toBe(udpPlugin);
  expect(udpGuiRegistration.companion.kind).toBe(UDP_MOUNT_KIND);
  expect(udpGuiRegistration.companion.viewEntry).toBe(UDP_VIEW_ENTRY);
});

test("登録単位は管理記述子・companion 宣言・endpoint 工場の三つの組である", () => {
  for (const registration of [textGuiRegistration, diagnosticGuiRegistration, udpGuiRegistration]) {
    expect(registration.management.kind).toBe(registration.companion.kind);
    expect(typeof registration.createEndpoint).toBe("function");
    // 旧 export（固有操作の汎用表・監視方式・射影）は持たない。
    const management = registration.management as unknown as Record<string, unknown>;
    expect(management["observation"]).toBeUndefined();
    expect(management["projectView"]).toBeUndefined();
    expect(management["buildOperations"]).toBeUndefined();
  }
});
