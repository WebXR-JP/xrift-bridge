import { expect, test } from "vite-plus/test";
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import { LOCAL_APPROVAL_REQUIRED_MESSAGE } from "bridge-gui-contract/local-ops";
import { executeLocalTool, runLocalOperation } from "../src/main/local-ops.ts";
import type { GuiBackend } from "../src/main/backend.ts";

// 製品向けローカル業務操作の委譲・検証・改訂番号の組付けの固定。業務 logic を
// 複写せず、既存操作へ渡すこと、拒否した要求では業務処理を呼ばないこと、
// 承認では backend を呼ばず定型応答に落とすことを確かめる。
// 正常応答には操作完了直後の改訂番号を組にし、案内・失敗には付けない。
// 比較コード本文・業務 payload・テキスト本文は代役にも載せない。

const SECRET = "ひみつの本文041003";

/** 表示状態の試験値。 */
function makeSnapshot(revision: number): ManagementSnapshot {
  return {
    revision,
    backend: "ready",
    endpoint: null,
    admission: { accepting: false },
    pending: [{ requestId: "r1" }],
    connections: [],
    sessions: [],
    plugins: { kinds: [], instances: [], assignments: [] },
    pluginMounts: [],
    pluginMountFailures: [],
    pluginNavigationRules: [],
    pluginView: { instanceId: null, viewGeneration: 0 },
  };
}

// ADR: `as` は実行時の検証にならないため、主張する型が成立する根拠を残す。
// 代役は委譲の試験用であり、使う操作の項目だけを満たす。対象外の backend
// 内部（server・core）は持たない。呼び出し記録で委譲先と引数を確かめる。
/** 呼び出しを記録する代役 backend を作る。 */
function prepareBackend(results: Record<string, unknown>): {
  backend: GuiBackend;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const backend = new Proxy(
    {},
    {
      get: (_target, property) => {
        const method = String(property);
        return (params?: unknown) => {
          calls.push({ method, params });
          return results[method];
        };
      },
    },
  ) as unknown as GuiBackend;
  return { backend, calls };
}

test("各操作を既存操作へ委譲し引数を渡す", () => {
  const snapshot = makeSnapshot(7);
  const { backend, calls } = prepareBackend({
    getSnapshot: snapshot,
    enableAcceptance: { accepting: true },
    disableAcceptance: { accepting: false },
    getPairingView: { available: false, reason: "対象の保留が無い。" },
    assignPlugin: {
      pluginKind: "text",
      pluginId: "text",
      localSessionId: "s1",
      instanceId: "i1",
      portId: "text",
    },
    unassignPlugin: { released: true, issues: [] },
    setPluginView: { adopted: true, current: { instanceId: "i1", viewGeneration: 1 } },
  });
  expect(runLocalOperation(backend, "getSnapshot", {})).toBe(snapshot);
  expect(runLocalOperation(backend, "enableAcceptance", {})).toEqual({ accepting: true });
  expect(runLocalOperation(backend, "disableAcceptance", {})).toEqual({ accepting: false });
  expect(runLocalOperation(backend, "getPairingView", { requestId: "r1" })).toEqual({
    available: false,
    reason: "対象の保留が無い。",
  });
  expect(
    runLocalOperation(backend, "assignPlugin", { pluginKind: "text", localSessionId: "s1" }),
  ).toEqual({
    pluginKind: "text",
    pluginId: "text",
    localSessionId: "s1",
    instanceId: "i1",
    portId: "text",
  });
  expect(
    runLocalOperation(backend, "unassignPlugin", {
      instanceId: "i1",
      localSessionId: "s1",
      portId: "text",
    }),
  ).toEqual({ released: true, issues: [] });
  expect(
    runLocalOperation(backend, "setPluginView", { instanceId: "i1", baseViewGeneration: 0 }),
  ).toEqual({ adopted: true, current: { instanceId: "i1", viewGeneration: 1 } });
  expect(calls).toEqual([
    { method: "getSnapshot", params: undefined },
    { method: "enableAcceptance", params: undefined },
    { method: "disableAcceptance", params: undefined },
    { method: "getPairingView", params: { requestId: "r1" } },
    { method: "assignPlugin", params: { pluginKind: "text", localSessionId: "s1" } },
    {
      method: "unassignPlugin",
      params: { instanceId: "i1", localSessionId: "s1", portId: "text" },
    },
    { method: "setPluginView", params: { instanceId: "i1", baseViewGeneration: 0 } },
  ]);
});

test("正常応答には操作完了直後の改訂番号を組にする", () => {
  const { backend, calls } = prepareBackend({
    enableAcceptance: { accepting: true },
    getSnapshot: makeSnapshot(8),
  });
  const outcome = executeLocalTool(backend, "enableAcceptance", {});
  expect(outcome).toEqual({
    ok: true,
    body: { kind: "admission", accepting: true, revision: 8 },
  });
  // 委譲の実行と直後の状態取得を分断しない（同期区間で順に呼ぶ）。
  expect(calls).toEqual([
    { method: "enableAcceptance", params: undefined },
    { method: "getSnapshot", params: undefined },
  ]);
});

test("取得は要約と同じ snapshot の改訂番号を使い読み直さない", () => {
  const { backend, calls } = prepareBackend({ getSnapshot: makeSnapshot(7) });
  const outcome = executeLocalTool(backend, "getSnapshot", {});
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.body).toMatchObject({ kind: "status", revision: 7 });
  }
  expect(calls).toEqual([{ method: "getSnapshot", params: undefined }]);
});

test("変更なし・stale の正常応答でも改訂番号を付ける", () => {
  const { backend } = prepareBackend({
    disableAcceptance: { accepting: false },
    getSnapshot: makeSnapshot(7),
    setPluginView: { adopted: false, current: { instanceId: null, viewGeneration: 0 } },
  });
  const disabled = executeLocalTool(backend, "disableAcceptance", {});
  expect(disabled).toEqual({
    ok: true,
    body: { kind: "admission", accepting: false, revision: 7 },
  });
  const stale = executeLocalTool(backend, "setPluginView", {
    instanceId: "i1",
    baseViewGeneration: 9,
  });
  expect(stale).toEqual({
    ok: true,
    body: {
      kind: "pluginView",
      adopted: false,
      instanceId: null,
      viewGeneration: 0,
      revision: 7,
    },
  });
});

test("承認と拒否は backend を呼ばず改訂番号も付けない", () => {
  const { backend, calls } = prepareBackend({ getSnapshot: makeSnapshot(7) });
  for (const op of ["approvePairing", "rejectPairing"] as const) {
    const outcome = executeLocalTool(backend, op, { requestId: "r1" });
    expect(outcome).toEqual({
      ok: true,
      body: { requiresHumanOperation: true, message: LOCAL_APPROVAL_REQUIRED_MESSAGE },
    });
  }
  expect(calls).toEqual([]);
});

test("引数の検証に通らない要求では業務処理を呼ばない", () => {
  const { backend, calls } = prepareBackend({
    getPairingView: { available: false, reason: "対象の保留が無い。" },
    getSnapshot: makeSnapshot(7),
  });
  for (const args of [{}, { requestId: "" }, { requestId: 1 }, "r1", null, []]) {
    expect(executeLocalTool(backend, "getPairingView", args)).toEqual({ ok: false });
  }
  expect(calls).toEqual([]);
  // 余分な項目は削って受け付け、backend へは渡さない。
  const stripped = executeLocalTool(backend, "getPairingView", {
    requestId: "r1",
    comparisonCode: SECRET,
  });
  expect(stripped.ok).toBe(true);
  expect(calls).toEqual([
    { method: "getPairingView", params: { requestId: "r1" } },
    { method: "getSnapshot", params: undefined },
  ]);
  expect(executeLocalTool(backend, "assignPlugin", { pluginKind: "" })).toEqual({ ok: false });
  expect(executeLocalTool(backend, "unassignPlugin", { instanceId: "i1" })).toEqual({
    ok: false,
  });
  expect(
    executeLocalTool(backend, "setPluginView", { instanceId: "i1", baseViewGeneration: -1 }),
  ).toEqual({ ok: false });
  expect(
    executeLocalTool(backend, "setPluginView", { instanceId: "i1", baseViewGeneration: 1.5 }),
  ).toEqual({ ok: false });
  expect(
    executeLocalTool(backend, "setPluginView", { instanceId: 1, baseViewGeneration: 0 }),
  ).toEqual({ ok: false });
  // 世代番号の受理範囲は backend の外形検査と同じ（非負の整数。
  // 安全整数範囲に限定しない。`2^53` を通す）。
  const huge = executeLocalTool(backend, "setPluginView", {
    instanceId: "i1",
    baseViewGeneration: 2 ** 53,
  });
  expect(huge.ok).toBe(true);
  // 検証の失敗では業務処理も状態取得も呼ばない。
  expect(calls).toEqual([
    { method: "getPairingView", params: { requestId: "r1" } },
    { method: "getSnapshot", params: undefined },
    { method: "setPluginView", params: { instanceId: "i1", baseViewGeneration: 2 ** 53 } },
    { method: "getSnapshot", params: undefined },
  ]);
});

test("業務の例外は失敗に落とし改訂番号も内容も載せない", () => {
  const backend = {
    enableAcceptance: (): unknown => {
      throw new Error(`起動失敗の秘密-${SECRET}`);
    },
  } as unknown as GuiBackend;
  const outcome = executeLocalTool(backend, "enableAcceptance", {});
  expect(outcome).toEqual({ ok: false });
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
});

test("未知の操作名は失敗に落とす", () => {
  const { backend, calls } = prepareBackend({});
  const outcome = executeLocalTool(backend, "quit" as never, {});
  expect(outcome).toEqual({ ok: false });
  expect(calls).toEqual([]);
});

test("閉じた個体の再検査では業務処理を呼ばない", () => {
  const { backend, calls } = prepareBackend({
    enableAcceptance: { accepting: true },
    getSnapshot: makeSnapshot(8),
  });
  // 開いている個体では委譲する。
  const live = executeLocalTool(backend, "enableAcceptance", {}, () => true);
  expect(live.ok).toBe(true);
  // 同じ待受け個体が閉じた後の再検査では業務を呼ばない（fail-closed）。
  // 検証に通る引数でも委譲の直前で落とす。
  expect(executeLocalTool(backend, "enableAcceptance", {}, () => false)).toEqual({ ok: false });
  expect(executeLocalTool(backend, "getSnapshot", {}, () => false)).toEqual({ ok: false });
  // 検査口の例外は閉じているものとして扱う。
  expect(
    executeLocalTool(backend, "enableAcceptance", {}, () => {
      throw new Error("検査に失敗した");
    }),
  ).toEqual({ ok: false });
  expect(calls).toEqual([
    { method: "enableAcceptance", params: undefined },
    { method: "getSnapshot", params: undefined },
  ]);
});
