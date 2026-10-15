/**
 * 管理記述子（text/diagnostic）の単体検証。
 *
 * 生成元・上限・候補選択・監視方式・表示射影・固有操作の宣言だけを確かめ、
 * 本番配線（backend）には触らない。旧射影関数（`projectTextInstanceView` 等）の
 * 試験はここへ移す。厳密な周期値は偽時計で検証し、実時間待ちはしない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { diagnosticPlugin } from "bridge-plugin-diagnostic";
import { textPlugin } from "bridge-plugin-text";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import {
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
} from "bridge-plugin-diagnostic/contract";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import type {
  PluginAssignmentCandidate,
  PluginOperationAccess,
} from "bridge-gui-plugin-sdk/management";
import { textManagement } from "bridge-plugin-text/gui";
import { DEFAULT_DIAGNOSTIC_POLL_MS, diagnosticManagement } from "bridge-plugin-diagnostic/gui";

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

test("テキスト監視は購読し操作口不足は型誤りで示す", () => {
  if (textManagement.observation.mode !== "subscribe") {
    throw new Error("テキスト監視は購読であること。");
  }
  let notified = 0;
  const stop = textManagement.observation.start(
    {
      instanceId: "i1",
      pluginId: "text",
      getState: () => ({
        canSend: true,
        pendingId: null,
        lastResult: null,
        stats: { attempts: 0, acknowledged: 0, unknown: 0 },
      }),
      getOperations: () => ({
        sendText: () => Promise.reject(new Error("未使用")),
        onStateChanged: (handler: () => void) => {
          handler();
          return () => {
            notified += 1;
          };
        },
      }),
    } as never,
    () => {},
  );
  expect(notified).toBe(0);
  stop();
  expect(notified).toBe(1);
  expect(() =>
    textManagement.observation.mode === "subscribe"
      ? textManagement.observation.start(
          {
            instanceId: "i2",
            pluginId: "text",
            getState: () => ({
              canSend: false,
              pendingId: null,
              lastResult: null,
              stats: { attempts: 0, acknowledged: 0, unknown: 0 },
            }),
          } as never,
          () => {},
        )
      : null,
  ).toThrowError(TypeError);
});

test("テキスト射影は識別と送信状態だけを明示列挙する", () => {
  const view = textManagement.projectView({
    binding: {
      kind: "text",
      pluginId: "text",
      instanceId: "instance-1",
      localSessionId: "local-1",
      portId: "text",
    },
    state: {
      canSend: true,
      pendingId: "text-1",
      lastResult: null,
      stats: { attempts: 2, acknowledged: 1, unknown: 1 },
    },
  });
  expect(Object.keys(view).sort()).toEqual([
    "canSend",
    "instanceId",
    "lastResult",
    "localSessionId",
    "pendingId",
    "pluginId",
    "portId",
    "stats",
  ]);
  expect(view.stats).toEqual({ attempts: 2, acknowledged: 1, unknown: 1 });
});

test("テキスト固有操作は限定口経由で現割当てへ委譲する", async () => {
  const sent: Array<{ text: string; localSessionId: string }> = [];
  const access: PluginOperationAccess<{
    sendText(text: string, localSessionId: string): Promise<{ status: "acknowledged"; id: string }>;
  }> = {
    withOperations: (instanceId, use) =>
      use(
        {
          sendText: (text: string, localSessionId: string) => {
            sent.push({ text, localSessionId });
            return Promise.resolve({ status: "acknowledged", id: "text-1" });
          },
        },
        {
          kind: "text",
          pluginId: "text",
          instanceId,
          localSessionId: "local-1",
          portId: "text",
        },
      ),
  };
  // ADR: `as` を使う理由は、記述子の操作型と試験の偽口の到達が同じ
  // テキスト操作口であることを主張するためである。根拠は、偽口が委譲先の
  // `sendText` と同じ引数順を持つことである。
  const operations = textManagement.buildOperations(access as never);
  await expect(operations.sendText("instance-1", "ダミー本文")).resolves.toEqual({
    status: "acknowledged",
    id: "text-1",
  });
  expect(sent).toEqual([{ text: "ダミー本文", localSessionId: "local-1" }]);
  // 本文の文字列検査だけを行い、詳細検証はプラグインに任せる。
  expect(() => operations.sendText("instance-1", 123)).toThrowError(RangeError);
  expect(sent).toHaveLength(1);
});

test("診断記述子は生成元と上限なしを持つ", () => {
  expect(diagnosticManagement.kind).toBe("diagnostic");
  expect(diagnosticManagement.definition).toBe(diagnosticPlugin);
  expect(diagnosticManagement.assignment.maxInstances).toBeNull();
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

test("診断監視は既定周期で統計二項目だけを指紋にする", () => {
  expect(DEFAULT_DIAGNOSTIC_POLL_MS).toBe(500);
  if (diagnosticManagement.observation.mode !== "poll") {
    throw new Error("診断監視は周期照合であること。");
  }
  expect(diagnosticManagement.observation.intervalMs).toBe(DEFAULT_DIAGNOSTIC_POLL_MS);
  const fingerprint = diagnosticManagement.observation.fingerprint;
  expect(fingerprint({ diagnosticEcho: 1, diagnosticPing: 2 })).toBe(
    fingerprint({ diagnosticEcho: 1, diagnosticPing: 2 }),
  );
  expect(fingerprint({ diagnosticEcho: 1, diagnosticPing: 2 })).not.toBe(
    fingerprint({ diagnosticEcho: 2, diagnosticPing: 2 }),
  );
  expect(fingerprint({ diagnosticEcho: 1, diagnosticPing: 2 })).not.toBe(
    fingerprint({ diagnosticEcho: 1, diagnosticPing: 3 }),
  );
});

test("診断射影は識別と統計だけを載せる", () => {
  const view = diagnosticManagement.projectView({
    binding: {
      kind: "diagnostic",
      pluginId: "diagnostic",
      instanceId: "instance-9",
      localSessionId: "local-9",
      portId: "diagnostic",
    },
    state: { diagnosticEcho: 3, diagnosticPing: 5 },
  });
  expect(Object.keys(view).sort()).toEqual([
    "instanceId",
    "localSessionId",
    "pluginId",
    "portId",
    "stats",
  ]);
  expect(view.stats).toEqual({ diagnosticEcho: 3, diagnosticPing: 5 });
  expect(diagnosticManagement.buildOperations).toBeDefined();
});

test("診断の周期監視は偽時計の間隔で駆動する", () => {
  let stats = { diagnosticEcho: 0, diagnosticPing: 0 };
  const assignments: Array<{ localSessionId: string; instanceId: string; portId: string }> = [];
  const intervals: number[] = [];
  const ticks: Array<() => void> = [];
  let changed = 0;
  const manager = new PluginInstanceManager({
    core: {
      createInstance: () => ({
        instanceId: "diagnostic-1",
        pluginId: "diagnostic",
        getState: () => stats,
      }),
      assign: (localSessionId: string, instanceId: string, portId: string) => {
        assignments.push({ localSessionId, instanceId, portId });
      },
      unassign: () => {},
      removeInstance: () => {},
      listAssignments: () => [...assignments],
    } as never,
    sessions: {
      list: () => [
        {
          localSessionId: "local-9",
          connectionId: "connection-9",
          sessionId: DIAGNOSTIC_ECHO_SESSION_ID,
          capability: { kind: "reliable", direction: "bidirectional" },
          alive: true,
        },
      ],
      onEnded: () => () => {},
    },
    clock: {
      every: (intervalMs: number, tick: () => void) => {
        intervals.push(intervalMs);
        ticks.push(tick);
        return () => {};
      },
    },
    onChanged: () => {
      changed += 1;
    },
    onIssue: () => {},
  });
  try {
    manager.register(diagnosticManagement);
    const binding = manager.assign("diagnostic", { mode: "auto" });
    expect(binding.instanceId).toBe("diagnostic-1");
    // 厳密な周期値は記述子の既定であり、実時間待ちなしに確かめる。
    expect(intervals).toEqual([DEFAULT_DIAGNOSTIC_POLL_MS]);
    const tick = ticks[0];
    if (tick === undefined) throw new Error("周期処理が無い。");
    const before = changed;
    tick();
    expect(changed).toBe(before);
    stats = { diagnosticEcho: 1, diagnosticPing: 0 };
    tick();
    expect(changed).toBe(before + 1);
  } finally {
    manager.close();
  }
});
