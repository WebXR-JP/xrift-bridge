import { expect, test } from "vite-plus/test";
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import {
  isLocalExecutableOp,
  isLocalHumanOnlyOp,
  isLocalKnownOp,
  LOCAL_APPROVAL_REQUIRED_MESSAGE,
  LOCAL_EXECUTABLE_OPS,
  LOCAL_HUMAN_ONLY_OPS,
  LOCAL_KNOWN_OPS,
  localHumanApprovalNotice,
  summarizeLocalResult,
  summarizeLocalStatus,
} from "bridge-gui-contract/local-ops";

// 製品向けローカル業務操作の共有契約（分類・射影・定型応答）の固定。
// 秘密（比較コード本文・通信本文・業務 payload・テキスト本文・生 snapshot）は
// 要約に載せず、操作対象の識別子は残す。入力検証は main 側の schema 定義が担う。

const SECRET = "ひみつの本文041003";

/** 表示状態の試験値。識別子・本文を含めて射影で落ちることを見る。 */
function makeSnapshot(): ManagementSnapshot {
  return {
    revision: 7,
    backend: "ready",
    endpoint: { url: `http://127.0.0.1:3100/${SECRET}`, listening: true },
    admission: { accepting: true },
    pending: [{ requestId: "r1" }],
    connections: [
      {
        connectionId: "c1",
        origin: `https://app.xrift.net/${SECRET}`,
        authorized: true,
        phase: "authorized",
      },
    ],
    sessions: [
      {
        localSessionId: "s1",
        connectionId: "c1",
        sessionId: `論理名-${SECRET}`,
        kind: "reliable",
        direction: "bidirectional",
      },
    ],
    plugins: {
      kinds: [{ pluginKind: "text", pluginId: "text", label: "テキスト", maxInstances: null }],
      instances: [
        {
          pluginKind: "text",
          pluginId: "text",
          instanceId: "i1",
          localSessionId: "s1",
          portId: "text",
          phase: "active",
        },
      ],
      assignments: [{ localSessionId: "s1", instanceId: "i1", portId: "text" }],
    },
    pluginMounts: [],
    pluginMountFailures: [],
    pluginNavigationRules: [`views://plugin-text/${SECRET}`],
    pluginView: { instanceId: "i1", viewGeneration: 2 },
  };
}

test("実行する許可操作は設計の操作粒度の7件である", () => {
  expect([...LOCAL_EXECUTABLE_OPS]).toEqual([
    "getSnapshot",
    "enableAcceptance",
    "disableAcceptance",
    "getPairingView",
    "assignPlugin",
    "unassignPlugin",
    "setPluginView",
  ]);
  for (const op of LOCAL_EXECUTABLE_OPS) {
    expect(isLocalExecutableOp(op)).toBe(true);
    expect(isLocalKnownOp(op)).toBe(true);
  }
});

test("承認と拒否は人間限定であり実行する操作には含めない", () => {
  expect([...LOCAL_HUMAN_ONLY_OPS]).toEqual(["approvePairing", "rejectPairing"]);
  for (const op of LOCAL_HUMAN_ONLY_OPS) {
    expect(isLocalHumanOnlyOp(op)).toBe(true);
    expect(isLocalExecutableOp(op)).toBe(false);
    expect(isLocalKnownOp(op)).toBe(true);
  }
});

test("終了・接続切断・再試行・任意名は一覧に含めない", () => {
  expect([...LOCAL_KNOWN_OPS]).toHaveLength(
    LOCAL_EXECUTABLE_OPS.length + LOCAL_HUMAN_ONLY_OPS.length,
  );
  for (const name of [
    "quit",
    "disconnectConnection",
    "retryPluginMount",
    "sendText",
    "eval",
    "",
    undefined,
    null,
  ]) {
    expect(isLocalExecutableOp(name)).toBe(false);
    expect(isLocalHumanOnlyOp(name)).toBe(false);
    expect(isLocalKnownOp(name)).toBe(false);
  }
});

test("承認の要求は人間の GUI 操作を要する定型応答に落とす", () => {
  const notice = localHumanApprovalNotice();
  expect(notice).toEqual({
    requiresHumanOperation: true,
    message: LOCAL_APPROVAL_REQUIRED_MESSAGE,
  });
  expect(LOCAL_APPROVAL_REQUIRED_MESSAGE.length).toBeGreaterThan(0);
  expect(JSON.stringify(notice)).not.toContain(SECRET);
});

test("表示対象の射影は明示項目だけを返し余分な項目は落とす", () => {
  // ADR: `as` は実行時の検証を主張しない。余分な項目を持つ入力であることを
  // 明示し、射影が構造で allowlist であることを確かめるための代役である。
  const polluted = {
    ...makeSnapshot(),
    pluginView: { instanceId: "i1", viewGeneration: 2, comparisonCode: SECRET },
  } as ManagementSnapshot;
  const summary = summarizeLocalStatus(polluted);
  expect(summary.pluginView).toEqual({ instanceId: "i1", viewGeneration: 2 });
  expect(JSON.stringify(summary)).not.toContain(SECRET);
});

test("状態射影は識別子を残し本文・付帯情報を落とす", () => {
  const summary = summarizeLocalStatus(makeSnapshot());
  expect(summary).toEqual({
    revision: 7,
    backend: "ready",
    accepting: true,
    pendingRequestIds: ["r1"],
    connectionIds: ["c1"],
    localSessionIds: ["s1"],
    pluginKinds: [{ pluginKind: "text", pluginId: "text" }],
    ownedInstances: [
      {
        pluginKind: "text",
        pluginId: "text",
        instanceId: "i1",
        localSessionId: "s1",
        portId: "text",
      },
    ],
    pluginView: { instanceId: "i1", viewGeneration: 2 },
  });
  const text = JSON.stringify(summary);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("https://app.xrift.net");
  expect(text).not.toContain("3100");
  expect(text).not.toContain("authorized");
  expect(text).not.toContain("active");
});

test("比較コード取得の要約は有無と要求識別子だけに落とす", () => {
  const found = summarizeLocalResult("getPairingView", {
    available: true,
    requestId: "r1",
    code: SECRET,
    displayCode: "ひみつ 003",
  });
  expect(found).toEqual({ kind: "pairingAvailability", available: true, requestId: "r1" });
  expect(JSON.stringify(found)).not.toContain(SECRET);
  expect(summarizeLocalResult("getPairingView", { available: false, reason: "消滅した" })).toEqual({
    kind: "pairingAvailability",
    available: false,
    requestId: null,
  });
});

test("業務要約に秘密（本文・payload）が載らない", () => {
  const cases = [
    summarizeLocalResult("getSnapshot", makeSnapshot()),
    summarizeLocalResult("enableAcceptance", { accepting: true, text: SECRET }),
    summarizeLocalResult("assignPlugin", {
      pluginKind: "text",
      pluginId: "text",
      localSessionId: "s1",
      instanceId: "i1",
      portId: "text",
      payload: SECRET,
    }),
    summarizeLocalResult("unassignPlugin", { released: true, issues: [{ stage: "x" }] }),
    summarizeLocalResult("setPluginView", {
      adopted: true,
      current: { instanceId: "i1", viewGeneration: 3 },
      text: SECRET,
    }),
  ];
  expect(cases[2]).toEqual({
    kind: "assignment",
    pluginKind: "text",
    pluginId: "text",
    localSessionId: "s1",
    instanceId: "i1",
    portId: "text",
  });
  expect(cases[3]).toEqual({ kind: "unassignment", released: true, issues: 1 });
  expect(cases[4]).toEqual({
    kind: "pluginView",
    adopted: true,
    instanceId: "i1",
    viewGeneration: 3,
  });
  for (const summary of cases) {
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  }
});

test("表示要求の要約は採用とstaleを区別し現在の採用済みを残す", () => {
  expect(
    summarizeLocalResult("setPluginView", {
      adopted: false,
      current: { instanceId: "i1", viewGeneration: 2 },
    }),
  ).toEqual({ kind: "pluginView", adopted: false, instanceId: "i1", viewGeneration: 2 });
  expect(summarizeLocalResult("getSnapshot", makeSnapshot()).kind).toBe("status");
  expect(summarizeLocalResult("disableAcceptance", { accepting: false })).toEqual({
    kind: "admission",
    accepting: false,
  });
});
