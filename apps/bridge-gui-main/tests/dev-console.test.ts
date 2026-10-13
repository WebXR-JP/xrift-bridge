import { expect, test } from "vite-plus/test";
import type { ManagementSnapshot, NgDevObserveResult } from "bridge-gui-contract/management";
import {
  DEV_OP_TIMEOUT_ERROR,
  handleDevConsoleRequest,
  raceDevOpWithTimeout,
  unavailableDomObservation,
  type DevConsoleObserver,
  type DevHttpRequest,
  type DevRequestContext,
  type DevUpstream,
} from "../src/main/dev-console.ts";

// 開発接続口の拒否・要約・段階観測の固定。待受自体（Bun.serve）は
// 起動経路で結線し、ここでは要求処理だけを代役で検証する。
// 比較コード本文・業務 payload・テキスト本文は代役にも載せない。

const SECRET = "ひみつの本文041003";

/** 段階観測の試験値。 */
function makeDom(revision: number | null): NgDevObserveResult {
  return {
    available: true,
    reason: "",
    adoptedRevision: revision,
    focus: true,
    activeKey: "text-card",
    elements: [],
    hasNg: true,
    componentMounted: true,
    resolvedComponent: true,
  };
}

/** 表示状態の試験値。 */
function makeSnapshot(revision: number): ManagementSnapshot {
  return {
    revision,
    backend: "ready",
    endpoint: null,
    admission: { accepting: false },
    pending: [],
    connections: [],
    sessions: [],
    plugins: { kinds: [], instances: [], assignments: [] },
    pluginMounts: [],
    pluginMountFailures: [],
    pluginNavigationRules: [],
  };
}

/** 試験用の結線。業務結果に秘密を混ぜても応答に載らないことを見る。 */
function prepareContext(observer?: DevConsoleObserver): {
  context: DevRequestContext;
  upstream: DevUpstream;
} {
  const token = "実行ごとの乱数tokenの代役";
  const backend = {
    getSnapshot: () => makeSnapshot(7),
    enableAcceptance: () => ({ accepting: true }),
    disableAcceptance: () => ({ accepting: false }),
    getPairingView: () => ({
      available: true,
      requestId: "r1",
      code: SECRET,
      displayCode: "ひみつ 003",
    }),
    approvePairing: () => ({ status: "APPROVED", connectionId: "c1", origin: "o" }),
    rejectPairing: () => ({ status: "REJECTED" }),
    disconnectConnection: () => ({ ok: true as const }),
    assignPlugin: () => ({
      pluginKind: "diagnostic",
      pluginId: "diagnostic",
      localSessionId: "s1",
      instanceId: "i1",
      portId: "diagnostic",
    }),
    unassignPlugin: () => ({ released: true, issues: [] }),
  };
  const spike = {
    createSpikeMount: () => ({ mountId: "spike-1", initialUrl: "views://blank" }),
    destroySpikeMount: () => ({ ok: true as const }),
    pushSpikeMount: () => ({ revision: 2 }),
    listSpikeMounts: () => [],
    resetSpikeMounts: () => ({ ok: true as const }),
  };
  const pluginUi = {
    syncPluginUi: () => {},
    listPluginUiMounts: () => [],
    listPluginUiFailures: () => [],
    retryPluginUiMounts: () => ({ ok: true as const }),
  };
  // ADR: `as` は実行時の検証にならないため、主張する型が成立する根拠を残す。
  // 代役は接続口の試験用であり、使う操作（取得・受付・比較コード取得・
  // 承認・割当て・送信・子画面・再試行）の項目だけを満たす。対象外の
  // backend 内部（server・core）は持たない。
  const context = {
    backend,
    spike,
    pluginUi,
    observer: observer ?? { observeDom: async (revision: number) => makeDom(revision) },
    token,
  } as unknown as DevRequestContext;
  const upstream: DevUpstream = {
    port: 3210,
    requestIP: () => ({ address: "127.0.0.1" }),
  };
  return { context, upstream };
}

/** 試験用の要求。禁則頭も載せられる素朴な形である。 */
function makeRequest(
  path: string,
  options?: {
    method?: string;
    token?: string | null;
    host?: string | null;
    origin?: string | null;
    body?: string;
  },
): DevHttpRequest {
  const headers = new Map<string, string>();
  const token = options?.token === undefined ? "実行ごとの乱数tokenの代役" : options.token;
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const host = options?.host === undefined ? "127.0.0.1:3210" : options.host;
  if (host !== null) {
    headers.set("host", host);
  }
  const origin = options?.origin === undefined ? null : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return {
    url: `http://127.0.0.1:3210${path}`,
    method: options?.method ?? "POST",
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => options?.body ?? "",
  };
}

/** 応答本文を解釈する。秘密の混入検査にも使う。 */
async function readBody(
  response: Response,
): Promise<{ status: number; json: unknown; text: string }> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as unknown, text };
}

test("受付の無効化が段階観測付きで返る", async () => {
  const { context, upstream } = prepareContext();
  const response = await handleDevConsoleRequest(
    makeRequest("/dev/op", {
      body: JSON.stringify({ op: "disableAcceptance", correlationId: "c1" }),
    }),
    upstream,
    context,
  );
  const { status, json, text } = await readBody(response);
  expect(status).toBe(200);
  const body = json as Record<string, unknown>;
  expect(body["ok"]).toBe(true);
  expect(body["op"]).toBe("disableAcceptance");
  expect(body["correlationId"]).toBe("c1");
  expect(body["business"]).toEqual({ kind: "admission", accepting: false });
  // snapshot 採用（revision）と Angular の DOM 反映が分かれて返る。
  expect(body["snapshotRevision"]).toBe(7);
  expect((body["dom"] as { adoptedRevision: number }).adoptedRevision).toBe(7);
  expect((body["dom"] as { available: boolean }).available).toBe(true);
  // native 画素観測は未対応の定型である。
  expect(body["native"]).toEqual({
    supported: false,
    reason: "Webview 単体の画素観測は未対応である（後続単位に委ねる）。",
  });
  // ブラウザ向け CORS は開かない。
  expect(response.headers.get("access-control-allow-origin")).toBe(null);
  expect(text).not.toContain(SECRET);
});

test("比較コード取得は有無だけを返し本文を載せない", async () => {
  const { context, upstream } = prepareContext();
  const response = await handleDevConsoleRequest(
    makeRequest("/dev/op", {
      body: JSON.stringify({ op: "getPairingView", params: { requestId: "r1" } }),
    }),
    upstream,
    context,
  );
  const { status, json, text } = await readBody(response);
  expect(status).toBe(200);
  expect((json as { business: unknown }).business).toEqual({
    kind: "pairingAvailability",
    available: true,
  });
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("ひみつ 003");
});

test("token無し・誤りは操作を実行せず拒否する", async () => {
  const { context, upstream } = prepareContext();
  for (const token of [null, "誤ったtoken"]) {
    const response = await handleDevConsoleRequest(
      makeRequest("/dev/op", { token, body: JSON.stringify({ op: "disableAcceptance" }) }),
      upstream,
      context,
    );
    const { status, json } = await readBody(response);
    expect(status).toBe(401);
    expect((json as { ok: boolean }).ok).toBe(false);
  }
});

test("Host不適・non-loopback・Origin不適を拒否する", async () => {
  const { context, upstream } = prepareContext();
  const badHost = await handleDevConsoleRequest(
    makeRequest("/dev/op", { host: "192.168.1.2:3210", body: "{}" }),
    upstream,
    context,
  );
  expect(badHost.status).toBe(403);
  const remoteUpstream: DevUpstream = { port: 3210, requestIP: () => ({ address: "192.168.1.2" }) };
  const nonLoopback = await handleDevConsoleRequest(
    makeRequest("/dev/op", { body: "{}" }),
    remoteUpstream,
    context,
  );
  expect(nonLoopback.status).toBe(403);
  const badOrigin = await handleDevConsoleRequest(
    makeRequest("/dev/op", { origin: "https://example.test", body: "{}" }),
    upstream,
    context,
  );
  expect(badOrigin.status).toBe(403);
});

test("許可外操作・形違い・上限超過を拒否する", async () => {
  const { context, upstream } = prepareContext();
  const denied = await handleDevConsoleRequest(
    makeRequest("/dev/op", { body: JSON.stringify({ op: "quit" }) }),
    upstream,
    context,
  );
  expect(denied.status).toBe(404);
  const malformed = await handleDevConsoleRequest(
    makeRequest("/dev/op", { body: "{" }),
    upstream,
    context,
  );
  expect(malformed.status).toBe(400);
  const oversized = await handleDevConsoleRequest(
    { ...makeRequest("/dev/op"), text: async () => "x".repeat(64 * 1024 + 1) },
    upstream,
    context,
  );
  expect(oversized.status).toBe(413);
});

test("DOM観測の到達不能は無効応答に落とし操作結果は保つ", async () => {
  const { context, upstream } = prepareContext({
    observeDom: async () => {
      throw new Error("到達不能");
    },
  });
  const response = await handleDevConsoleRequest(
    makeRequest("/dev/op", { body: JSON.stringify({ op: "enableAcceptance" }) }),
    upstream,
    context,
  );
  const { status, json } = await readBody(response);
  expect(status).toBe(200);
  const body = json as { business: unknown; snapshotRevision: number; dom: NgDevObserveResult };
  expect(body.business).toEqual({ kind: "admission", accepting: true });
  expect(body.snapshotRevision).toBe(7);
  expect(body.dom.available).toBe(false);
  // 観測不能時は採用したことにならないため改訂番号を載せない。
  expect(body.dom.adoptedRevision).toBe(null);
});

test("無効のDOM観測応答は定型である", () => {
  const dom = unavailableDomObservation();
  expect(dom.available).toBe(false);
  expect(dom.adoptedRevision).toBe(null);
  expect(dom.elements).toEqual([]);
});

test("期限適用の分岐は注入した時計で決まる", async () => {
  // 実時間待ちなしに両側を固定する。発火役は即時に期限側へ倒す。
  const fireNow = (callback: () => void) => {
    callback();
    return {};
  };
  const hanging = new Promise<Response>(() => {});
  const timedOut = await raceDevOpWithTimeout(hanging, 10_000, fireNow, () => {});
  expect(timedOut.status).toBe(504);
  const timedOutBody = (await timedOut.json()) as { ok: boolean; error: string };
  expect(timedOutBody.ok).toBe(false);
  expect(timedOutBody.error).toBe(DEV_OP_TIMEOUT_ERROR);
  // 期限内に終わる側は本来の応答を保つ（期限側の発火口は使わない）。
  const measured = Response.json({ ok: true }, { status: 200 });
  const kept = await raceDevOpWithTimeout(
    Promise.resolve(measured),
    10_000,
    () => ({}),
    () => {},
  );
  expect(kept.status).toBe(200);
});

test("操作全体の期限超過は定型の失敗応答になり秘密を載せない", async () => {
  // DOM 観測が沈黙しても操作全体の期限で打ち切る（短い期限を注入する）。
  const { context, upstream } = prepareContext({
    observeDom: () => new Promise<NgDevObserveResult>(() => {}),
  });
  const response = await handleDevConsoleRequest(
    makeRequest("/dev/op", { body: JSON.stringify({ op: "enableAcceptance" }) }),
    upstream,
    context,
    { timeoutMs: 20 },
  );
  const { status, json, text } = await readBody(response);
  expect(status).toBe(504);
  expect((json as { ok: boolean }).ok).toBe(false);
  expect((json as { error: string }).error).toBe(DEV_OP_TIMEOUT_ERROR);
  expect(text).not.toContain(SECRET);
});

test("旧管理操作名は許可外として拒否する", async () => {
  const { context, upstream } = prepareContext();
  for (const op of ["assignDiagnostics", "assignText", "sendText", "unassignText"]) {
    const response = await handleDevConsoleRequest(
      makeRequest("/dev/op", { body: JSON.stringify({ op }) }),
      upstream,
      context,
    );
    expect(response.status).toBe(404);
  }
  // 新操作は受け付ける。
  const assigned = await handleDevConsoleRequest(
    makeRequest("/dev/op", {
      body: JSON.stringify({
        op: "assignPlugin",
        params: { pluginKind: "diagnostic", localSessionId: "s1" },
      }),
    }),
    upstream,
    context,
  );
  expect(assigned.status).toBe(200);
  const released = await handleDevConsoleRequest(
    makeRequest("/dev/op", {
      body: JSON.stringify({
        op: "unassignPlugin",
        params: { instanceId: "i1", localSessionId: "s1", portId: "diagnostic" },
      }),
    }),
    upstream,
    context,
  );
  expect(released.status).toBe(200);
});
