import { expect, test } from "vite-plus/test";
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import {
  LOCAL_APPROVAL_REQUIRED_MESSAGE,
  summarizeLocalStatus,
} from "bridge-gui-contract/local-ops";
import {
  checkMcpHost,
  checkMcpOrigin,
  dispatchMcpRequest,
  handleMcpRequest,
  isMcpLoopbackAddress,
  MCP_MAX_BODY_BYTES,
  MCP_METHOD_NOT_ALLOWED,
  MCP_NOT_ACCEPTING,
  MCP_OP_TIMEOUT_ERROR,
  MCP_REQUEST_INVALID,
  MCP_TOOL_FAILURE,
  normalizeMcpFailureResponse,
  raceMcpWithTimeout,
  shouldStartMcp,
  startMcp,
  tryStartMcp,
  type McpHttpRequest,
  type McpRequestContext,
  type McpUpstream,
} from "../src/main/mcp.ts";

// 製品向け MCP の境界・射影・往復の固定。待受自体（Bun.serve）は
// 起動経路で結線し、ここでは要求処理だけを代役で検証する。
// 実 HTTP ソケットは使わない。認証は持たない（無認証で開く）。
// 比較コード本文・業務 payload・テキスト本文は代役にも載せない。

const SECRET = "ひみつの識別子-040103";
const SENTINEL = "SENTINEL-9f8e7d6c-marker";

/** 表示状態の試験値。識別子・本文を含めて射影で落ちることを見る。 */
function makeSnapshot(): ManagementSnapshot {
  return {
    revision: 7,
    backend: "ready",
    endpoint: { url: `http://127.0.0.1:3100/${SECRET}`, listening: true },
    admission: { accepting: false },
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
    pluginView: { instanceId: null, viewGeneration: 0 },
  };
}

/** 試験用の結線。受付の有効化で状態が変わることを見る。 */
function prepareContext(options?: { failing?: boolean; open?: boolean | (() => boolean) }): {
  context: McpRequestContext;
  upstream: McpUpstream;
  calls: string[];
} {
  let accepting = false;
  const calls: string[] = [];
  const backend = {
    getSnapshot: () => {
      calls.push("getSnapshot");
      return { ...makeSnapshot(), admission: { accepting } };
    },
    enableAcceptance: () => {
      calls.push("enableAcceptance");
      if (options?.failing === true) {
        throw new Error(`起動失敗の秘密-${SECRET}`);
      }
      accepting = true;
      return { accepting };
    },
    disableAcceptance: () => {
      calls.push("disableAcceptance");
      accepting = false;
      return { accepting };
    },
    getPairingView: (params: { requestId: unknown }) => {
      calls.push("getPairingView");
      if (params.requestId === "r1") {
        return {
          available: true,
          requestId: "r1",
          code: SECRET,
          displayCode: `表示形-${SECRET}`,
        };
      }
      return { available: false, reason: "対象の保留が無い。" };
    },
    assignPlugin: (params: { pluginKind: unknown; localSessionId?: unknown }) => {
      calls.push("assignPlugin");
      return {
        pluginKind: params.pluginKind,
        pluginId: params.pluginKind,
        localSessionId: params.localSessionId ?? "auto-s1",
        instanceId: "i9",
        portId: params.pluginKind,
      };
    },
    unassignPlugin: () => {
      calls.push("unassignPlugin");
      return { released: true, issues: [] };
    },
    setPluginView: (params: { instanceId: unknown; baseViewGeneration: unknown }) => {
      calls.push("setPluginView");
      if (params.baseViewGeneration === 0) {
        return { adopted: true, current: { instanceId: params.instanceId, viewGeneration: 1 } };
      }
      return { adopted: false, current: { instanceId: null, viewGeneration: 0 } };
    },
    approvePairing: () => {
      calls.push("approvePairing");
      return { status: "APPROVED" };
    },
    rejectPairing: () => {
      calls.push("rejectPairing");
      return { status: "REJECTED" };
    },
  };
  // ADR: `as` は実行時の検証にならないため、主張する型が成立する根拠を残す。
  // 代役は製品向け MCP の試験用であり、使う操作（取得・受付の有効化／無効化・
  // 比較コード取得・割当て・解除・子画面切替え・承認口）の項目だけを満たす。
  // 対象外の backend 内部（server・core）は持たない。
  const isOpen = typeof options?.open === "function" ? options.open : () => options?.open !== false;
  const context = {
    backend,
    isOpen,
  } as unknown as McpRequestContext;
  const upstream: McpUpstream = {
    port: 4321,
    requestIP: () => ({ address: "127.0.0.1" }),
  };
  return { context, upstream, calls };
}

/** 試験用の要求。`Host`・`Origin` は検査面だけを差し替えられる。 */
function makeRequest(
  path: string,
  options?: {
    method?: string;
    authorization?: string | null;
    host?: string | null;
    port?: number;
    origin?: string | null;
    protocolVersion?: string;
    remote?: string | null;
    body?: string | Uint8Array<ArrayBuffer>;
    streamChunks?: Uint8Array<ArrayBuffer>[];
  },
): { request: McpHttpRequest; upstream: McpUpstream } {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  // 無認証で開くため `Authorization` 頭は通常載せない。載せた場合の無視の
  // 確認にだけ使い、判定には使わない。
  if (options?.authorization !== undefined && options.authorization !== null) {
    headers.set("authorization", options.authorization);
  }
  if (options?.protocolVersion !== undefined) {
    headers.set("mcp-protocol-version", options.protocolVersion);
  }
  // fetch の `Request` 生成では禁則頭になる `Host` は検査面だけに載せる。
  const view = new Map<string, string>();
  const host = options?.host === undefined ? "127.0.0.1:4321" : options.host;
  if (host !== null) {
    view.set("host", host);
  }
  if (options?.origin !== undefined && options.origin !== null) {
    view.set("origin", options.origin);
  }
  // `streamChunks` は本文を読取り口から複数回に分けて流す（チャンク分割の検証用）。
  const init: RequestInit & { duplex?: "half" } = {
    method: options?.method ?? "POST",
    headers,
  };
  if (options?.streamChunks !== undefined) {
    const chunks = options.streamChunks;
    init.body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    init.duplex = "half";
  } else {
    init.body = options?.method === "GET" ? undefined : (options?.body ?? "{}");
  }
  const raw = new Request(`http://127.0.0.1:4321${path}`, init);
  const request: McpHttpRequest = {
    url: `http://127.0.0.1:4321${path}`,
    method: options?.method ?? "POST",
    headers: {
      get: (name: string) => {
        if (name === "host" || name === "origin") {
          return view.get(name) ?? null;
        }
        return headers.get(name);
      },
    },
    raw,
  };
  const remote = options?.remote === undefined ? "127.0.0.1" : options.remote;
  const upstream: McpUpstream = {
    port: options?.port ?? 4321,
    requestIP: () => (remote === null ? null : { address: remote }),
  };
  return { request, upstream };
}

/** JSON-RPC の要求文を作る。 */
function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

/** JSON-RPC の工具呼出し文を作る。 */
function callTool(id: number, name: string, toolArgs?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, ...(toolArgs === undefined ? {} : { arguments: toolArgs }) },
  });
}

/** JSON-RPC の通知文を作る。 */
function notify(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

/** 応答本文を解釈する。秘密の混入検査にも使う。 */
async function readBody(
  response: Response,
): Promise<{ status: number; json: unknown; text: string }> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as unknown, text };
}

test("環境変数が 1 のときだけ有効になる", () => {
  const saved = process.env["BRIDGE_GUI_MCP"];
  try {
    process.env["BRIDGE_GUI_MCP"] = "1";
    expect(shouldStartMcp()).toBe(true);
    delete process.env["BRIDGE_GUI_MCP"];
    expect(shouldStartMcp()).toBe(false);
    process.env["BRIDGE_GUI_MCP"] = "";
    expect(shouldStartMcp()).toBe(false);
    process.env["BRIDGE_GUI_MCP"] = "0";
    expect(shouldStartMcp()).toBe(false);
  } finally {
    if (saved === undefined) {
      delete process.env["BRIDGE_GUI_MCP"];
    } else {
      process.env["BRIDGE_GUI_MCP"] = saved;
    }
  }
});

test("Host・接続元・Origin の判定ができる", () => {
  // `Host` は待受け中の実ポートとの完全一致だけを通す（主部の抜き出しはしない）。
  expect(checkMcpHost("127.0.0.1:4321", 4321)).toBe(true);
  expect(checkMcpHost("127.0.0.1:4321", 9999)).toBe(false);
  expect(checkMcpHost("127.0.0.1", 4321)).toBe(false);
  expect(checkMcpHost("127.0.0.1:4321,evil.example", 4321)).toBe(false);
  expect(checkMcpHost("127.0.0.1:4321 ", 4321)).toBe(false);
  expect(checkMcpHost("192.168.1.2:4321", 4321)).toBe(false);
  expect(checkMcpHost(null, 4321)).toBe(false);
  expect(checkMcpHost("127.0.0.1:4321", Number.NaN)).toBe(false);
  expect(isMcpLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isMcpLoopbackAddress("::1")).toBe(true);
  expect(isMcpLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isMcpLoopbackAddress(null)).toBe(false);
  expect(isMcpLoopbackAddress("192.168.1.2")).toBe(false);
  // `Origin` は欠落だけを許可し、空を含む頭ありは拒否する。
  expect(checkMcpOrigin(null)).toBe(true);
  expect(checkMcpOrigin("")).toBe(false);
  expect(checkMcpOrigin("null")).toBe(false);
  expect(checkMcpOrigin("http://127.0.0.1:4321")).toBe(false);
  expect(checkMcpOrigin("https://app.xrift.net")).toBe(false);
});

test("射影は改訂番号・受付・識別子だけを持ち秘密を落とす", () => {
  const summary = summarizeLocalStatus(makeSnapshot());
  expect(summary).toEqual({
    revision: 7,
    backend: "ready",
    accepting: false,
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
    pluginView: { instanceId: null, viewGeneration: 0 },
  });
  expect(JSON.stringify(summary)).not.toContain(SECRET);
});

test("Authorization なしで往復できる（頭があっても同じ扱いである）", async () => {
  const { context, calls } = prepareContext();
  const call = async (
    body: string,
    authorization?: string | null,
  ): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body, authorization });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  // `Authorization` 頭なしで一覧・呼出しが通る。
  const listed = await call(rpc(1, "tools/list"));
  expect(listed.status).toBe(200);
  // 誤った頭・余計な頭があっても無視し、同じく通る（無認証で開く）。
  for (const authorization of ["Bearer wrong-token", "Token abc", "Bearer "]) {
    const retried = await call(rpc(2, "tools/list"), authorization);
    expect(retried.status).toBe(200);
  }
  const snapshot = await call(callTool(3, "getSnapshot"));
  expect(snapshot.status).toBe(200);
  const content = (
    snapshot.json as { result: { content: Array<{ text: string }>; isError?: boolean } }
  ).result;
  expect(content.isError).toBe(undefined);
  expect(JSON.parse(content.content[0]?.text ?? "{}")).toMatchObject({ kind: "status" });
  // 一覧取得では業務を呼ばない。呼出し1件だけ業務を実行する。
  expect(calls).toEqual(["getSnapshot"]);
});

test("閉じた個体の要求は業務を実行せず拒否する", async () => {
  const { context, calls } = prepareContext({ open: false });
  const { request, upstream } = makeRequest("/mcp", { body: rpc(1, "tools/list") });
  const response = await handleMcpRequest(request, upstream, context);
  const { status, json } = await readBody(response);
  // 受付の失効は `503` の定型で返す（本文・秘密は載せない）。
  expect(status).toBe(503);
  expect(json).toEqual({ ok: false, error: MCP_NOT_ACCEPTING });
  expect(calls).toEqual([]);
});

test("旧個体で本文を保留したまま再有効化しても旧要求では業務を呼ばない", async () => {
  // 旧個体で本文を保留させたまま再有効化し、保留を解放して業務が呼ばれないことを固定する。
  // 再有効化で旧個体は復活しない（旧個体の遅延要求は拒否し、新個体だけが通る）。
  let oldOpen = true;
  const old = prepareContext({ open: () => oldOpen });
  const fresh = {
    backend: old.context.backend,
    isOpen: () => true,
  } as unknown as McpRequestContext;
  const payload = new TextEncoder().encode(callTool(1, "getSnapshot"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void gate.then(() => {
        controller.enqueue(payload);
        controller.close();
      });
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: stream,
    duplex: "half",
  };
  const raw = new Request("http://127.0.0.1:4321/mcp", init);
  const view = new Map<string, string>([["host", "127.0.0.1:4321"]]);
  const request: McpHttpRequest = {
    url: "http://127.0.0.1:4321/mcp",
    method: "POST",
    headers: {
      get: (name: string) => (name === "host" ? (view.get(name) ?? null) : raw.headers.get(name)),
    },
    raw,
  };
  const upstream: McpUpstream = { port: 4321, requestIP: () => ({ address: "127.0.0.1" }) };
  const pending = handleMcpRequest(request, upstream, old.context);
  // 本文を保留させたまま再有効化する（旧個体は閉じ、新個体は開いている）。
  oldOpen = false;
  const live = makeRequest("/mcp", { body: callTool(1, "getSnapshot") });
  const liveResponse = await handleMcpRequest(live.request, live.upstream, fresh);
  expect(liveResponse.status).toBe(200);
  release();
  const staleResponse = await pending;
  expect(staleResponse.status).toBe(503);
  expect(await staleResponse.text()).toContain(MCP_NOT_ACCEPTING);
  // 新個体の1件だけが業務を呼ぶ（旧個体の保留分は呼ばない）。
  expect(old.calls).toEqual(["getSnapshot"]);
});

test("停止後の遅延本文では業務を呼ばない", async () => {
  let open = true;
  const { context, calls } = prepareContext({ open: () => open });
  // 本文の到達を止めている間に停止する（到達時は開いていた遅延本文）。
  const payload = new TextEncoder().encode(callTool(1, "getSnapshot"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void gate.then(() => {
        controller.enqueue(payload);
        controller.close();
      });
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: stream,
    duplex: "half",
  };
  const raw = new Request("http://127.0.0.1:4321/mcp", init);
  const view = new Map<string, string>([["host", "127.0.0.1:4321"]]);
  const request: McpHttpRequest = {
    url: "http://127.0.0.1:4321/mcp",
    method: "POST",
    headers: {
      get: (name: string) => (name === "host" ? (view.get(name) ?? null) : raw.headers.get(name)),
    },
    raw,
  };
  const upstream: McpUpstream = { port: 4321, requestIP: () => ({ address: "127.0.0.1" }) };
  const pending = handleMcpRequest(request, upstream, context);
  // 読取りの完了前に停止する。
  open = false;
  release();
  const response = await pending;
  // 読取り後の再検査で拒否し、業務は呼ばない。
  expect(response.status).toBe(503);
  expect(await response.text()).toContain(MCP_NOT_ACCEPTING);
  expect(calls).toEqual([]);
});

test("Host 不適・loopback 以外・Origin ありを拒否する", async () => {
  const { context, calls } = prepareContext();
  const badHost = makeRequest("/mcp", { host: "192.168.1.2:4321", body: rpc(1, "tools/list") });
  expect((await handleMcpRequest(badHost.request, badHost.upstream, context)).status).toBe(403);
  const noHost = makeRequest("/mcp", { host: null, body: rpc(1, "tools/list") });
  expect((await handleMcpRequest(noHost.request, noHost.upstream, context)).status).toBe(403);
  // 実ポートと違う `Host` は通らない（主部だけの一致では足りない）。
  const wrongPort = makeRequest("/mcp", {
    host: "127.0.0.1:9999",
    body: rpc(1, "tools/list"),
  });
  expect((await handleMcpRequest(wrongPort.request, wrongPort.upstream, context)).status).toBe(403);
  const trailing = makeRequest("/mcp", {
    host: "127.0.0.1:4321,evil.example",
    body: rpc(1, "tools/list"),
  });
  expect((await handleMcpRequest(trailing.request, trailing.upstream, context)).status).toBe(403);
  const remote = makeRequest("/mcp", { remote: "192.168.1.2", body: rpc(1, "tools/list") });
  expect((await handleMcpRequest(remote.request, remote.upstream, context)).status).toBe(403);
  // `Origin` は空を含む頭ありをすべて拒否する（欠落のみ許可）。
  for (const origin of ["", "null", "http://127.0.0.1:4321", "https://app.xrift.net"]) {
    const badOrigin = makeRequest("/mcp", { origin, body: rpc(1, "tools/list") });
    expect((await handleMcpRequest(badOrigin.request, badOrigin.upstream, context)).status).toBe(
      403,
    );
  }
  expect(calls).toEqual([]);
});

test("POST /mcp 以外を拒否する", async () => {
  const { context, calls } = prepareContext();
  const other = makeRequest("/other", { body: rpc(1, "tools/list") });
  expect((await handleMcpRequest(other.request, other.upstream, context)).status).toBe(404);
  const put = makeRequest("/mcp", { method: "PUT", body: rpc(1, "tools/list") });
  expect((await handleMcpRequest(put.request, put.upstream, context)).status).toBe(404);
  expect(calls).toEqual([]);
});

test("GET /mcp は購読を持たないため 405 で返す", async () => {
  const { context, calls } = prepareContext();
  const { request, upstream } = makeRequest("/mcp", { method: "GET" });
  const response = await handleMcpRequest(request, upstream, context);
  const { status, json } = await readBody(response);
  expect(status).toBe(405);
  expect(json).toEqual({ ok: false, error: MCP_METHOD_NOT_ALLOWED });
  // ブラウザ向け CORS は開かない。
  expect(response.headers.get("access-control-allow-origin")).toBe(null);
  expect(calls).toEqual([]);
});

test("本文の上限超過を定型で拒否し本文を写さない", async () => {
  const { context, calls } = prepareContext();
  const marker = `上限超過の標識-${SECRET}-${"x".repeat(1024)}`;
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", marker });
  const padded = big + " ".repeat(MCP_MAX_BODY_BYTES);
  const { request, upstream } = makeRequest("/mcp", { body: padded });
  const response = await handleMcpRequest(request, upstream, context);
  const { status, json, text } = await readBody(response);
  expect(status).toBe(413);
  // `code` は残し、文言は定型に置き換える。業務は呼ばない。
  const failure = (json as { error: { code: number; message: string } }).error;
  expect(typeof failure.code).toBe("number");
  expect(failure.message).toBe(MCP_REQUEST_INVALID);
  expect(text).not.toContain(marker);
  expect(text).not.toContain(SECRET);
  expect(calls).toEqual([]);
});

test("初期化・一覧・呼出しの往復が通る", async () => {
  const { context } = prepareContext();
  const call = async (body: string): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  const initialized = await call(
    rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "spike-probe", version: "0.0.0" },
    }),
  );
  expect(initialized.status).toBe(200);
  expect(
    (initialized.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name,
  ).toBe("bridge-gui-local-ops");
  const notifiedRaw = makeRequest("/mcp", { body: notify("notifications/initialized") });
  const notifiedStatus = (
    await handleMcpRequest(notifiedRaw.request, notifiedRaw.upstream, context)
  ).status;
  expect(notifiedStatus).toBe(202);
  const listed = await call(rpc(2, "tools/list"));
  expect(listed.status).toBe(200);
  const tools = (listed.json as { result: { tools: Array<{ name: string }> } }).result.tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "approvePairing",
    "assignPlugin",
    "disableAcceptance",
    "enableAcceptance",
    "getPairingView",
    "getSnapshot",
    "rejectPairing",
    "setPluginView",
    "unassignPlugin",
  ]);
  // 一覧広告の引数 schema に秘密の例値は載せない。
  expect(JSON.stringify(tools)).not.toContain(SECRET);
  const snapshot = await call(callTool(3, "getSnapshot"));
  expect(snapshot.status).toBe(200);
  const content = (
    snapshot.json as { result: { content: Array<{ text: string }>; isError?: boolean } }
  ).result;
  expect(content.isError).toBe(undefined);
  const summary = JSON.parse(content.content[0]?.text ?? "{}") as Record<string, unknown>;
  expect(summary["kind"]).toBe("status");
  const status = summary["status"] as Record<string, unknown>;
  expect(status["revision"]).toBe(7);
  expect(status["accepting"]).toBe(false);
  expect(status["pendingRequestIds"]).toEqual(["r1"]);
  expect(status["connectionIds"]).toEqual(["c1"]);
  expect(status["localSessionIds"]).toEqual(["s1"]);
  expect(snapshot.text).not.toContain(SECRET);
  expect(snapshot.text).not.toContain("https://app.xrift.net");
  expect(snapshot.text).not.toContain("論理名");
  // ブラウザ向け CORS は開かない。
  const { request, upstream } = makeRequest("/mcp", { body: rpc(4, "tools/list") });
  const response = await handleMcpRequest(request, upstream, context);
  expect(response.headers.get("access-control-allow-origin")).toBe(null);
  const enabled = await call(callTool(5, "enableAcceptance"));
  expect(enabled.status).toBe(200);
  const accepted = (
    enabled.json as { result: { content: Array<{ text: string }>; isError?: boolean } }
  ).result;
  expect(accepted.isError).toBe(undefined);
  expect(JSON.parse(accepted.content[0]?.text ?? "{}")).toEqual({
    kind: "admission",
    accepting: true,
    revision: 7,
  });
  const again = await call(callTool(6, "getSnapshot"));
  const resummary = JSON.parse(
    (again.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ??
      "{}",
  ) as Record<string, unknown>;
  expect((resummary["status"] as Record<string, unknown>)["accepting"]).toBe(true);
});

test("取得・割当て・解除・切替えの往復が通り秘密が載らない", async () => {
  const { context } = prepareContext();
  const call = async (body: string): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  const parse = (json: unknown): Record<string, unknown> => {
    const result = (json as { result: { content: Array<{ text: string }>; isError?: boolean } })
      .result;
    expect(result.isError).toBe(undefined);
    return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  };
  const pairing = await call(callTool(1, "getPairingView", { requestId: "r1" }));
  expect(pairing.status).toBe(200);
  expect(parse(pairing.json)).toEqual({
    kind: "pairingAvailability",
    available: true,
    requestId: "r1",
    revision: 7,
  });
  expect(pairing.text).not.toContain(SECRET);
  const assigned = await call(
    callTool(2, "assignPlugin", { pluginKind: "text", localSessionId: "s1" }),
  );
  expect(parse(assigned.json)).toEqual({
    kind: "assignment",
    pluginKind: "text",
    pluginId: "text",
    localSessionId: "s1",
    instanceId: "i9",
    portId: "text",
    revision: 7,
  });
  const unassigned = await call(
    callTool(3, "unassignPlugin", { instanceId: "i1", localSessionId: "s1", portId: "text" }),
  );
  expect(parse(unassigned.json)).toEqual({
    kind: "unassignment",
    released: true,
    issues: 0,
    revision: 7,
  });
  const adopted = await call(
    callTool(4, "setPluginView", { instanceId: "i1", baseViewGeneration: 0 }),
  );
  expect(parse(adopted.json)).toEqual({
    kind: "pluginView",
    adopted: true,
    instanceId: "i1",
    viewGeneration: 1,
    revision: 7,
  });
  const stale = await call(
    callTool(5, "setPluginView", { instanceId: "i1", baseViewGeneration: 9 }),
  );
  expect(parse(stale.json)).toEqual({
    kind: "pluginView",
    adopted: false,
    instanceId: null,
    viewGeneration: 0,
    revision: 7,
  });
  const disabled = await call(callTool(6, "disableAcceptance"));
  expect(parse(disabled.json)).toEqual({ kind: "admission", accepting: false, revision: 7 });
});

test("承認の要求は人間の GUI 操作を要する応答になり自動では承認しない", async () => {
  const { context, calls } = prepareContext();
  const call = async (body: string): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  for (const [id, name] of [
    [1, "approvePairing"],
    [2, "rejectPairing"],
  ] as const) {
    const response = await call(callTool(id, name, { requestId: "r1" }));
    expect(response.status).toBe(200);
    const result = (
      response.json as { result: { content: Array<{ text: string }>; isError?: boolean } }
    ).result;
    expect(result.isError).toBe(undefined);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
      requiresHumanOperation: true,
      message: LOCAL_APPROVAL_REQUIRED_MESSAGE,
    });
  }
  expect(calls).toEqual([]);
});

test("許可外の工具を失敗として返し入力名を写さない", async () => {
  const { context, calls } = prepareContext();
  for (const name of [`quit-${SENTINEL}`, "disconnectConnection", "retryPluginMount", "eval"]) {
    const { request, upstream } = makeRequest("/mcp", {
      body: callTool(1, name),
    });
    const { status, json, text } = await readBody(
      await handleMcpRequest(request, upstream, context),
    );
    expect(status).toBe(200);
    // 未登録の工具名は SDK が文言に反射するため、定型の失敗結果に置き換える。
    // `isError` は保ち、成功に化けさせない。
    const result = (json as { result: { isError: boolean; content: Array<{ text: string }> } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: MCP_TOOL_FAILURE }]);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(SECRET);
  }
  expect(calls).toEqual([]);
});

test("広告された制約と実際の受理・拒否が一致する", async () => {
  const { context, calls } = prepareContext();
  const call = async (body: string): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  const listed = await call(rpc(1, "tools/list"));
  const tools = (listed.json as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
  const byName = Object.fromEntries(tools.map((tool) => [tool["name"], tool]));
  // 必須・任意・`null` の可否の広告を確認する。
  const pairing = byName["getPairingView"] as Record<string, unknown>;
  const pairingSchema = pairing["inputSchema"] as Record<string, unknown>;
  expect(pairingSchema["required"]).toEqual(["requestId"]);
  const assignSchema = (byName["assignPlugin"] as Record<string, unknown>)["inputSchema"] as Record<
    string,
    unknown
  >;
  expect(assignSchema["required"]).toEqual(["pluginKind"]);
  const viewSchema = (byName["setPluginView"] as Record<string, unknown>)["inputSchema"] as Record<
    string,
    unknown
  >;
  expect(viewSchema["required"]).toEqual(["instanceId", "baseViewGeneration"]);
  const viewProps = viewSchema["properties"] as Record<string, unknown>;
  // `instanceId` は `null` を許し、基準世代は下限 0・上限なしの整数相当の広告である。
  expect(JSON.stringify(viewProps["instanceId"])).toContain('"null"');
  const generationSchema = viewProps["baseViewGeneration"] as Record<string, unknown>;
  expect(generationSchema["minimum"]).toBe(0);
  expect(generationSchema["multipleOf"]).toBe(1);
  expect(generationSchema["maximum"]).toBe(undefined);
  // 広告どおりに受理・拒否する。拒否では業務処理を呼ばない。
  // 制約違反は SDK の検証文言を定型の失敗結果に置き換える（入力値の写しは載せない）。
  const rejected = (json: unknown, text: string): void => {
    const result = (json as { result: { isError: boolean; content: Array<{ text: string }> } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: MCP_TOOL_FAILURE }]);
    expect((json as { error?: unknown }).error).toBe(undefined);
    expect(text).not.toContain(SENTINEL);
  };
  const first = await call(callTool(2, "assignPlugin", {}));
  rejected(first.json, first.text);
  const second = await call(callTool(3, "assignPlugin", { pluginKind: "" }));
  rejected(second.json, second.text);
  const third = await call(callTool(4, "assignPlugin", { pluginKind: 1 }));
  rejected(third.json, third.text);
  const fourth = await call(
    callTool(5, "setPluginView", { instanceId: "i1", baseViewGeneration: -1 }),
  );
  rejected(fourth.json, fourth.text);
  const fifth = await call(
    callTool(6, "setPluginView", { instanceId: "i1", baseViewGeneration: 1.5 }),
  );
  rejected(fifth.json, fifth.text);
  const sixth = await call(callTool(7, "getPairingView", {}));
  rejected(sixth.json, sixth.text);
  // 検証に通らない入力に目印が混ざっても応答に写さない。
  const seventh = await call(
    callTool(11, "setPluginView", { instanceId: SENTINEL, baseViewGeneration: -1 }),
  );
  rejected(seventh.json, seventh.text);
  expect(calls).toEqual([]);
  // 広告どおりの `null`・省略・境界値は受理し、業務を実行する。
  // 基準世代の受理範囲は backend の外形検査と同じ（非負の整数。
  // 安全整数範囲に限定しない。`2^53` を通す）。
  const huge = await call(
    callTool(8, "setPluginView", { instanceId: "i1", baseViewGeneration: 2 ** 53 }),
  );
  expect(
    (huge.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result
      .isError,
  ).toBe(undefined);
  const nulled = await call(
    callTool(9, "setPluginView", { instanceId: null, baseViewGeneration: 0 }),
  );
  expect(
    (nulled.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
  ).toContain('"adopted":true');
  const omitted = await call(callTool(10, "assignPlugin", { pluginKind: "text" }));
  expect(
    (omitted.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
  ).toContain('"localSessionId":"auto-s1"');
  expect(calls).toEqual([
    "setPluginView",
    "getSnapshot",
    "setPluginView",
    "getSnapshot",
    "assignPlugin",
    "getSnapshot",
  ]);
});

test("業務の例外を応答に載せず定型で返す", async () => {
  const { context } = prepareContext({ failing: true });
  const { request, upstream } = makeRequest("/mcp", {
    body: callTool(1, "enableAcceptance"),
  });
  const { status, json, text } = await readBody(await handleMcpRequest(request, upstream, context));
  expect(status).toBe(200);
  const result = (json as { result: { isError: boolean; content: Array<{ text: string }> } })
    .result;
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toBe("操作に失敗した。");
  expect(text).not.toContain(SECRET);
});

test("期限超過は定型の応答に落とす", async () => {
  const never = new Promise<Response>(() => {});
  const finished = await raceMcpWithTimeout(
    never,
    10,
    (callback) => {
      callback();
      return 0;
    },
    () => {},
  );
  expect(finished.status).toBe(504);
  const body = (await finished.json()) as { ok: boolean; error: string };
  expect(body).toEqual({ ok: false, error: MCP_OP_TIMEOUT_ERROR });
});

test("期限内は本来の応答を返す", async () => {
  const response = await raceMcpWithTimeout(
    Promise.resolve(new Response("ok")),
    10,
    () => 0,
    () => {},
  );
  expect(await response.text()).toBe("ok");
});

test("SDK 由来の失敗は code を残して文言を定型化する", async () => {
  const { context, calls } = prepareContext();
  const call = async (
    body: string,
    options?: { protocolVersion?: string },
  ): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body, ...options });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  // 非対応の protocol 版（SDK が値を文言に反射する）は code を残して落とす。
  const version = await call(rpc(1, "tools/list"), {
    protocolVersion: `1999-99-99-${SENTINEL}`,
  });
  expect(version.status).toBe(400);
  const versionError = (version.json as { error: { code: number; message: string } }).error;
  expect(typeof versionError.code).toBe("number");
  expect(versionError.message).toBe(MCP_REQUEST_INVALID);
  expect(version.text).not.toContain(SENTINEL);
  // 不正 JSON（入力の写しが混ざる）は code を残して落とす。
  const broken = await call(`{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "oops-${SECRET}`);
  expect(broken.status).toBe(400);
  const brokenError = (broken.json as { error: { code: number; message: string } }).error;
  expect(brokenError.code).toBe(-32700);
  expect(brokenError.message).toBe(MCP_REQUEST_INVALID);
  expect(broken.text).not.toContain(SECRET);
  // 未知メソッド（SDK が名称を文言に反射する）は code を残して落とす。
  // transport は JSON-RPC の失敗を `200` の `error` で返す。
  const unknown = await call(rpc(3, `nope-${SENTINEL}`));
  expect(unknown.status).toBe(200);
  const unknownError = (unknown.json as { error: { code: number; message: string } }).error;
  expect(unknownError.code).toBe(-32601);
  expect(unknownError.message).toBe(MCP_REQUEST_INVALID);
  expect(unknown.text).not.toContain(SENTINEL);
  // 要求外形の不正（引数なしの呼出し）は code を残して落とす。
  const shapeless = await call(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call" }));
  expect(shapeless.status).toBe(200);
  const shapelessError = (shapeless.json as { error: { code: number; message: string } }).error;
  expect(typeof shapelessError.code).toBe("number");
  expect(shapelessError.message).toBe(MCP_REQUEST_INVALID);
  // いずれも成功に化けさせず、業務も呼ばない。
  expect(calls).toEqual([]);
});

test("成功応答は正規化で変えない", async () => {
  const { context } = prepareContext();
  // 正規化していない応答（transport の生応答）と、正規化を通した応答を比べる。
  // 比較項目は status・全ヘッダー・本文の JSON 内容である。
  const compareUnchanged = async (payload: unknown, label: string): Promise<void> => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    });
    const raw = await dispatchMcpRequest(
      { url: "http://127.0.0.1:4321/mcp", method: "POST", headers, body: bytes },
      context.backend,
    );
    const rawStatus = raw.status;
    const rawHeaders = [...raw.headers];
    const rawBytes = new Uint8Array(await raw.arrayBuffer());
    const rebuilt = new Response(rawBytes, { status: rawStatus, headers: new Headers(rawHeaders) });
    const normalized = await normalizeMcpFailureResponse(rebuilt);
    expect(normalized.status, label).toBe(rawStatus);
    expect([...normalized.headers], label).toEqual(rawHeaders);
    expect(await normalized.json(), label).toEqual(JSON.parse(new TextDecoder().decode(rawBytes)));
  };
  await compareUnchanged(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    "一覧の成功応答は変えない",
  );
  await compareUnchanged(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "getSnapshot" } },
    "呼出しの成功応答は変えない",
  );
  // 通知の `202` 空応答もそのまま通す。
  const notified = makeRequest("/mcp", { body: notify("notifications/initialized") });
  const notifiedResponse = await handleMcpRequest(notified.request, notified.upstream, context);
  expect(notifiedResponse.status).toBe(202);
  expect(await notifiedResponse.text()).toBe("");
});

test("バッチ要求を受け付けず業務を呼ばない", async () => {
  const { context, calls } = prepareContext();
  // 正しい要素が混ざっていても、配列の要求は transport へ渡さず拒否する。
  const batch = JSON.stringify([
    { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "getSnapshot" } },
    { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: `BAD-${SENTINEL}` } },
    { jsonrpc: "2.0", id: 33, method: `nope-${SENTINEL}` },
  ]);
  const { request, upstream } = makeRequest("/mcp", { body: batch });
  const response = await handleMcpRequest(request, upstream, context);
  const { status, json, text } = await readBody(response);
  // 境界の拒否は既存の経路と同じ形（`{ok:false}`・入力の写しなし）で、
  // 要求形式の不備として `400` で返す。
  expect(status).toBe(400);
  expect(json).toEqual({ ok: false, error: MCP_REQUEST_INVALID });
  expect(text).not.toContain(SENTINEL);
  // 要素の業務処理は呼ばない。
  expect(calls).toEqual([]);
});

test("空白前置・単一要素の配列も受け付けない", async () => {
  const { context, calls } = prepareContext();
  const call = async (body: string): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  // 先頭の空白の量にかかわらず配列と判定する（読んだ本文全体で判定する）。
  for (const padding of [" \n".repeat(512), " ".repeat(8192)]) {
    const padded = await call(
      `${padding}[{"jsonrpc":"2.0","id":61,"method":"tools/call","params":{"name":"BAD-${SENTINEL}"}}]`,
    );
    expect(padded.status).toBe(400);
    expect(padded.json).toEqual({ ok: false, error: MCP_REQUEST_INVALID });
    expect(padded.text).not.toContain(SENTINEL);
  }
  // 単一要素の配列も配列であり、受け付けない。
  const single = await call(
    JSON.stringify([
      { jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "getSnapshot" } },
    ]),
  );
  expect(single.status).toBe(400);
  expect(single.json).toEqual({ ok: false, error: MCP_REQUEST_INVALID });
  expect(calls).toEqual([]);
});

test("配列応答は要素ごとに正規化する（保険）", async () => {
  // 受付自体は transport 手前で拒否しており、ここは破れた場合の保険である。
  // 成功要素は変えず、失敗要素の `id`・`error.code` は保つ。
  const mixed = new Response(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: `leaked-${SENTINEL}` }], isError: true },
      },
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: `nope-${SENTINEL}`, data: 1 } },
    ]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const normalized = await normalizeMcpFailureResponse(mixed);
  expect(normalized.status).toBe(200);
  expect(await normalized.json()).toEqual([
    { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } },
    {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: MCP_TOOL_FAILURE }], isError: true },
    },
    { jsonrpc: "2.0", id: 3, error: { code: -32601, message: MCP_REQUEST_INVALID } },
  ]);
});

test("大きな合法要求は停止せず処理する", async () => {
  const { context, calls } = prepareContext();
  // 上限（64KiB）近くの本文を持つ正しい単一要求。本文は境界で一度だけ読む。
  const padding = "x".repeat(60 * 1024);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 71,
    method: "tools/call",
    params: { name: "assignPlugin", arguments: { pluginKind: "text", note: padding } },
  });
  expect(new TextEncoder().encode(body).length).toBeLessThan(MCP_MAX_BODY_BYTES);
  const started = Date.now();
  const { request, upstream } = makeRequest("/mcp", { body });
  const response = await handleMcpRequest(request, upstream, context);
  const elapsed = Date.now() - started;
  const { status, json, text } = await readBody(response);
  expect(status).toBe(200);
  const result = (json as { result: { isError?: boolean; content: Array<{ text: string }> } })
    .result;
  expect(result.isError).toBe(undefined);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
    kind: "assignment",
    pluginKind: "text",
    pluginId: "text",
    localSessionId: "auto-s1",
    instanceId: "i9",
    portId: "text",
    revision: 7,
  });
  expect(text).not.toContain(padding.slice(0, 32));
  // 停止せず期限内に返ること。
  expect(elapsed).toBeLessThan(5000);
  expect(calls).toContain("assignPlugin");
});

test("非 UTF-8・BOM の扱いは SDK 単独と同じにする", async () => {
  const { context, calls } = prepareContext();
  const callBytes = async (
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: number; json: unknown; text: string }> => {
    const { request, upstream } = makeRequest("/mcp", { body: bytes });
    return readBody(await handleMcpRequest(request, upstream, context));
  };
  const concat = (...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
  // BOM 一個付きの正しい要求は受理する（`JSON.parse` と同じ扱い）。
  const single = await callBytes(concat(encode("﻿"), encode(rpc(1, "tools/list"))));
  expect(single.status).toBe(200);
  expect(
    ((single.json as { result: { tools: Array<{ name: string }> } }).result.tools ?? []).length,
  ).toBeGreaterThan(0);
  // BOM 二個付きは不正 JSON として拒否する（新たに許容しない）。
  const double = await callBytes(concat(encode("﻿﻿"), encode(rpc(2, "tools/list"))));
  expect(double.status).toBe(400);
  expect((double.json as { error: { code: number; message: string } }).error.code).toBe(-32700);
  expect((double.json as { error: { code: number; message: string } }).error.message).toBe(
    MCP_REQUEST_INVALID,
  );
  // 不正バイト入りの要求は不正 JSON として拒否する（新たに許容しない）。
  const invalid = await callBytes(
    concat(
      encode('{"jsonrpc":"2.0","id":3,"params":{"x":"'),
      new Uint8Array([0xff, 0xfe, 0xfd]),
      encode('"}}'),
    ),
  );
  expect(invalid.status).toBe(400);
  expect((invalid.json as { error: { code: number; message: string } }).error.code).toBe(-32700);
  // 不正バイトが多くても再エンコードで膨らまない（上限はバイト数で判定する）。
  // 24,000 バイトの不正バイトは `413` にならず `-32700` で落ちる。
  const many = new Uint8Array(24000).fill(0xff);
  const padded = await callBytes(
    concat(encode('{"jsonrpc":"2.0","id":4,"x":"'), many, encode('"}')),
  );
  expect(padded.status).toBe(400);
  expect((padded.json as { error: { code: number; message: string } }).error.code).toBe(-32700);
  // いずれも業務処理は呼ばない（受理した BOM 一個の場合も一覧取得であり、
  // backend の操作は呼ばない）。
  expect(calls).toEqual([]);
});

test("チャンク分割の大きな本文は停止せず処理する", async () => {
  const { context, calls } = prepareContext();
  // 60KiB 近くを 1KiB ずつの複数チャンクで流す。読取りは終端まで進むこと。
  const source = new TextEncoder().encode(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 81,
      method: "tools/call",
      params: { name: "assignPlugin", arguments: { pluginKind: "text", note: "x".repeat(1024) } },
    }),
  );
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < source.length; offset += 1024) {
    chunks.push(source.slice(offset, offset + 1024));
  }
  // 末尾に空白を足して 60KiB 近くにする（本文の JSON としては空白）。
  const padding = new Uint8Array(60 * 1024 - source.length).fill(0x20);
  chunks.push(padding);
  const sum = chunks.reduce((total, chunk) => total + chunk.length, 0);
  expect(sum).toBeLessThan(MCP_MAX_BODY_BYTES);
  const started = Date.now();
  const { request, upstream } = makeRequest("/mcp", { streamChunks: chunks });
  const response = await handleMcpRequest(request, upstream, context);
  const elapsed = Date.now() - started;
  const { status, json } = await readBody(response);
  expect(status).toBe(200);
  const result = (json as { result: { isError?: boolean; content: Array<{ text: string }> } })
    .result;
  expect(result.isError).toBe(undefined);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
    kind: "assignment",
    pluginKind: "text",
    pluginId: "text",
    localSessionId: "auto-s1",
    instanceId: "i9",
    portId: "text",
    revision: 7,
  });
  // 停止せず期限内に返ること。
  expect(elapsed).toBeLessThan(5000);
  expect(calls).toContain("assignPlugin");
});

test("異なる結果を返す並行要求を取り違えない", async () => {
  const { context, calls } = prepareContext();
  // 同じ要求識別子で内容の異なる3件を同時に送る。応答を交換しても検出できる。
  const bodies = [
    callTool(7, "getPairingView", { requestId: "r1" }),
    callTool(7, "getPairingView", { requestId: "rX" }),
    callTool(7, `unknown-tool-${SENTINEL}`),
  ];
  const results = await Promise.all(
    bodies.map(async (body) => {
      const { request, upstream } = makeRequest("/mcp", { body });
      return readBody(await handleMcpRequest(request, upstream, context));
    }),
  );
  for (const result of results) {
    expect(result.status).toBe(200);
  }
  const parse = (
    json: unknown,
  ): { id: number; result: { content: Array<{ text: string }>; isError?: boolean } } =>
    json as {
      id: number;
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
  // 各応答は要求の内容に対応する（交換・混線は無い）。
  const first = parse(results[0]?.json);
  expect(first.id).toBe(7);
  expect(first.result.isError).toBe(undefined);
  expect(JSON.parse(first.result.content[0]?.text ?? "{}")).toEqual({
    kind: "pairingAvailability",
    available: true,
    requestId: "r1",
    revision: 7,
  });
  const second = parse(results[1]?.json);
  expect(second.id).toBe(7);
  expect(second.result.isError).toBe(undefined);
  expect(JSON.parse(second.result.content[0]?.text ?? "{}")).toEqual({
    kind: "pairingAvailability",
    available: false,
    requestId: null,
    revision: 7,
  });
  const third = parse(results[2]?.json);
  expect(third.id).toBe(7);
  expect(third.result.isError).toBe(true);
  expect(third.result.content).toEqual([{ type: "text", text: MCP_TOOL_FAILURE }]);
  expect(results[2]?.text).not.toContain(SENTINEL);
  // 許可操作の2件だけ業務を実行する（未知工具は呼ばない）。
  // 並行のため順序は固定しない。件数で見る。
  expect(calls.filter((entry) => entry === "getPairingView").length).toBe(2);
  expect(calls.filter((entry) => entry === "getSnapshot").length).toBe(2);
  expect(calls).toHaveLength(4);
});

test("本文が届かない要求は期限で落とす", async () => {
  const { context, calls } = prepareContext();
  // 到達しない本文（読取りが止まる）でも要求1件の期限で打ち切る。
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  // `duplex: "half"` はストリーム本文に要る undici の指定であり、lib の
  // `RequestInit` には無いため交差型で足す。
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: stalled,
    duplex: "half",
  };
  const raw = new Request("http://127.0.0.1:4321/mcp", init);
  const request: McpHttpRequest = {
    url: "http://127.0.0.1:4321/mcp",
    method: "POST",
    headers: {
      get: (name: string) => (name === "host" ? "127.0.0.1:4321" : raw.headers.get(name)),
    },
    raw,
  };
  const upstream: McpUpstream = {
    port: 4321,
    requestIP: () => ({ address: "127.0.0.1" }),
  };
  const response = await handleMcpRequest(request, upstream, context, { timeoutMs: 50 });
  expect(response.status).toBe(504);
  expect(await response.text()).toContain(MCP_OP_TIMEOUT_ERROR);
  expect(calls).toEqual([]);
});

test("開始失敗時は口だけを閉じて投げない", () => {
  const { context } = prepareContext();
  const failing = (): never => {
    throw new Error("束縛できない");
  };
  // 下位の `startMcp` は失敗を同期例外で表す（半端な待受けは残らない）。
  expect(() => startMcp(context.backend, { listen: failing })).toThrow();
  // 呼び出し側の `tryStartMcp` は `null` に落とし、GUI の起動を継続できる。
  expect(tryStartMcp(context.backend, { listen: failing })).toBe(null);
});

test("待受の開始と終了は冪等で半端を残さない", async () => {
  const { context, calls } = prepareContext();
  const stops: string[] = [];
  const seen: Array<{ hostname: string; port: number }> = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  const handle = startMcp(context.backend, {
    listen: (hostname, port, onRequest) => {
      seen.push({ hostname, port });
      captured.push(onRequest);
      return {
        port: 4567,
        stop: () => {
          stops.push("stop");
        },
      };
    },
  });
  // 束縛先は loopback である。資格情報は持たない。
  expect(seen).toEqual([{ hostname: "127.0.0.1", port: 0 }]);
  expect(handle.port).toBe(4567);
  // 開いている間は個体の受付で要求が通る（閉鎖前）。
  const openUpstream: McpUpstream = { port: 4567, requestIP: () => ({ address: "127.0.0.1" }) };
  const openRaw = new Request("http://127.0.0.1:4567/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: rpc(1, "tools/list"),
  });
  // 実 `Request` には `Host` 頭が載らないため、ここでは境界の手前（個体の
  // 受付）までを通し、`Host` 不備の `403` で止まることを見る。
  const beforeClose = await captured[0]?.(openRaw, openUpstream);
  expect(beforeClose?.status).toBe(403);
  expect(calls).toEqual([]);
  await handle.close();
  await handle.close();
  // 停止は一度だけ行う（冪等）。
  expect(stops).toEqual(["stop"]);
  // 停止後は同じ個体の要求を拒否する（受付の失効。再利用は通らない）。
  const afterClose = await captured[0]?.(openRaw, openUpstream);
  expect(afterClose?.status).toBe(503);
  expect(calls).toEqual([]);
});

test("応答の正規化は単位で定型化と通過を分ける", async () => {
  // 平文の失敗は定型に置き換え、成功の空応答はそのまま返す。
  const plain = await normalizeMcpFailureResponse(new Response("boom", { status: 500 }));
  expect(plain.status).toBe(500);
  expect(await plain.json()).toEqual({ ok: false, error: MCP_REQUEST_INVALID });
  const accepted = await normalizeMcpFailureResponse(new Response(null, { status: 202 }));
  expect(accepted.status).toBe(202);
  expect(await accepted.text()).toBe("");
});

test("失敗の再構成は余分な項目と非真偽値を残さない", async () => {
  const canonical = {
    content: [{ type: "text", text: MCP_TOOL_FAILURE }],
    isError: true,
  };
  const envelop = (result: unknown, id: number): Response =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  // 余分な項目があっても定型に再構成する（残さない）。
  const withMeta = await normalizeMcpFailureResponse(
    envelop({ ...canonical, _meta: { injected: SENTINEL } }, 1),
  );
  expect(await withMeta.json()).toEqual({ jsonrpc: "2.0", id: 1, result: canonical });
  // 非真偽値の失敗表示は失敗として再構成する（成功にしない）。
  const truthy = await normalizeMcpFailureResponse(
    envelop({ content: [{ type: "text", text: "x" }], isError: "true" }, 2),
  );
  expect(await truthy.json()).toEqual({ jsonrpc: "2.0", id: 2, result: canonical });
  // `isError` が偽・欠落の場合は成功として通す。
  const explicitFalse = await normalizeMcpFailureResponse(
    envelop({ content: [{ type: "text", text: "ok" }], isError: false }, 3),
  );
  expect(await explicitFalse.json()).toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: "ok" }], isError: false },
  });
  const absent = await normalizeMcpFailureResponse(
    envelop({ content: [{ type: "text", text: "ok" }] }, 4),
  );
  expect(await absent.json()).toEqual({
    jsonrpc: "2.0",
    id: 4,
    result: { content: [{ type: "text", text: "ok" }] },
  });
});
