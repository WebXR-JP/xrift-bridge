import { afterEach, expect, test } from "vite-plus/test";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseBridgeMessage } from "bridge-protocol";
import { WorldClientError, createWorldClient, type WorldClient } from "../src/index.ts";

const servers: WebSocketServer[] = [];
const clients: WorldClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** 試験用サーバの受信値をテキスト化する。 */
function rawToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data).toString("utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAIRING_DEFAULTS = {
  requestId: "pair-1",
  code: "123456",
  expiresAt: 9_999_999_999_999,
  expiresInMs: 120_000,
  sessionId: "session-stub",
  window: 16,
};

function pairingPendingText(overrides?: Partial<typeof PAIRING_DEFAULTS>): string {
  const v = { ...PAIRING_DEFAULTS, ...overrides };
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "pairing_pending",
    requestId: v.requestId,
    code: v.code,
    expiresAt: v.expiresAt,
    expiresInMs: v.expiresInMs,
  });
}

function authOkText(requestId: string, sessionId: string, window: number): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "auth_ok",
    requestId,
    sessionId,
    window,
  });
}

/** 自動承認する試験用サーバ（基本の echo/command 応答付き）。 */
function startAutoStub(overrides?: {
  sessionId?: string;
  window?: number;
}): Promise<{ port: number }> {
  const sessionId = overrides?.sessionId ?? PAIRING_DEFAULTS.sessionId;
  const window = overrides?.window ?? PAIRING_DEFAULTS.window;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "pairing_start") {
        socket.send(pairingPendingText({ sessionId }));
        setImmediate(() => {
          try {
            socket.send(authOkText(PAIRING_DEFAULTS.requestId, sessionId, window));
          } catch {
            // 閉塞後の送出失敗は無視する。
          }
        });
        return;
      }
      if (message.type === "echo") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId,
            streamId: message.streamId,
            kind: "reliable",
            seq: message.seq,
            requestId: message.requestId,
            payload: message.payload,
          }),
        );
      } else if (message.type === "command_request") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "command_response",
            sessionId,
            requestId: message.requestId,
            ok: message.command === "ping",
            ...(message.command === "ping"
              ? { result: "pong" }
              : { error: { code: "UNKNOWN_COMMAND", message: "unknown" } }),
          }),
        );
      } else if (message.type === "data") {
        // latest は受領のみで応答しない。
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({ port: address.port });
    });
  });
}

/** 承認の時期を試験側で操作できる試験用サーバ。 */
function startControllableStub(overrides?: {
  requestId?: string;
  code?: string;
  expiresInMs?: number;
  expiresAt?: number;
  sessionId?: string;
  window?: number;
}): Promise<{
  port: number;
  receivedStarts: string[];
  approve: () => void;
  sendError: (code: string, message: string, requestId?: string) => void;
  sendRaw: (text: string) => void;
  closeServerSide: (code?: number, reason?: string) => void;
}> {
  const requestId = overrides?.requestId ?? PAIRING_DEFAULTS.requestId;
  const code = overrides?.code ?? PAIRING_DEFAULTS.code;
  const expiresInMs = overrides?.expiresInMs ?? PAIRING_DEFAULTS.expiresInMs;
  const expiresAt = overrides?.expiresAt ?? PAIRING_DEFAULTS.expiresAt;
  const sessionId = overrides?.sessionId ?? PAIRING_DEFAULTS.sessionId;
  const window = overrides?.window ?? PAIRING_DEFAULTS.window;
  const receivedStarts: string[] = [];
  let active: WebSocket | null = null;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    active = socket;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "pairing_start") {
        receivedStarts.push(rawToText(data));
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "pairing_pending",
            requestId,
            code,
            expiresAt,
            expiresInMs,
          }),
        );
        return;
      }
      if (message.type === "echo") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId,
            streamId: message.streamId,
            kind: "reliable",
            seq: message.seq,
            requestId: message.requestId,
            payload: message.payload,
          }),
        );
      } else if (message.type === "command_request") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "command_response",
            sessionId,
            requestId: message.requestId,
            ok: message.command === "ping",
            ...(message.command === "ping"
              ? { result: "pong" }
              : { error: { code: "UNKNOWN_COMMAND", message: "unknown" } }),
          }),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({
        port: address.port,
        receivedStarts,
        approve: () => {
          if (active === null) throw new Error("接続前に承認はできない。");
          active.send(authOkText(requestId, sessionId, window));
        },
        sendError: (errorCode: string, message: string, errorRequestId?: string) => {
          if (active === null) throw new Error("接続前に失敗通知はできない。");
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "error",
              code: errorCode,
              message,
              ...(errorRequestId === undefined ? {} : { requestId: errorRequestId }),
            }),
          );
        },
        sendRaw: (text: string) => {
          if (active === null) throw new Error("接続前に送出はできない。");
          active.send(text);
        },
        closeServerSide: (closeCode = 1008, reason = "rejected") => {
          if (active === null) throw new Error("接続前に切断はできない。");
          active.close(closeCode, reason);
        },
      });
    });
  });
}

/** クレジットを付与しない試験用サーバ（送信待機の検証用）。 */
function startNoCreditStub(): Promise<{ port: number }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "pairing_start") {
        socket.send(pairingPendingText({}));
        setImmediate(() => {
          try {
            socket.send(authOkText(PAIRING_DEFAULTS.requestId, "session-nocredit", 0));
          } catch {
            // 閉塞後の送出失敗は無視する。
          }
        });
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({ port: address.port });
    });
  });
}

/** 補充の時期を試験側で操作できる試験用サーバ（累積 limit 方式）。 */
function startCreditControlStub(initialWindow = 0): Promise<{
  port: number;
  receivedEchoes: Array<{ streamId: string; seq: number; requestId: string }>;
  grantLimit: (limit: number, sessionId?: string) => void;
}> {
  const receivedEchoes: Array<{ streamId: string; seq: number; requestId: string }> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let active: WebSocket | null = null;
  server.on("connection", (socket: WebSocket) => {
    active = socket;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "pairing_start") {
        socket.send(pairingPendingText({}));
        setImmediate(() => {
          try {
            socket.send(authOkText(PAIRING_DEFAULTS.requestId, "session-credit", initialWindow));
          } catch {
            // 閉塞後の送出失敗は無視する。
          }
        });
        return;
      }
      if (message.type === "echo") {
        receivedEchoes.push({
          streamId: message.streamId,
          seq: message.seq,
          requestId: message.requestId,
        });
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId: "session-credit",
            streamId: message.streamId,
            kind: "reliable",
            seq: message.seq,
            requestId: message.requestId,
            payload: message.payload,
          }),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({
        port: address.port,
        receivedEchoes,
        grantLimit: (limit: number, sessionId = "session-credit") => {
          if (active === null) throw new Error("接続前に補充はできない。");
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "credit",
              sessionId,
              limit,
            }),
          );
        },
      });
    });
  });
}

/** 連番を厳密に検証する試験用サーバ（ブリッジの UNEXPECTED_SEQ 相当）。 */
function startStrictCreditStub(initialWindow = 0): Promise<{
  port: number;
  received: Array<{ kind: string; streamId: string; seq: number; requestId: string }>;
  unexpectedSeq: Array<{ streamId: string; seq: number; requestId: string }>;
  grantLimit: (limit: number, sessionId?: string) => void;
}> {
  const received: Array<{ kind: string; streamId: string; seq: number; requestId: string }> = [];
  const unexpectedSeq: Array<{ streamId: string; seq: number; requestId: string }> = [];
  const expectedSeq = new Map<string, number>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let active: WebSocket | null = null;
  server.on("connection", (socket: WebSocket) => {
    active = socket;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "pairing_start") {
        socket.send(pairingPendingText({}));
        setImmediate(() => {
          try {
            socket.send(authOkText(PAIRING_DEFAULTS.requestId, "session-strict", initialWindow));
          } catch {
            // 閉塞後の送出失敗は無視する。
          }
        });
        return;
      }
      if (message.type === "echo" || message.type === "command_request") {
        const expected = expectedSeq.get(message.streamId) ?? 0;
        if (message.seq !== expected) {
          // ブリッジと同様に連番の飛びを明示エラーにし、期待値は進めない。
          unexpectedSeq.push({
            streamId: message.streamId,
            seq: message.seq,
            requestId: message.requestId,
          });
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "error",
              code: "UNEXPECTED_SEQ",
              message: "連番が期待値と一致しない。",
              sessionId: "session-strict",
              requestId: message.requestId,
            }),
          );
          return;
        }
        expectedSeq.set(message.streamId, expected + 1);
        received.push({
          kind: message.type,
          streamId: message.streamId,
          seq: message.seq,
          requestId: message.requestId,
        });
        if (message.type === "echo") {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "echo_response",
              sessionId: "session-strict",
              streamId: message.streamId,
              kind: "reliable",
              seq: message.seq,
              requestId: message.requestId,
              payload: message.payload,
            }),
          );
        } else {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "command_response",
              sessionId: "session-strict",
              requestId: message.requestId,
              ok: true,
              result: "pong",
            }),
          );
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({
        port: address.port,
        received,
        unexpectedSeq,
        grantLimit: (limit: number, sessionId = "session-strict") => {
          if (active === null) throw new Error("接続前に補充はできない。");
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "credit",
              sessionId,
              limit,
            }),
          );
        },
      });
    });
  });
}

/** 記録中の command_request 送出件数を数える。送出はすべて正規の JSON のため直接読む。 */
function countCommandSends(sentTexts: string[]): number {
  return sentTexts.filter((text) => JSON.parse(text).type === "command_request").length;
}

/** 受信が起きないことを有限時間で確かめる。送出されていたら即失敗する。 */
async function expectNoEcho(
  receivedEchoes: Array<{ streamId: string; seq: number; requestId: string }>,
  timeoutMs = 100,
): Promise<void> {
  const baseline = receivedEchoes.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (receivedEchoes.length > baseline) {
      throw new Error("補充前に送出されており待機していない。");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(receivedEchoes).toHaveLength(baseline);
}

/** クライアントが開くソケットの実行時型。宣言上の DOM 型ではなく実物の型で受ける。 */
type ProbedSocket = InstanceType<typeof globalThis.WebSocket>;

/** クライアントが開くソケットを捕捉する。送受信の観測を時刻待ちなしで確定させるため。 */
function installSocketProbe(): {
  seen: ProbedSocket[];
  restore: () => void;
} {
  const RealWebSocket = globalThis.WebSocket;
  const seen: ProbedSocket[] = [];
  class ProbeWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      seen.push(this);
    }
  }
  globalThis.WebSocket = ProbeWebSocket;
  return {
    seen,
    restore: () => {
      globalThis.WebSocket = RealWebSocket;
    },
  };
}

/**
 * 指定 limit の credit をクライアント側ソケットが受けた時点で解決する。
 * 試験の待受はクライアントの受信処理より後に登録するため、解決時には
 * クライアントの会計更新が終わっている。時刻待ちに依存しない。
 */
function waitForClientCredit(socket: ProbedSocket, limit: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMessage = (event: Event): void => {
      // 実行時型の差異に依存しないよう、data の有無で読み分ける。
      const data: unknown = "data" in event ? event.data : undefined;
      if (typeof data !== "string") return;
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== "object" || parsed === null) return;
      if (!("type" in parsed) || !("limit" in parsed)) return;
      if (parsed.type === "credit" && parsed.limit === limit) {
        socket.removeEventListener("message", onMessage);
        resolve();
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

/**
 * クライアント側ソケットの送出文字列を記録する。
 * 送信要求が即時送出されたか待機に積まれたかを、呼び出し直後に
 * 同期的・確定的に判定するため。時刻待ちに依存しない。
 */
function recordClientSends(socket: ProbedSocket): {
  sentTexts: string[];
  restore: () => void;
} {
  const sentTexts: string[] = [];
  const originalSend = socket.send.bind(socket);
  // 実運用で送るのは文字列化した JSON のみであり、引数の型は実物の send と同一にする。
  function patchedSend(data: Parameters<ProbedSocket["send"]>[0]): void {
    if (typeof data === "string") sentTexts.push(data);
    originalSend(data);
  }
  socket.send = patchedSend;
  return {
    sentTexts,
    restore: () => {
      socket.send = originalSend;
    },
  };
}

/** 記録中の echo 送出件数を数える。送出はすべて正規の JSON のため直接読む。 */
function countEchoSends(sentTexts: string[]): number {
  return sentTexts.filter((text) => JSON.parse(text).type === "echo").length;
}

/** 記録中の指定種別の最初の送出文字列を探す。送出はすべて正規の JSON のため直接読む。 */
function findSentText(sentTexts: string[], type: string): string | undefined {
  return sentTexts.find((text) => JSON.parse(text).type === type);
}

function countSentType(sentTexts: string[], type: string): number {
  return sentTexts.filter((text) => JSON.parse(text).type === type).length;
}

/** 比較コードの通知を `getPairing()` の成立で待つ。購読遅れでも表示できることを確かめる。 */
async function waitForPairing(client: WorldClient, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (client.getPairing() === null) {
    if (Date.now() > deadline) throw new Error("比較コードの通知を観測できない。");
    await sleep(10);
  }
}

test("開始送信・コード表示・承認成立で接続できる", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${controllable.port}/v1`,
    origin: "https://app.xrift.net",
  });
  clients.push(client);
  expect(client.protocolVersion).toBe(PROTOCOL_VERSION);

  const states: string[] = [];
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "state") states.push(event.state);
    if (event.kind === "pairing") pairings.push(event.pairing);
  });

  const pending = client.connect();
  await waitForPairing(client);
  // 購読が遅れても getPairing() で表示できる。
  const pairing = client.getPairing();
  expect(pairing?.requestId).toBe("pair-1");
  expect(pairing?.code).toBe("123456");
  expect(client.getState()).toBe("awaiting_approval");
  expect(pairings).toHaveLength(1);
  expect(pairings[0]).toEqual(pairing);

  // 承認で成功する。
  controllable.approve();
  const connected = await pending;
  expect(connected.requestId).toBe("pair-1");
  expect(connected.sessionId).toBe("session-stub");
  expect(client.getPairing()).toBeNull();
  expect(states).toEqual(["connecting", "requesting_pairing", "awaiting_approval", "authorized"]);
});

test("接続・承認・echo 往復・command・latest・切断ができる", async () => {
  const { port } = await startAutoStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    origin: "https://app.xrift.net",
  });
  clients.push(client);
  expect(client.protocolVersion).toBe(PROTOCOL_VERSION);

  const states: string[] = [];
  client.onEvent((event) => {
    if (event.kind === "state") states.push(event.state);
  });

  const connected = await client.connect();
  expect(connected.sessionId).toBe("session-stub");
  expect(connected.requestId).toBe("pair-1");
  expect(client.getState()).toBe("authorized");
  expect(client.getPairing()).toBeNull();
  expect(client.endpoint).toBe(`ws://127.0.0.1:${port}/v1`);

  const echoed = await client.sendEcho("main", { text: "hello" });
  expect(echoed.seq).toBe(0);
  expect(echoed.payload).toEqual({ text: "hello" });

  const second = await client.sendEcho("main", [1, 2]);
  expect(second.seq).toBe(1);

  const pong = await client.sendCommand("main", "ping");
  expect(pong.ok).toBe(true);
  expect(pong.result).toBe("pong");

  const failure = await client.sendCommand("main", "explode");
  expect(failure.ok).toBe(false);

  const seq = client.sendLatest("pose", { x: 1 });
  expect(seq).toBe(0);
  expect(client.getLatestSent("pose")).toEqual({ x: 1 });
  client.sendLatest("pose", { x: 2 });
  expect(client.getLatestSent("pose")).toEqual({ x: 2 });

  client.close();
  expect(client.getState()).toBe("closed");
  expect(states).toContain("connecting");
  expect(states).toContain("requesting_pairing");
  expect(states).toContain("awaiting_approval");
  expect(states).toContain("authorized");
  expect(states).not.toContain("authenticating");
});

test("pairing_start を1回だけ送りコード発行では確定しない", async () => {
  const { seen, restore } = installSocketProbe();
  try {
    const controllable = await startControllableStub();
    const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
    clients.push(client);
    const socketPromise = (async () => {
      const pending = client.connect();
      await waitForPairing(client);
      return pending;
    })();
    await waitForPairing(client);
    const socket = seen[0];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);
    // 記録開始後の追加送出がないことではなく、開始メッセージが1回であることを数える。
    // 記録は途中からのため、サーバ側の受信件数で1回性を確かめる。
    await sleep(30);
    expect(controllable.receivedStarts).toHaveLength(1);
    expect(JSON.parse(controllable.receivedStarts[0] ?? "").type).toBe("pairing_start");
    void sentTexts;
    // コード発行段階では connect が未確定である。
    let settled: string | null = null;
    void socketPromise.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await sleep(50);
    expect(settled).toBeNull();
    expect(client.getPairing()).not.toBeNull();
    // 承認で確定する。
    controllable.approve();
    const result = await socketPromise;
    expect(result.sessionId).toBe("session-stub");
    expect(result.requestId).toBe("pair-1");
    expect(client.getPairing()).toBeNull();
  } finally {
    restore();
  }
});

test("pairing_start の送出は open 後の一回である", async () => {
  const { seen, restore } = installSocketProbe();
  try {
    const controllable = await startControllableStub();
    const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
    clients.push(client);
    const pending = client.connect();
    // ソケット生成直後に記録を仕掛け、open 前の送出がないことを含めて数える。
    // 生成の検出はポーリングで行い、時刻待ちの長さに依存しない。
    const deadline = Date.now() + 3_000;
    while (seen.length === 0) {
      if (Date.now() > deadline) throw new Error("ソケット生成を観測できない。");
      await sleep(5);
    }
    const socket = seen[0];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);
    await waitForPairing(client);
    await sleep(30);
    expect(countSentType(sentTexts, "pairing_start")).toBe(1);
    controllable.approve();
    await pending;
  } finally {
    restore();
  }
});

test("コード受信前の timeoutMs を過ぎると失敗する", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", () => {
    // 何も送らずコード通知を遅延させる。
  });
  const port = await new Promise<number>((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("待ち受け失敗。");
      resolve(address.port);
    });
  });
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
  clients.push(client);
  await expect(client.connect({ timeoutMs: 80 })).rejects.toMatchObject({
    code: "CONNECT_TIMEOUT",
  });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
});

test("コード受信後は人間の承認待ちを timeoutMs で打ち切らない", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect({ timeoutMs: 80 });
  await waitForPairing(client);
  // コード受信でタイマー解除済みのため、元の timeoutMs を過ぎても待機が続く。
  await sleep(150);
  expect(client.getState()).toBe("awaiting_approval");
  expect(client.getPairing()).not.toBeNull();
  controllable.approve();
  const result = await pending;
  expect(result.sessionId).toBe("session-stub");
});

test("承認応答の watchdog で APPROVAL_RESPONSE_TIMEOUT になる", async () => {
  const controllable = await startControllableStub({ expiresInMs: 80 });
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${controllable.port}/v1`,
    requestTimeoutMs: 50,
  });
  clients.push(client);
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
  });
  // watchdog は expiresInMs(80) + requestTimeoutMs(50) = 130ms である。
  await expect(client.connect()).rejects.toMatchObject({
    code: "APPROVAL_RESPONSE_TIMEOUT",
  });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
  expect(pairings[pairings.length - 1]).toBeNull();
});

test("AbortSignal の取消は CONNECT_CANCELLED になる", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
  });
  const controller = new AbortController();
  const pending = client.connect({ signal: controller.signal });
  await waitForPairing(client);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CONNECT_CANCELLED" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
  expect(pairings[pairings.length - 1]).toBeNull();
});

test("承認待ちの close() は CONNECTION_CLOSED で拒否する", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
  });
  const pending = client.connect();
  await waitForPairing(client);
  client.close();
  await expect(pending).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
  expect(pairings[pairings.length - 1]).toBeNull();
});

test("進行中と認可済みの再 connect は拒否する", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect();
  await waitForPairing(client);
  await expect(client.connect()).rejects.toMatchObject({ code: "ALREADY_CONNECTING" });
  controllable.approve();
  await pending;
  await expect(client.connect()).rejects.toMatchObject({ code: "ALREADY_CONNECTED" });
});

test("未認証では業務送信できない", async () => {
  const { port } = await startAutoStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
  clients.push(client);
  await expect(client.sendEcho("main", "x")).rejects.toMatchObject({
    code: "NOT_AUTHORIZED",
  });
  await expect(client.sendCommand("main", "ping")).rejects.toMatchObject({
    code: "NOT_AUTHORIZED",
  });
  expect(() => client.sendLatest("main", "x")).toThrow(WorldClientError);
});

test("承認前の業務送信は待機せず拒否する", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect();
  await waitForPairing(client);
  await expect(client.sendEcho("main", "x")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  await expect(client.sendCommand("main", "ping")).rejects.toMatchObject({
    code: "NOT_AUTHORIZED",
  });
  expect(() => client.sendLatest("main", "x")).toThrow(WorldClientError);
  controllable.approve();
  await pending;
});

test("認可前の業務応答は終了扱いになる", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect();
  await waitForPairing(client);
  controllable.sendRaw(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "echo_response",
      sessionId: "session-stub",
      streamId: "main",
      kind: "reliable",
      seq: 0,
      requestId: crypto.randomUUID(),
      payload: "x",
    }),
  );
  await expect(pending).rejects.toMatchObject({ code: "UNEXPECTED_MESSAGE" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
});

test("認可前の credit は終了扱いになる", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect();
  await waitForPairing(client);
  controllable.sendRaw(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "credit",
      sessionId: "session-stub",
      limit: 10,
    }),
  );
  await expect(pending).rejects.toMatchObject({ code: "UNEXPECTED_MESSAGE" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
});

test("異なる要求の auth_ok は拒否する", async () => {
  const controllable = await startControllableStub({ requestId: "pair-1" });
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect();
  await waitForPairing(client);
  controllable.sendRaw(authOkText("pair-other", "session-stub", 16));
  await expect(pending).rejects.toMatchObject({ code: "UNEXPECTED_MESSAGE" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
});

test("重複するコード通知は拒否する", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pending = client.connect();
  await waitForPairing(client);
  controllable.sendRaw(pairingPendingText({}));
  await expect(pending).rejects.toMatchObject({ code: "UNEXPECTED_MESSAGE" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
});

test("ブリッジの拒否は connect の失敗として返す", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
  });
  const pending = client.connect();
  await waitForPairing(client);
  controllable.sendError("PAIRING_REJECTED", "人間が拒否した。", "pair-1");
  await expect(pending).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
  expect(pairings[pairings.length - 1]).toBeNull();
});

test("サーバ切断で比較コード表示が消える", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
  });
  const pending = client.connect();
  await waitForPairing(client);
  expect(client.getPairing()).not.toBeNull();
  controllable.closeServerSide(1008, "closed by bridge");
  await expect(pending).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  expect(client.getPairing()).toBeNull();
  expect(pairings[pairings.length - 1]).toBeNull();
  expect(client.getState()).toBe("closed");
});

test("承認成立で比較コード表示が消える", async () => {
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pairings: Array<unknown> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
  });
  const pending = client.connect();
  await waitForPairing(client);
  expect(client.getPairing()).not.toBeNull();
  controllable.approve();
  await pending;
  expect(client.getPairing()).toBeNull();
  expect(pairings[pairings.length - 1]).toBeNull();
});

test("開始直後に拒否された接続は失敗として返す", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", () => {
      socket.close(1008, "unauthorized");
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("待ち受け失敗。");
      resolve(address.port);
    });
  });
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
  clients.push(client);
  await expect(client.connect()).rejects.toBeInstanceOf(WorldClientError);
  expect(client.getState()).toBe("closed");
});

test("クレジット枯渇時は待機し満杯で明示エラーにする", async () => {
  const { port } = await startNoCreditStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    maxPendingReliable: 1,
  });
  clients.push(client);
  await client.connect();

  // 応答が来ないため待機に入る。2件目は上限で明示エラーになる。
  const first = client.sendEcho("main", "a");
  await expect(client.sendEcho("main", "b")).rejects.toMatchObject({
    code: "LOCAL_QUEUE_FULL",
  });
  client.close();
  await expect(first).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
});

test("累積limitで待機と送出を制御し応答だけでは回復しない", async () => {
  // 初期付与 0 で待機に入り、累積 limit の通知ごとに権利分だけが送出される。
  // 応答の受信だけでは次が送出されず、同じ limit の再通知も追加付与にならない。
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(client);
  await client.connect();

  // 3件を積んでも付与がなければ送出されない（送信履歴で境界を取る）。
  const first = client.sendEcho("main", "a");
  const second = client.sendEcho("main", "b");
  const third = client.sendEcho("main", "c");
  await expectNoEcho(receivedEchoes);

  // limit 1 で1件だけ送出される。応答が返っても次は送出されない。
  grantLimit(1);
  const echoedFirst = await first;
  expect(echoedFirst.seq).toBe(0);
  expect(echoedFirst.payload).toBe("a");
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0]);
  await expectNoEcho(receivedEchoes);

  // limit 2 で次の1件が送出される。3件目は送出されない。
  grantLimit(2);
  const echoedSecond = await second;
  expect(echoedSecond.seq).toBe(1);
  await expectNoEcho(receivedEchoes);
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0, 1]);

  // 同じ limit の再通知は追加付与にならない。
  grantLimit(2);
  await expectNoEcho(receivedEchoes);

  // limit 3 で残りが送出される。
  grantLimit(3);
  const echoedThird = await third;
  expect(echoedThird.seq).toBe(2);
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0, 1, 2]);
});

test("未消費の付与残は追加通知なく使える", async () => {
  // 先にまとめて付与すると、通知を待たず連続送出できる。
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(client);
  await client.connect();
  grantLimit(3);
  const results = await Promise.all([
    client.sendEcho("main", "a"),
    client.sendEcho("main", "b"),
    client.sendEcho("main", "c"),
  ]);
  expect(results.map((result) => result.seq)).toEqual([0, 1, 2]);
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0, 1, 2]);
});

test("セッション不一致のcreditは会計へ適用しない", async () => {
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(client);
  await client.connect();

  const pending = client.sendEcho("main", "a");
  await expectNoEcho(receivedEchoes);
  // 別セッションの大きな付与は無視される。
  grantLimit(99, "session-other");
  await expectNoEcho(receivedEchoes);
  // 正規セッションの付与で送出される。
  grantLimit(1);
  const echoed = await pending;
  expect(echoed.payload).toBe("a");
  expect(receivedEchoes).toHaveLength(1);
});

test("切断で会計をリセットし再接続で作り直す", async () => {
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub();
  const first = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(first);
  await first.connect();
  grantLimit(1);
  const echoed = await first.sendEcho("main", "a");
  expect(echoed.seq).toBe(0);
  // 付与を使い切った状態で閉じる。
  first.close();
  expect(first.getState()).toBe("closed");

  // 再接続は初期付与 0 から始まり、旧接続の消費を引き継がない。
  const second = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(second);
  await second.connect();
  const pending = second.sendEcho("main", "b");
  const baseline = receivedEchoes.length;
  await expectNoEcho(receivedEchoes);
  expect(receivedEchoes).toHaveLength(baseline);
  // 新接続の付与 1 で1件送出できる（旧消費 1 を引き継いでいたら送出されない）。
  grantLimit(1);
  const echoedSecond = await pending;
  expect(echoedSecond.payload).toBe("b");
});

test("不正な endpoint では生成できない", () => {
  expect(() => createWorldClient({ endpoint: "ws://localhost:3100/v1" })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint: "" })).toThrow(RangeError);
});

test("close直後の同一インスタンス再接続が旧ソケットのcloseに壊されず成立する", async () => {
  // 旧ソケットの close が新接続の接続処理中に届いても現行接続を壊さない。
  // 新旧ソケットを生成順で特定し、旧 close の到達をイベントで待つ（時間待ちに依存しない）。
  const { port } = await startAutoStub();
  const RealWebSocket = globalThis.WebSocket;
  const seen: InstanceType<typeof RealWebSocket>[] = [];
  class ProbeWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      seen.push(this);
    }
  }
  globalThis.WebSocket = ProbeWebSocket;
  try {
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      origin: "https://app.xrift.net",
    });
    clients.push(client);
    const closedEvents: Array<{ code: number; reason: string }> = [];
    client.onEvent((event) => {
      if (event.kind === "closed") closedEvents.push({ code: event.code, reason: event.reason });
    });

    await client.connect();
    expect(seen).toHaveLength(1);
    const oldSocket = seen[0];
    if (oldSocket === undefined) throw new Error("旧ソケットを特定できない。");
    // close() より前に旧 close の到達待ちを仕掛ける。成功判定は時間待ちではなく通知到達で確定する。
    const oldClosed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("旧ソケットの close 到達を観測できない。"));
      }, 3_000);
      oldSocket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    client.close();
    expect(client.getState()).toBe("closed");
    // 待機を挟まず直ちに同一インスタンスで再接続する。
    const second = client.connect();
    const result = await second;
    expect(result.sessionId).toBe("session-stub");
    // 旧 close の到達後も現行接続が壊れていない。
    await oldClosed;
    expect(client.getState()).toBe("authorized");
    const echoed = await client.sendEcho("main", "after-reconnect");
    expect(echoed.payload).toBe("after-reconnect");
    // 余計な closed 通知が出ていない（close() の1回のみ）。
    expect(closedEvents).toHaveLength(1);
  } finally {
    globalThis.WebSocket = RealWebSocket;
    // 失敗時（旧 close が現行接続を壊した場合）に新ソケットが内部参照から
    // 外れて残っても、試験の後処理が止まらないよう直接閉じる。
    for (const ws of seen) {
      try {
        if (ws.readyState === RealWebSocket.OPEN || ws.readyState === RealWebSocket.CONNECTING) {
          ws.close(1000, "test cleanup");
        }
      } catch {
        // 後処理の閉塞失敗は無視する。
      }
    }
  }
});

test("減少したlimitは無視し付与済みの送信権を維持する", async () => {
  // limit=5 → 3件送出 → limit=2 の減少通知 → 残り2件を送出できる。
  // 累積5件の使い切り後は送らず、limit=6 で1件だけ再開する。
  // 減少通知の処理完了は通知到達で確定させてから後続送信を行う（時間待ちに依存しない）。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, receivedEchoes, grantLimit } = await startCreditControlStub(5);
    const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
    clients.push(client);
    await client.connect();
    const socket = seen[0];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    // 最初の3件は付与の範囲で送出される。
    const first = [
      client.sendEcho("main", "a"),
      client.sendEcho("main", "b"),
      client.sendEcho("main", "c"),
    ];
    expect(countEchoSends(sentTexts)).toBe(3);
    const firstResults = await Promise.all(first);
    expect(firstResults.map((result) => result.seq)).toEqual([0, 1, 2]);

    // 減少通知を送り、クライアント側の処理完了を通知到達で待つ。
    const decreased = waitForClientCredit(socket, 2);
    grantLimit(2);
    await decreased;

    // 減少前の上限を維持するため残り2件を送出できる。
    const restPromises = [client.sendEcho("main", "d"), client.sendEcho("main", "e")];
    expect(countEchoSends(sentTexts)).toBe(5);
    const rest = await Promise.all(restPromises);
    expect(rest.map((result) => result.seq)).toEqual([3, 4]);
    expect(receivedEchoes).toHaveLength(5);

    // 累積5件を使い切った後は6件目を送らない。
    const sixth = client.sendEcho("main", "f");
    expect(countEchoSends(sentTexts)).toBe(5);

    // limit=6 で1件だけ再開する。
    const regrown = waitForClientCredit(socket, 6);
    grantLimit(6);
    await regrown;
    expect(countEchoSends(sentTexts)).toBe(6);
    const sixthResult = await sixth;
    expect(sixthResult.seq).toBe(5);
    expect(receivedEchoes).toHaveLength(6);
  } finally {
    restore();
  }
});

test("auth_ok.windowより小さい最初のcreditも無視する", async () => {
  // 初期付与 3 に対し limit=1 の通知は会計を変更しない。3件を送出できる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, receivedEchoes, grantLimit } = await startCreditControlStub(3);
    const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
    clients.push(client);
    await client.connect();
    const socket = seen[0];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const shrunk = waitForClientCredit(socket, 1);
    grantLimit(1);
    await shrunk;

    // 初期付与の範囲で3件を送出できる（小さい最初の通知に引きずられない）。
    const sends = [
      client.sendEcho("main", "a"),
      client.sendEcho("main", "b"),
      client.sendEcho("main", "c"),
    ];
    expect(countEchoSends(sentTexts)).toBe(3);
    const results = await Promise.all(sends);
    expect(results.map((result) => result.seq)).toEqual([0, 1, 2]);
    expect(receivedEchoes).toHaveLength(3);
  } finally {
    restore();
  }
});

test("送信メッセージ上限のちょうどは受け付け＋1バイトは拒否する", async () => {
  // 境界バイト数は実送出から実測する（requestId の UUID 桁数は固定のため再現する）。
  // echo・command の双方で確認し、拒否後の通常要求で連番の継続も確かめる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port } = await startAutoStub();
    const endpoint = `ws://127.0.0.1:${port}/v1`;
    const origin = "https://app.xrift.net";
    const payload = { pad: "x".repeat(16) };

    const measurer = createWorldClient({ endpoint, origin });
    clients.push(measurer);
    await measurer.connect();
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    await measurer.sendEcho("main", payload);
    await measurer.sendCommand("main", "ping", payload);
    await measurer.sendCommand("main", "ping");
    await measurer.sendEcho("main", "after");
    const echoSample = findSentText(measured.sentTexts, "echo");
    const commandSample = findSentText(measured.sentTexts, "command_request");
    if (echoSample === undefined || commandSample === undefined) {
      throw new Error("送出の実測に失敗した。");
    }
    const echoBoundary = Buffer.byteLength(echoSample, "utf-8");
    const commandBoundary = Buffer.byteLength(commandSample, "utf-8");

    // 上限ちょうどは受け付ける（echo・command の双方）。
    const justEcho = createWorldClient({ endpoint, origin, maxMessageBytes: echoBoundary });
    clients.push(justEcho);
    await justEcho.connect();
    const fittedEcho = await justEcho.sendEcho("main", payload);
    expect(fittedEcho.seq).toBe(0);
    const justCommand = createWorldClient({ endpoint, origin, maxMessageBytes: commandBoundary });
    clients.push(justCommand);
    await justCommand.connect();
    const fittedCommand = await justCommand.sendCommand("main", "ping", payload);
    expect(fittedCommand.ok).toBe(true);

    // ＋1バイトは拒否する。切断せず、拒否後の通常要求は連番を詰めて通る。
    const overEcho = createWorldClient({ endpoint, origin, maxMessageBytes: echoBoundary - 1 });
    clients.push(overEcho);
    await overEcho.connect();
    await expect(overEcho.sendEcho("main", payload)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    expect(overEcho.getState()).toBe("authorized");
    const afterEcho = await overEcho.sendEcho("main", "after");
    expect(afterEcho.seq).toBe(0);

    const overCommand = createWorldClient({
      endpoint,
      origin,
      maxMessageBytes: commandBoundary - 1,
    });
    clients.push(overCommand);
    await overCommand.connect();
    await expect(overCommand.sendCommand("main", "ping", payload)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    const smallCommand = await overCommand.sendCommand("main", "ping");
    expect(smallCommand.ok).toBe(true);
    // 拒否した command が連番を消費していないため、同一ストリームの echo は seq=1 である。
    const afterCommandEcho = await overCommand.sendEcho("main", "after");
    expect(afterCommandEcho.seq).toBe(1);
  } finally {
    restore();
  }
});

test("多バイト文字は文字数ではなくUTF-8バイト数で判定する", async () => {
  // 「あ」は1文字3バイトのため、文字数基準なら収まりバイト基準なら超える cap で区別する。
  const { seen, restore } = installSocketProbe();
  try {
    const { port } = await startAutoStub();
    const endpoint = `ws://127.0.0.1:${port}/v1`;
    const origin = "https://app.xrift.net";
    const payload = { text: "あ".repeat(8) };

    const measurer = createWorldClient({ endpoint, origin });
    clients.push(measurer);
    await measurer.connect();
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    await measurer.sendEcho("main", payload);
    const sample = findSentText(measured.sentTexts, "echo");
    if (sample === undefined) throw new Error("送出の実測に失敗した。");
    const charLength = sample.length;
    const byteLength = Buffer.byteLength(sample, "utf-8");
    // 前提：多バイト文字を含むためバイト数は文字数を上回る。
    expect(byteLength).toBeGreaterThan(charLength);

    const byChars = createWorldClient({ endpoint, origin, maxMessageBytes: charLength });
    clients.push(byChars);
    await byChars.connect();
    await expect(byChars.sendEcho("main", payload)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });

    const byBytes = createWorldClient({ endpoint, origin, maxMessageBytes: byteLength });
    clients.push(byBytes);
    await byBytes.connect();
    const accepted = await byBytes.sendEcho("main", payload);
    expect(accepted.seq).toBe(0);
  } finally {
    restore();
  }
});

test("超過拒否はクレジット・待機枠・連番を消費しない", async () => {
  // 初期付与 1 で通常要求を使い、超過拒否を挟んで補充で再開する。
  // 送出件数の遷移を同期的・確定的に数え、応答連番で採番の継続を確かめる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, receivedEchoes, grantLimit } = await startCreditControlStub(1);
    const endpoint = `ws://127.0.0.1:${port}/v1`;

    const measurer = createWorldClient({ endpoint });
    clients.push(measurer);
    await measurer.connect();
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    await measurer.sendEcho("main", "ok");
    const sample = findSentText(measured.sentTexts, "echo");
    if (sample === undefined) throw new Error("送出の実測に失敗した。");
    const smallBytes = Buffer.byteLength(sample, "utf-8");
    // 計測用送出は試験対象外のため、以降の到達は差分で数える。
    const baselineEchoes = receivedEchoes.length;

    const client = createWorldClient({ endpoint, maxMessageBytes: smallBytes });
    clients.push(client);
    await client.connect();
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    // 通常要求で付与を使い切る。
    const first = await client.sendEcho("main", "ok");
    expect(first.seq).toBe(0);
    expect(countEchoSends(sentTexts)).toBe(1);

    // 超過要求は待機にも会計にも触れず拒否される。
    // 拒否は同期的に確定するため、マイクロタスクの消化だけで判定する（応答待ちにしない）。
    const bigSend = client.sendEcho("main", { pad: "x".repeat(1000) });
    let bigCode: string | null = null;
    void bigSend.then(
      () => {
        bigCode = "SENT";
      },
      (error: unknown) => {
        bigCode = error instanceof WorldClientError ? error.code : "UNKNOWN_ERROR";
      },
    );
    await Promise.resolve();
    expect(bigCode).toBe("MESSAGE_TOO_LARGE");
    expect(countEchoSends(sentTexts)).toBe(1);

    // 次の通常要求は待機に入り（送出されない）、補充で送出される。
    const second = client.sendEcho("main", "ok");
    expect(countEchoSends(sentTexts)).toBe(1);
    const regrown = waitForClientCredit(socket, 2);
    grantLimit(2);
    await regrown;
    expect(countEchoSends(sentTexts)).toBe(2);
    // 拒否が連番を消費していないため seq=1 である。
    const secondResult = await second;
    expect(secondResult.seq).toBe(1);
    expect(receivedEchoes).toHaveLength(baselineEchoes + 2);
  } finally {
    restore();
  }
});

test("超過拒否は送信待機枠を消費せず満杯判定を変えない", async () => {
  // 待機枠 1 を通常要求が占有した状態で、超過要求は寸法で拒否され、
  // 通常要求は従来どおり満杯で拒否される。
  const { port } = await startNoCreditStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    maxPendingReliable: 1,
    maxMessageBytes: 1024,
  });
  clients.push(client);
  await client.connect();

  const first = client.sendEcho("main", "a");
  await expect(client.sendEcho("main", { pad: "x".repeat(2048) })).rejects.toMatchObject({
    code: "MESSAGE_TOO_LARGE",
  });
  await expect(client.sendEcho("main", "b")).rejects.toMatchObject({
    code: "LOCAL_QUEUE_FULL",
  });
  client.close();
  await expect(first).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
});

test("latestの超過はローカル拒否し以降の送信を壊さない", async () => {
  const { seen, restore } = installSocketProbe();
  try {
    const { port } = await startAutoStub();
    const endpoint = `ws://127.0.0.1:${port}/v1`;
    const origin = "https://app.xrift.net";
    const payload = { x: 1 };

    const measurer = createWorldClient({ endpoint, origin });
    clients.push(measurer);
    await measurer.connect();
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    measurer.sendLatest("pose", payload);
    const sample = findSentText(measured.sentTexts, "data");
    if (sample === undefined) throw new Error("送出の実測に失敗した。");
    const boundary = Buffer.byteLength(sample, "utf-8");

    const client = createWorldClient({ endpoint, origin, maxMessageBytes: boundary });
    clients.push(client);
    await client.connect();
    // 上限ちょうどは受け付ける。
    expect(client.sendLatest("pose", payload)).toBe(0);
    expect(client.getLatestSent("pose")).toEqual(payload);

    // 超過は同期で拒否され、保持中の最新値は変わらない。
    let code: string | null = null;
    try {
      client.sendLatest("pose", { pad: "x".repeat(1000) });
    } catch (error) {
      expect(error).toBeInstanceOf(WorldClientError);
      if (error instanceof WorldClientError) code = error.code;
    }
    expect(code).toBe("MESSAGE_TOO_LARGE");
    expect(client.getLatestSent("pose")).toEqual(payload);

    // 直後の通常送信は連番を詰めて通る。
    expect(client.sendLatest("pose", { x: 2 })).toBe(1);
    expect(client.getLatestSent("pose")).toEqual({ x: 2 });
  } finally {
    restore();
  }
});

test("不正なmaxMessageBytesでは生成できない", () => {
  const endpoint = "ws://127.0.0.1:3100/v1";
  expect(() => createWorldClient({ endpoint, maxMessageBytes: 0 })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint, maxMessageBytes: -1 })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint, maxMessageBytes: 1.5 })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint, maxMessageBytes: Number.NaN })).toThrow(RangeError);
});

test("満杯拒否後のechoは連番を詰めて通り欠番しない", async () => {
  // 待機枠 1・初期付与 0 で満杯拒否を起こし、補充後に同一ストリームへ送る。
  // 拒否が連番を消費していると seq が飛び、厳密な受信側で UNEXPECTED_SEQ になる。
  // 何を通すかではなく採番の連続性を確かめる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, received, unexpectedSeq, grantLimit } = await startStrictCreditStub();
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      maxPendingReliable: 1,
    });
    clients.push(client);
    await client.connect();
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const first = client.sendEcho("main", "a");
    expect(countEchoSends(sentTexts)).toBe(0);
    await expect(client.sendEcho("main", "b")).rejects.toMatchObject({
      code: "LOCAL_QUEUE_FULL",
    });

    const granted = waitForClientCredit(socket, 1);
    grantLimit(1);
    await granted;
    const echoedFirst = await first;
    expect(echoedFirst.seq).toBe(0);

    const second = client.sendEcho("main", "c");
    const regrown = waitForClientCredit(socket, 2);
    grantLimit(2);
    await regrown;
    const echoedSecond = await second;
    // 拒否が連番を消費していなければ seq=1 で通り、欠番しない。
    expect(echoedSecond.seq).toBe(1);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(unexpectedSeq).toHaveLength(0);
  } finally {
    restore();
  }
});

test("満杯拒否後のcommandは連番を詰めて通り欠番しない", async () => {
  // echo と同じ不変条件を command でも確かめる。共有の流儀ではなく
  // API ごとの採番経路が対象である。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, received, unexpectedSeq, grantLimit } = await startStrictCreditStub();
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      maxPendingReliable: 1,
    });
    clients.push(client);
    await client.connect();
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const first = client.sendCommand("main", "ping");
    expect(countCommandSends(sentTexts)).toBe(0);
    await expect(client.sendCommand("main", "ping")).rejects.toMatchObject({
      code: "LOCAL_QUEUE_FULL",
    });

    const granted = waitForClientCredit(socket, 1);
    grantLimit(1);
    await granted;
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);

    const second = client.sendCommand("main", "ping");
    const regrown = waitForClientCredit(socket, 2);
    grantLimit(2);
    await regrown;
    const secondResult = await second;
    expect(secondResult.ok).toBe(true);
    // 拒否が連番を消費していなければ送出 seq は 0・1 で連続する。
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(unexpectedSeq).toHaveLength(0);
  } finally {
    restore();
  }
});

test("枯渇待機中の複数件は異なる増加連番で送出される", async () => {
  // 初期付与 0 で echo・command を待機させ、寸法拒否と満杯拒否を挟む。
  // 待機中の複数件が同一連番にならず、拒否後の送出も連続することを確かめる。
  // 受付時の採番確定が対象であり、送出順の保証ではない。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, received, unexpectedSeq, grantLimit } = await startStrictCreditStub();
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      maxPendingReliable: 4,
      maxMessageBytes: 256,
    });
    clients.push(client);
    await client.connect();
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const queuedEcho = client.sendEcho("main", "a");
    const queuedCommand = client.sendCommand("main", "ping");
    expect(countEchoSends(sentTexts)).toBe(0);
    expect(countCommandSends(sentTexts)).toBe(0);

    // 待機枠に空きがあっても寸法超過は MESSAGE_TOO_LARGE を優先する。
    await expect(client.sendEcho("main", { pad: "x".repeat(1000) })).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    await expect(
      client.sendCommand("main", "ping", { pad: "x".repeat(1000) }),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
    expect(countEchoSends(sentTexts)).toBe(0);
    expect(countCommandSends(sentTexts)).toBe(0);

    const granted = waitForClientCredit(socket, 2);
    grantLimit(2);
    await granted;
    // 受付時に確定した連番で送出され、同一連番の重複がない。
    const echoed = await queuedEcho;
    const commanded = await queuedCommand;
    expect(echoed.seq).toBe(0);
    expect(commanded.ok).toBe(true);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(unexpectedSeq).toHaveLength(0);

    // 拒否を挟んだ後の通常送信も連続する。
    const next = client.sendEcho("main", "b");
    const regrown = waitForClientCredit(socket, 3);
    grantLimit(3);
    await regrown;
    const echoedNext = await next;
    expect(echoedNext.seq).toBe(2);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(unexpectedSeq).toHaveLength(0);
  } finally {
    restore();
  }
});

test("状態通知中の close で stale な pairing を通知しない", async () => {
  // `awaiting_approval` への状態通知中に `close()` すると、決着・状態・保存が先に
  // 確定する（コード受信段階は未決着のため `CONNECTION_CLOSED` で拒否）。
  // その後に旧コードを再通知しないことを確かめる。
  const controllable = await startControllableStub();
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${controllable.port}/v1` });
  clients.push(client);
  const pairings: Array<unknown> = [];
  const states: string[] = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") pairings.push(event.pairing);
    if (event.kind === "state") {
      states.push(event.state);
      if (event.state === "awaiting_approval") {
        // 通知の最中に閉じる。再入による二重決着・stale 通知が対象である。
        client.close();
      }
    }
  });
  const pending = client.connect();
  await expect(pending).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  expect(client.getState()).toBe("closed");
  expect(client.getPairing()).toBeNull();
  // 非 null の stale な pairing（コード）が一度も出ていない。
  expect(pairings.filter((pairing) => pairing !== null)).toHaveLength(0);
  // close による null 通知は出る（表示の消去）。
  expect(pairings[pairings.length - 1]).toBeNull();
  expect(states).toContain("awaiting_approval");
  expect(states).toContain("closed");
});

test("通知中 close 後の再 connect で旧コード・旧タイマーが新試行へ作用しない", async () => {
  // 1試行目は短い watchdog（80+50=130ms）でコード "111111"、2試行目は長い有効期限で
  // コード "222222" を送る。試行IDで区別し、旧コード通知・旧タイマー発火が新試行へ
  // 作用しないことを確かめる。
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let connectionCount = 0;
  const activeSockets: WebSocket[] = [];
  server.on("connection", (socket: WebSocket) => {
    connectionCount += 1;
    const attemptNo = connectionCount;
    activeSockets.push(socket);
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type !== "pairing_start") return;
      if (attemptNo === 1) {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "pairing_pending",
            requestId: "pair-1",
            code: "111111",
            expiresAt: 9_999_999_999_999,
            expiresInMs: 80,
          }),
        );
      } else {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "pairing_pending",
            requestId: "pair-1",
            code: "222222",
            expiresAt: 9_999_999_999_999,
            expiresInMs: 120_000,
          }),
        );
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("待ち受け失敗。");
      resolve(address.port);
    });
  });
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    requestTimeoutMs: 50,
  });
  clients.push(client);
  const pairings: Array<{ code: string } | null> = [];
  client.onEvent((event) => {
    if (event.kind === "pairing") {
      const value = event.pairing;
      pairings.push(value === null ? null : { code: value.code });
    }
  });
  let reconnected: Promise<unknown> | null = null;
  let didReconnect = false;
  client.onEvent((event) => {
    if (event.kind === "state" && event.state === "awaiting_approval" && !didReconnect) {
      didReconnect = true;
      // 旧試行の状態通知の最中に閉じて直ちに再接続する。旧試行と新試行の区別が対象である。
      client.close();
      reconnected = client.connect();
    }
  });
  const first = client.connect();
  await expect(first).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  if (reconnected === null) throw new Error("再接続が始まらない。");
  const secondPending = reconnected as Promise<{ requestId: string; sessionId: string }>;
  // 新試行のコード表示を待つ（旧コード "111111" が出ていたら混入である）。
  const deadline = Date.now() + 3_000;
  while (client.getPairing()?.code !== "222222") {
    if (Date.now() > deadline) throw new Error("新試行のコード表示を観測できない。");
    await sleep(10);
  }
  // 旧コードは一度も通知されていない（試行IDで区別できている）。
  expect(pairings.some((pairing) => pairing?.code === "111111")).toBe(false);
  expect(pairings.some((pairing) => pairing?.code === "222222")).toBe(true);
  // 旧 watchdog（130ms）の期限を過ぎても新試行が壊れていない。
  await sleep(250);
  expect(client.getState()).toBe("awaiting_approval");
  expect(client.getPairing()?.code).toBe("222222");
  // 新試行を承認して成功させる。
  const secondSocket = activeSockets[1];
  if (secondSocket === undefined) throw new Error("新試行のソケットを特定できない。");
  secondSocket.send(authOkText("pair-1", "session-second", 16));
  const result = await secondPending;
  expect(result.sessionId).toBe("session-second");
  expect(client.getState()).toBe("authorized");
});

test("不正な timeoutMs は状態変更前に RangeError で拒否する", async () => {
  // 0を無期限扱いにせず、負・NaN・無限大・非整数・範囲外をソケット生成・状態変更の
  // 前に `RangeError` で拒否する。検証粒度は生成時の `requestTimeoutMs` と同じくする。
  const invalidValues = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2_147_483_648];
  for (const timeoutMs of invalidValues) {
    const { seen, restore } = installSocketProbe();
    try {
      const controllable = await startControllableStub();
      const client = createWorldClient({
        endpoint: `ws://127.0.0.1:${controllable.port}/v1`,
      });
      clients.push(client);
      const states: string[] = [];
      client.onEvent((event) => {
        if (event.kind === "state") states.push(event.state);
      });
      const socketsBefore = seen.length;
      await expect(client.connect({ timeoutMs })).rejects.toBeInstanceOf(RangeError);
      // ソケット生成・状態変更が行われていない。
      expect(seen).toHaveLength(socketsBefore);
      expect(states).toHaveLength(0);
      expect(client.getState()).toBe("disconnected");
      expect(client.getPairing()).toBeNull();
    } finally {
      restore();
    }
  }
});

test("長時間の expiresInMs でも分割タイマーで早期失敗せず承認できる", async () => {
  // `expiresInMs + requestTimeoutMs` がタイマー安全範囲を超える場合、単発の
  // `setTimeout` はオーバーフローして早期発火するため、期限再判定付きの分割で
  // 待ち、独自の短い上限で承認待ちを切り詰めないことを確かめる。
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  const setTimeoutSpy = ((...args: Parameters<typeof setTimeout>) => {
    const delay = args[1];
    if (typeof delay === "number") delays.push(delay);
    const original = originalSetTimeout as (
      ...call: Parameters<typeof setTimeout>
    ) => ReturnType<typeof setTimeout>;
    return original(...args);
  }) as typeof setTimeout;
  globalThis.setTimeout = setTimeoutSpy;
  try {
    const controllable = await startControllableStub({ expiresInMs: 3_000_000_000 });
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${controllable.port}/v1`,
      requestTimeoutMs: 50,
    });
    clients.push(client);
    const pending = client.connect();
    await waitForPairing(client);
    expect(client.getState()).toBe("awaiting_approval");
    // 初回分割はタイマー安全上限に切り詰められる（オーバーフローする巨大遅延を渡さない）。
    expect(delays.some((delay) => delay === 2_147_483_647)).toBe(true);
    expect(delays.every((delay) => delay <= 2_147_483_647)).toBe(true);
    // 長時間経路でも早期失敗しない。
    await sleep(200);
    expect(client.getState()).toBe("awaiting_approval");
    expect(client.getPairing()).not.toBeNull();
    controllable.approve();
    const result = await pending;
    expect(result.sessionId).toBe("session-stub");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("未決着 connect のタイマーは ref を維持し成功・終了時に解除する", async () => {
  // watchdog（5050ms）に他と重ならない遅延を使い、捕捉したハンドルで ref 維持と
  // 成功時解除を確かめる。`unref` しないことが契約である。
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const created = new Map<unknown, number>();
  const cleared = new Set<unknown>();
  let unrefCalled = false;
  const setTimeoutSpy = ((...args: Parameters<typeof setTimeout>) => {
    const original = originalSetTimeout as (
      ...call: Parameters<typeof setTimeout>
    ) => ReturnType<typeof setTimeout>;
    const handle = original(...args);
    const delay = args[1];
    if (typeof delay === "number") created.set(handle, delay);
    // `unref` 呼び出しを検出する。ブラウザの数値ハンドルには存在しないため分岐する。
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      const target = handle as { unref: (...args: never[]) => unknown };
      const originalUnref = target.unref.bind(target);
      target.unref = ((...call: never[]) => {
        unrefCalled = true;
        return originalUnref(...call);
      }) as typeof target.unref;
    }
    return handle;
  }) as typeof setTimeout;
  const clearTimeoutSpy = ((...args: Parameters<typeof clearTimeout>) => {
    cleared.add(args[0]);
    const original = originalClearTimeout as (
      ...call: Parameters<typeof clearTimeout>
    ) => ReturnType<typeof clearTimeout>;
    return original(...args);
  }) as typeof clearTimeout;
  globalThis.setTimeout = setTimeoutSpy;
  globalThis.clearTimeout = clearTimeoutSpy;
  try {
    const controllable = await startControllableStub({ expiresInMs: 5_000 });
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${controllable.port}/v1`,
      requestTimeoutMs: 50,
    });
    clients.push(client);
    const pending = client.connect();
    await waitForPairing(client);
    // watchdog（5000+50=5050ms）のハンドルを特定する。
    const watchdogEntry = [...created.entries()].find(([, delay]) => delay === 5_050);
    if (watchdogEntry === undefined) throw new Error("watchdog タイマーを特定できない。");
    const [watchdogHandle] = watchdogEntry;
    // 既定で ref を維持する（`unref` しない）。
    if (typeof watchdogHandle === "object" && watchdogHandle !== null) {
      const refHandle = watchdogHandle as { hasRef?: () => boolean };
      if (typeof refHandle.hasRef === "function") {
        expect(refHandle.hasRef()).toBe(true);
      }
    }
    expect(unrefCalled).toBe(false);
    // 成功時に必ず解除する。
    controllable.approve();
    await pending;
    expect(cleared.has(watchdogHandle)).toBe(true);
    expect(unrefCalled).toBe(false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("同一インスタンスの再接続でストリーム連番が0から始まる", async () => {
  // 新接続のサーバ期待値は接続ごとに 0 始まりのため、旧接続の連番を引き継ぐと
  // UNEXPECTED_SEQ になる。新試行の開始で採番を作り直すことを確かめる。
  // スタブは受信 seq を応答に折り返すため、応答 seq が送信 seq と一致する。
  const { port } = await startAutoStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    origin: "https://app.xrift.net",
  });
  clients.push(client);
  await client.connect();
  const first = await client.sendEcho("main", "a");
  expect(first.seq).toBe(0);
  expect(client.sendLatest("pose", { x: 1 })).toBe(0);
  client.close();
  expect(client.getState()).toBe("closed");

  await client.connect();
  // 直近送信値の記録は接続をまたぐローカル記録として維持する。
  expect(client.getLatestSent("pose")).toEqual({ x: 1 });
  // 新接続では echo・latest ともに seq=0 から始まり、サーバの期待値と一致する。
  const second = await client.sendEcho("main", "b");
  expect(second.seq).toBe(0);
  const third = await client.sendEcho("main", "c");
  expect(third.seq).toBe(1);
  expect(client.sendLatest("pose", { x: 2 })).toBe(0);
  expect(client.getLatestSent("pose")).toEqual({ x: 2 });
});
