import { afterEach, expect, test } from "vite-plus/test";
import { connect } from "node:net";
import { WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  formatPairingCode,
  parseBridgeMessage,
  type BridgeMessage,
} from "bridge-protocol";
import { Connection, WsMessageStream, type Session } from "bridge-protocol/transport";
import type { WsMessageStreamOptions } from "bridge-protocol/transport";
import { createBridgeServer, type BridgeOptions, type BridgeServer } from "../src/server.ts";
import { NodeWsSocket } from "../src/node-socket.ts";
import { handleCommand } from "../src/index.ts";
import type { BridgeLogEvent } from "../src/log.ts";

const PROD_ORIGIN = "https://app.xrift.net";
const DEV_ORIGIN = "http://localhost:5173";

const servers: BridgeServer[] = [];
const sockets: WebSocket[] = [];
const muxConns: Connection[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // 終了済みは無視する。
    }
  }
  for (const conn of muxConns.splice(0)) {
    try {
      conn.terminate(new Error("片付け"));
    } catch {
      // 終端済みは無視する。
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

interface Captured {
  events: BridgeLogEvent[];
  logger: (event: BridgeLogEvent) => void;
}

function capture(): Captured {
  const events: BridgeLogEvent[] = [];
  return {
    events,
    logger: (event: BridgeLogEvent) => {
      events.push(event);
    },
  };
}

async function startServer(
  options?: Partial<BridgeOptions>,
  captured?: Captured,
): Promise<BridgeServer> {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: [PROD_ORIGIN, DEV_ORIGIN],
    ...options,
    ...(captured === undefined ? {} : { logger: captured.logger }),
  });
  servers.push(server);
  return server;
}

function createTestLogger(): WsMessageStreamOptions["log"] {
  const callable = (..._args: unknown[]): void => {};
  const log = callable as unknown as WsMessageStreamOptions["log"];
  (log as unknown as { error: (..._args: unknown[]) => void }).error = (
    ..._args: unknown[]
  ): void => {};
  (log as unknown as { trace: (..._args: unknown[]) => void }).trace = (
    ..._args: unknown[]
  ): void => {};
  (log as unknown as { enabled: boolean }).enabled = false;
  (log as unknown as { newScope: () => WsMessageStreamOptions["log"] }).newScope = () => log;
  return log;
}

/** text 受信値を文字列へ復元する（`isBinary` が偽の場合のみ使う）。 */
function textFrom(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

/**
 * 認可前テキストの継続購読器。
 *
 * 作成時点から text のみ集め、binary は保持列へ退避する（認可前 binary の
 * 検出と、切替直後の早期 binary の取りこぼし防止に使う）。
 */
class TextCollector {
  private readonly frames: string[] = [];
  readonly heldBinary: Uint8Array[] = [];
  private readonly waiters = new Set<() => void>();
  private closed: { code: number; reason: string } | null = null;
  private readonly closeWaiters = new Set<(value: { code: number; reason: string }) => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const bytes =
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : Buffer.isBuffer(data)
              ? new Uint8Array(data)
              : Array.isArray(data)
                ? new Uint8Array(Buffer.concat(data))
                : new Uint8Array((data as ArrayBuffer).slice(0));
        this.heldBinary.push(bytes);
      } else {
        this.frames.push(textFrom(data));
      }
      for (const notify of this.waiters) {
        notify();
      }
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString("utf-8") };
      for (const notify of this.closeWaiters) {
        const value = this.closed;
        if (value !== null) notify(value);
      }
      for (const notify of this.waiters) {
        notify();
      }
    });
  }

  private takeMatch(
    predicate: (message: BridgeMessage) => boolean,
  ): { raw: string; message: BridgeMessage } | null {
    for (let index = 0; index < this.frames.length; index += 1) {
      const raw = this.frames[index];
      if (raw === undefined) continue;
      let parsed: BridgeMessage;
      try {
        parsed = parseBridgeMessage(raw);
      } catch {
        throw new Error(`想定外の非準拠フレームを受信した: ${raw.slice(0, 200)}`);
      }
      if (predicate(parsed)) {
        this.frames.splice(0, index + 1);
        return { raw, message: parsed };
      }
    }
    return null;
  }

  async waitFor(
    predicate: (message: BridgeMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    const matched = this.takeMatch(predicate);
    if (matched !== null) return matched;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("応答待ちがタイムアウトした。");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(notify);
          resolve();
        }, remaining);
        const notify = (): void => {
          clearTimeout(timer);
          this.waiters.delete(notify);
          resolve();
        };
        this.waiters.add(notify);
      });
      const retry = this.takeMatch(predicate);
      if (retry !== null) return retry;
    }
  }

  async waitForErrorCode(
    code: string,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    return this.waitFor((message) => message.type === "error" && message.code === code, timeoutMs);
  }

  async waitForType(
    type: BridgeMessage["type"],
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    return this.waitFor((message) => message.type === type, timeoutMs);
  }

  async waitClose(timeoutMs = 3_000): Promise<{ code: number; reason: string }> {
    if (this.closed !== null) return this.closed;
    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.closeWaiters.delete(notify);
        reject(new Error("切断待ちがタイムアウトした。"));
      }, timeoutMs);
      const notify = (value: { code: number; reason: string }): void => {
        clearTimeout(timer);
        this.closeWaiters.delete(notify);
        resolve(value);
      };
      this.closeWaiters.add(notify);
    });
  }
}

function openRaw(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      url,
      origin === undefined ? [] : ({ origin } as unknown as string[]),
    );
    sockets.push(socket);
    socket.on("open", () => {
      resolve(socket);
    });
    socket.on("error", (error: Error) => {
      reject(error);
    });
  });
}

/** 接続直後から購読する送受信器を開く。 */
async function openCollected(
  url: string,
  origin: string,
): Promise<{ socket: WebSocket; collector: TextCollector }> {
  const socket = await openRaw(url, origin);
  const collector = new TextCollector(socket);
  return { socket, collector };
}

/** 条件成立まで有限時間で待つ。 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("条件待ちがタイムアウトした。");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pairingStartMessage(): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "pairing_start" });
}

/**
 * 開始→保留通知→承認→`auth_ok` の往復を行い、接続識別子を返す。
 *
 * ワールド画面の受信コードと管理側の保留コードが一致することも確かめる。
 */
async function authorizeCollected(
  server: BridgeServer,
  socket: WebSocket,
  collector: TextCollector,
): Promise<{ connectionId: string; requestId: string }> {
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(pending.message.expiresInMs).toBeGreaterThan(0);
  expect(Number.isInteger(pending.message.expiresInMs)).toBe(true);
  const pendingRequestId = pending.message.requestId;
  const pendingCode = pending.message.code;
  const listed = server.listPending().find((item) => item.requestId === pendingRequestId);
  if (listed === undefined) throw new Error("保留一覧に見えない。");
  // ワールド画面と管理画面のコードは一致すること。
  expect(listed.code).toBe(pendingCode);
  const approved = server.approvePairing(pendingRequestId, listed.code);
  expect(approved.status).toBe("APPROVED");
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  expect(ok.message.requestId).toBe(pendingRequestId);
  // 0.3 の `auth_ok` は `connectionId` を載せ、`window`・`sessionId` を載せない。
  expect(typeof ok.message.connectionId).toBe("string");
  expect("window" in ok.message).toBe(false);
  expect("sessionId" in ok.message).toBe(false);
  return { connectionId: ok.message.connectionId, requestId: pendingRequestId };
}

/** クライアント側 mux の束。 */
interface ClientMux {
  readonly raw: NodeWsSocket;
  readonly stream: WsMessageStream;
  readonly conn: Connection;
  readonly closes: Error[];
}

/**
 * 同一 WS 上でクライアント側 mux を開始する。
 *
 * `auth_ok` 受信後の binary（サーバ側の早期配送）を失わないよう、
 * 収集器の保持分を順序どおり戻し、以後の binary を適合へ流す。
 * 以後の text は想定外であり、試験側で検出できるよう保持する。
 */
function startClientMux(
  socket: WebSocket,
  collector: TextCollector,
  connectionId: string,
): ClientMux {
  const raw = new NodeWsSocket(socket);
  const stream = new WsMessageStream(raw, { direction: "outbound", log: createTestLogger() });
  const closes: Error[] = [];
  const conn = new Connection({
    transport: stream,
    role: "client",
    connectionId,
    onClose: (cause) => {
      closes.push(cause);
    },
  });
  muxConns.push(conn);
  for (const bytes of collector.heldBinary.splice(0, collector.heldBinary.length)) {
    raw.receiveBytes(bytes);
  }
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) return;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : Buffer.isBuffer(data)
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array((data as ArrayBuffer).slice(0));
    raw.receiveBytes(bytes);
  });
  return { raw, stream, conn, closes };
}

/** 認可から mux 開始までを一括で行う。 */
async function authorizeAndMux(
  server: BridgeServer,
  socket: WebSocket,
  collector: TextCollector,
): Promise<{ connectionId: string; requestId: string; mux: ClientMux }> {
  const auth = await authorizeCollected(server, socket, collector);
  const mux = startClientMux(socket, collector, auth.connectionId);
  return { ...auth, mux };
}

/** Session の受信 payload を集める。 */
function collectSession(session: Session): {
  payloads: unknown[];
  waitForCount(count: number, timeoutMs?: number): Promise<unknown[]>;
  waitForPayload(predicate: (payload: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
} {
  const payloads: unknown[] = [];
  const waiters = new Set<() => void>();
  session.onMessage((payload) => {
    payloads.push(payload);
    for (const notify of [...waiters]) {
      notify();
    }
  });
  return {
    payloads,
    async waitForCount(count: number, timeoutMs = 3_000): Promise<unknown[]> {
      const deadline = Date.now() + timeoutMs;
      while (payloads.length < count) {
        if (Date.now() >= deadline) throw new Error("Session 受信待ちがタイムアウトした。");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(notify);
            resolve();
          }, deadline - Date.now());
          const notify = (): void => {
            clearTimeout(timer);
            waiters.delete(notify);
            resolve();
          };
          waiters.add(notify);
        });
      }
      return [...payloads];
    },
    async waitForPayload(
      predicate: (payload: unknown) => boolean,
      timeoutMs = 3_000,
    ): Promise<unknown> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = payloads.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() >= deadline) throw new Error("Session 受信待ちがタイムアウトした。");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(notify);
            resolve();
          }, deadline - Date.now());
          const notify = (): void => {
            clearTimeout(timer);
            waiters.delete(notify);
            resolve();
          };
          waiters.add(notify);
        });
      }
    },
  };
}

/** Session 終端を1件待つ。 */
function waitSessionEnd(
  session: Session,
  timeoutMs = 3_000,
): Promise<{ kind: string; error?: Error }> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error("Session 終端待ちがタイムアウトした。"));
    }, timeoutMs);
    unsub = session.onEnd((end) => {
      clearTimeout(timer);
      unsub?.();
      resolve(end);
    });
  });
}

// ---------- 受付・ペアリングの基本 ----------

test("起動時は受付が閉じていてupgradeを拒否し開くと接続できる", async () => {
  const server = await startServer();
  expect(server.getAcceptance().state).toBe("closed");
  expect(server.listPending()).toEqual([]);
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  expect(server.getStats().upgradeRejected).toBe(1);
  expect(server.getStats().rejectionsByReason["ACCEPTANCE_CLOSED"]).toBe(1);

  const info = server.openAcceptance();
  expect(info.state).toBe("open");
  expect(server.getAcceptance().state).toBe("open");
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  expect(pending.message.type).toBe("pairing_pending");
});

test("受付開後のpairing_pending通知と承認後にauth_okが返る", async () => {
  const captured = capture();
  const server = await startServer({}, captured);
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(pending.message.code).toMatch(/^[0-9]{6}$/);
  expect(typeof pending.message.requestId).toBe("string");

  const listed = server.listPending();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.requestId).toBe(pending.message.requestId);
  const approved = server.approvePairing(pending.message.requestId, pending.message.code);
  expect(approved).toEqual({
    status: "APPROVED",
    connectionId: expect.any(String),
    origin: DEV_ORIGIN,
  });
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  expect(ok.message.requestId).toBe(pending.message.requestId);
  expect(typeof ok.message.connectionId).toBe("string");

  // 承認成功だけでは受付は閉じない。
  expect(server.getAcceptance().state).toBe("open");
  expect(server.getStats().pairingSuccess).toBe(1);

  // 比較コードがログに出ていない。
  const logged = JSON.stringify(captured.events);
  expect(logged).not.toContain(pending.message.code);
});

test("認可前のcreate_session・dataは拒否し業務状態を変えない", async () => {
  const server = await startServer();
  server.openAcceptance();
  const cases: Array<{ name: string; build: (connectionId: string) => string; code: string }> = [
    {
      name: "create_session",
      build: (connectionId: string) =>
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "create_session",
          connectionId,
          sessionId: "sess-1",
          kind: "reliable",
          direction: "bidirectional",
        }),
      code: "NOT_AUTHORIZED",
    },
    {
      name: "data",
      build: (connectionId: string) =>
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "data",
          connectionId,
          sessionId: "sess-1",
          payload: { x: 1 },
        }),
      code: "NOT_AUTHORIZED",
    },
  ];
  for (const target of cases) {
    const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
    const closed = collector.waitClose();
    socket.send(target.build("conn-1"));
    const error = await collector.waitForErrorCode(target.code);
    expect(error.message.type, target.name).toBe("error");
    const result = await closed;
    expect(result.code, target.name).toBe(1008);
  }
  expect(server.getStats().latestStored).toBe(0);
  expect(server.getLatest("sess-1")).toBeUndefined();
  expect(server.getStats().pairingSuccess).toBe(0);
  await waitForCondition(() => server.getConnectionCount() === 0);
});

test("認可前のbinaryは境界違反で終了する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const closed = collector.waitClose();
  socket.send(new Uint8Array([1, 2, 3]));
  const error = await collector.waitForErrorCode("UNEXPECTED_BINARY");
  expect(error.message.type).toBe("error");
  const result = await closed;
  expect(result.code).toBe(1008);
  await waitForCondition(() => server.getConnectionCount() === 0);
});

test("認証前のJSON不正・版不一致・逆方向メッセージは1回で終了する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const inputs: Array<{ name: string; raw: string; code: string }> = [
    { name: "json", raw: "not json", code: "INVALID_JSON" },
    {
      name: "version",
      raw: JSON.stringify({ v: "0.0.0", type: "pairing_start" }),
      code: "VERSION_MISMATCH",
    },
    {
      name: "reverse",
      raw: JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "auth_ok",
        requestId: "pairing-x",
        connectionId: "conn-x",
      }),
      code: "UNEXPECTED_DIRECTION",
    },
    {
      name: "unknown",
      raw: JSON.stringify({ v: PROTOCOL_VERSION, type: "mystery" }),
      code: "UNKNOWN_TYPE",
    },
  ];
  for (const input of inputs) {
    const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
    const closed = collector.waitClose();
    socket.send(input.raw);
    const error = await collector.waitForErrorCode(input.code);
    expect(error.message.type, input.name).toBe("error");
    const result = await closed;
    expect(result.code, input.name).toBe(1008);
    // 1回で終了するため保留は作られない。
    expect(server.listPending()).toHaveLength(0);
  }
  expect(server.getStats().pairingFailure).toBe(4);
});

test("2回目の開始はDUPLICATE_PAIRING_STARTで終了し再通知しない", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const closed = collector.waitClose();
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const firstRequestId = pending.message.requestId;
  socket.send(pairingStartMessage());
  const error = await collector.waitForErrorCode("DUPLICATE_PAIRING_START");
  expect(error.message.type).toBe("error");
  const result = await closed;
  expect(result.code).toBe(1008);
  // コード再生成・再通知・期限延長をしない。保留は終わっている。
  expect(server.listPending()).toHaveLength(0);
  expect(server.approvePairing(firstRequestId, pending.message.code).status).toBe("NOT_PENDING");
});

test("開始待ちは短縮期限でPAIRING_START_TIMEOUTになり切断する", async () => {
  const server = await startServer({ limits: { pairingStartTimeoutMs: 150 } });
  server.openAcceptance();
  const { collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const error = await collector.waitForErrorCode("PAIRING_START_TIMEOUT");
  expect(error.message.type).toBe("error");
  if (error.message.type === "error") {
    expect(error.message.requestId).toBeUndefined();
    expect(error.message.connectionId).toBeUndefined();
  }
  const result = await collector.waitClose();
  expect(result.code).toBe(1008);
  await waitForCondition(() => server.getConnectionCount() === 0);
});

// ---------- 上限・レート ----------

test("全接続数・未認可数・保留数の上限を同時に踏める（既定8・2・2）", async () => {
  const server = await startServer({
    limits: { maxPairingRequestsPerOrigin: 20, maxPairingRequestsTotal: 20 },
  });
  server.openAcceptance();
  // 6件を認可し、2件を開始待ちで保持する。全8・未認可2が満杯になる。
  const authorized: Array<{ socket: WebSocket; collector: TextCollector; mux: ClientMux }> = [];
  for (let index = 0; index < 6; index += 1) {
    const opened = await openCollected(server.endpoint, DEV_ORIGIN);
    const auth = await authorizeAndMux(server, opened.socket, opened.collector);
    authorized.push({ socket: opened.socket, collector: opened.collector, mux: auth.mux });
  }
  const first = await openCollected(server.endpoint, DEV_ORIGIN);
  const second = await openCollected(server.endpoint, DEV_ORIGIN);
  expect(server.getConnectionCount()).toBe(8);
  // 9件目は全接続数の上限で拒否される。
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  expect(server.getStats().rejectionsByReason["TOO_MANY_CONNECTIONS"]).toBe(1);
  // 未認可枠も満杯のため、開始待ちの3件目相当も拒否される。
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  expect(server.getConnectionCount()).toBe(8);
  // 1枠（開始待ち）を空けると未認可枠が回復する。
  first.socket.terminate();
  await waitForCondition(() => server.getConnectionCount() === 7);
  const retry = await openCollected(server.endpoint, DEV_ORIGIN);
  expect(server.getConnectionCount()).toBe(8);
  // 認可済みは診断 echo で業務を続けられる。
  const target = authorized[0];
  if (target === undefined) throw new Error("認可済みがない。");
  const session = await target.mux.conn.createSession({
    sessionId: "cap-ok",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(session);
  await session.sendReliable({ op: "echo", id: "cap-ok-1", value: { n: 1 } });
  const echoed = await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "echo",
  );
  expect(echoed).toEqual({ op: "echo", id: "cap-ok-1", value: { n: 1 } });
  second.socket.terminate();
  retry.socket.terminate();
  await waitForCondition(() => server.getConnectionCount() === 6);
});

test("保留超過は実際に踏みPENDING_FULLで終了する", async () => {
  const server = await startServer({
    limits: { maxPendingPairings: 1, maxUnauthorizedConnections: 2 },
  });
  server.openAcceptance();
  const first = await openCollected(server.endpoint, DEV_ORIGIN);
  const second = await openCollected(server.endpoint, DEV_ORIGIN);
  const secondClosed = second.collector.waitClose();
  first.socket.send(pairingStartMessage());
  const pending = await first.collector.waitForType("pairing_pending");
  expect(pending.message.type).toBe("pairing_pending");
  second.socket.send(pairingStartMessage());
  const error = await second.collector.waitForErrorCode("PENDING_FULL");
  expect(error.message.type).toBe("error");
  expect(await secondClosed).toMatchObject({ code: 1008 });
  // 先行の保留は影響を受けない。
  expect(server.listPending()).toHaveLength(1);
  const listed = server.listPending()[0];
  if (listed === undefined) throw new Error("保留がない。");
  expect(server.approvePairing(listed.requestId, listed.code).status).toBe("APPROVED");
  const ok = await first.collector.waitForType("auth_ok");
  expect(ok.message.type).toBe("auth_ok");
});

test("受付レート超過は429で拒否し履歴に追加しない", async () => {
  const server = await startServer({
    limits: {
      maxPairingRequestsPerOrigin: 2,
      maxPairingRequestsTotal: 3,
      maxUnauthorizedConnections: 8,
      maxConnections: 8,
    },
  });
  server.openAcceptance();
  await openRaw(server.endpoint, DEV_ORIGIN);
  await openRaw(server.endpoint, DEV_ORIGIN);
  // Origin 別の上限（2）を超える。
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  expect(server.getStats().rejectionsByReason["ORIGIN_RATE_LIMITED"]).toBe(1);
  // 拒否自体は履歴に追加しないため、別 Origin は全体上限（3）にまだ届く。
  await openRaw(server.endpoint, PROD_ORIGIN);
  await expect(openRaw(server.endpoint, PROD_ORIGIN)).rejects.toThrow();
  expect(server.getStats().rejectionsByReason["TOTAL_RATE_LIMITED"]).toBe(1);
});

test("HTTP状態は403・429・503を使い分ける", async () => {
  const readStatus = (port: number, payload: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(payload);
      });
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        if (buffer.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", (error: Error) => {
        reject(error);
      });
    });
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const build = (port: number, origin: string): string =>
    `GET /v1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`;

  // 受付閉は 403。
  const closed = await startServer();
  const closedResponse = await readStatus(closed.port, build(closed.port, DEV_ORIGIN));
  expect(closedResponse).toContain("403");

  // 受付レート超過は 429。
  const limited = await startServer({
    limits: {
      maxPairingRequestsPerOrigin: 1,
      maxPairingRequestsTotal: 1,
      maxUnauthorizedConnections: 8,
      maxConnections: 8,
    },
  });
  limited.openAcceptance();
  await openRaw(limited.endpoint, DEV_ORIGIN);
  const limitedResponse = await readStatus(limited.port, build(limited.port, DEV_ORIGIN));
  expect(limitedResponse).toContain("429");

  // 接続容量の超過は 503。
  const full = await startServer({
    limits: { maxConnections: 1, maxUnauthorizedConnections: 1, maxPendingPairings: 1 },
  });
  full.openAcceptance();
  await openRaw(full.endpoint, DEV_ORIGIN);
  const fullResponse = await readStatus(full.port, build(full.port, DEV_ORIGIN));
  expect(fullResponse).toContain("503");
});

// ---------- 失効・取消・再起動 ----------

test("拒否・取消で保留が失効し認可済みに影響しない", async () => {
  const server = await startServer();
  server.openAcceptance();
  const target = await openCollected(server.endpoint, DEV_ORIGIN);
  target.socket.send(pairingStartMessage());
  const pending = await target.collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const closed = target.collector.waitClose();

  const keeper = await openCollected(server.endpoint, DEV_ORIGIN);
  const keeperAuth = await authorizeAndMux(server, keeper.socket, keeper.collector);

  const rejected = server.rejectPairing(pending.message.requestId);
  expect(rejected).toEqual({ status: "REJECTED" });
  const error = await target.collector.waitForErrorCode("PAIRING_REJECTED");
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.requestId).toBe(pending.message.requestId);
  expect(await closed).toMatchObject({ code: 1008 });
  expect(server.listPending()).toHaveLength(0);
  expect(server.rejectPairing(pending.message.requestId)).toEqual({ status: "NOT_PENDING" });

  // 認可済みは影響なく診断 echo を続けられる。
  const session = await keeperAuth.mux.conn.createSession({
    sessionId: "keep-ok",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(session);
  await session.sendReliable({ op: "echo", id: "keep-ok-1", value: "ok" });
  await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "echo",
  );
});

test("切断で保留が失効し承認は未保留になる", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  socket.terminate();
  await waitForCondition(() => server.listPending().length === 0);
  expect(server.approvePairing(pending.message.requestId, pending.message.code)).toEqual({
    status: "NOT_PENDING",
  });
});

test("承認期限の到達で保留が失効し二度目の承認は未保留になる", async () => {
  const server = await startServer({ limits: { pairingApprovalTimeoutMs: 250 } });
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const closed = collector.waitClose();
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const error = await collector.waitForErrorCode("PAIRING_EXPIRED");
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.requestId).toBe(pending.message.requestId);
  expect(await closed).toMatchObject({ code: 1008 });
  expect(server.listPending()).toHaveLength(0);
  expect(server.approvePairing(pending.message.requestId, pending.message.code)).toEqual({
    status: "NOT_PENDING",
  });
  expect(server.getStats().rejectionsByReason["PAIRING_EXPIRED"]).toBeGreaterThanOrEqual(1);
});

test("二重承認は2回目が未保留になりコード不一致は保留を残す", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const wrong = pending.message.code === "000000" ? "111111" : "000000";
  expect(server.approvePairing(pending.message.requestId, wrong)).toEqual({
    status: "CODE_MISMATCH",
  });
  // 不一致では保留が残り、正しいコードで承認できる。
  expect(server.listPending()).toHaveLength(1);
  expect(server.approvePairing(pending.message.requestId, "12")).toEqual({
    status: "INVALID_CODE",
  });
  expect(server.listPending()).toHaveLength(1);
  const listed = server.listPending()[0];
  if (listed === undefined) throw new Error("保留がない。");
  expect(server.approvePairing(pending.message.requestId, listed.code).status).toBe("APPROVED");
  await collector.waitForType("auth_ok");
  // 二重承認は未保留になる。
  expect(server.approvePairing(pending.message.requestId, listed.code)).toEqual({
    status: "NOT_PENDING",
  });
  expect(server.getStats().pairingSuccess).toBe(1);
});

test("再起動で保留と認可は失効する", async () => {
  const first = await startServer();
  first.openAcceptance();
  const opened = await openCollected(first.endpoint, DEV_ORIGIN);
  opened.socket.send(pairingStartMessage());
  const pending = await opened.collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const keeper = await openCollected(first.endpoint, DEV_ORIGIN);
  await authorizeAndMux(first, keeper.socket, keeper.collector);
  const oldRequestId = pending.message.requestId;
  const oldCode = pending.message.code;
  await first.close();
  servers.splice(servers.indexOf(first), 1);

  const second = await startServer();
  expect(second.listPending()).toHaveLength(0);
  expect(second.getConnectionCount()).toBe(0);
  expect(second.getAcceptance().state).toBe("closed");
  // 前世代の要求 ID・コードは使えない。
  second.openAcceptance();
  expect(second.approvePairing(oldRequestId, oldCode)).toEqual({ status: "NOT_PENDING" });
});

// ---------- 受付クローズの drain ----------

test("受付クローズで開始待ち・承認待ちが終了し認可済みは維持される", async () => {
  const server = await startServer();
  server.openAcceptance();
  const keeper = await openCollected(server.endpoint, DEV_ORIGIN);
  // 先に認可して未認可枠を空けておく。
  const keeperAuth = await authorizeAndMux(server, keeper.socket, keeper.collector);

  const awaiting = await openCollected(server.endpoint, DEV_ORIGIN);
  const awaitingClosed = awaiting.collector.waitClose();

  const pendingConn = await openCollected(server.endpoint, DEV_ORIGIN);
  pendingConn.socket.send(pairingStartMessage());
  const pending = await pendingConn.collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const pendingClosed = pendingConn.collector.waitClose();

  server.closeAcceptance();
  expect(server.getAcceptance().state).toBe("closed");

  const awaitingError = await awaiting.collector.waitForErrorCode("ACCEPTANCE_CLOSED");
  expect(awaitingError.message.type).toBe("error");
  if (awaitingError.message.type === "error") {
    expect(awaitingError.message.requestId).toBeUndefined();
  }
  expect(await awaitingClosed).toMatchObject({ code: 1008 });

  const pendingError = await pendingConn.collector.waitForErrorCode("ACCEPTANCE_CLOSED");
  if (pendingError.message.type !== "error") throw new Error("明示エラーではない。");
  expect(pendingError.message.requestId).toBe(pending.message.requestId);
  expect(await pendingClosed).toMatchObject({ code: 1008 });

  expect(server.listPending()).toHaveLength(0);
  expect(server.approvePairing(pending.message.requestId, pending.message.code)).toEqual({
    status: "NOT_PENDING",
  });

  // 認可済みは維持され診断 echo を続けられる。
  const session = await keeperAuth.mux.conn.createSession({
    sessionId: "drain-keep",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(session);
  await session.sendReliable({ op: "echo", id: "drain-keep-1", value: 1 });
  await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "echo",
  );

  // 閉の冪等性。二度目の close でも認可済みは残る。
  server.closeAcceptance();
  const second = await keeperAuth.mux.conn.createSession({
    sessionId: "drain-keep2",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected2 = collectSession(second);
  await second.sendReliable({ op: "echo", id: "drain-keep-2", value: 2 });
  await collected2.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "echo",
  );
});

test("受付の自動クローズでも開始待ちは失効する", async () => {
  const server = await startServer({ limits: { acceptanceDurationMs: 250 } });
  server.openAcceptance();
  const { collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const closed = collector.waitClose();
  const error = await collector.waitForErrorCode("ACCEPTANCE_CLOSED");
  expect(error.message.type).toBe("error");
  expect(await closed).toMatchObject({ code: 1008 });
  expect(server.getAcceptance().state).toBe("closed");
  expect(server.listPending()).toHaveLength(0);
});

test("管理イベントで保留の増減と受付の開閉が分かる", async () => {
  const server = await startServer();
  const events: Array<{ kind: string; requestId?: string }> = [];
  const unsubscribe = server.onManagementEvent((event) => {
    if (event.kind === "pending-created" || event.kind === "pending-ended") {
      events.push({ kind: event.kind, requestId: event.requestId });
    } else {
      events.push({ kind: event.kind });
    }
  });
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  await waitForCondition(() => events.some((event) => event.kind === "pending-created"));
  const listed = server.listPending()[0];
  if (listed === undefined) throw new Error("保留がない。");
  server.approvePairing(listed.requestId, listed.code);
  await waitForCondition(() => events.some((event) => event.kind === "pending-ended"));
  server.closeAcceptance();
  expect(events.map((event) => event.kind)).toContain("acceptance-changed");
  unsubscribe();
});

// ---------- CLI ----------

/** 対話命令の表示先を集める試験用の出力先。 */
function captureOutput(): { output: string[]; out: { write(text: string): void } } {
  const output: string[] = [];
  return {
    output,
    out: {
      write: (text: string): void => {
        output.push(text);
      },
    },
  };
}

test("CLIでaccept open・pending・approve・reject・statusが動く", async () => {
  const server = await startServer({ generateCode: () => "000042" });
  const captured = captureOutput();
  const out = captured.out;
  handleCommand("accept open", server, out);
  expect(captured.output.join("")).toContain("state=open");

  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const cliRequestId = pending.message.requestId;
  // 先頭ゼロ保持の区切り表示。
  expect(formatPairingCode("000042")).toBe("000 042");
  handleCommand("pending", server, out);
  const pendingText = captured.output.join("");
  expect(pendingText).toContain(cliRequestId);
  expect(pendingText).toContain("000 042");
  expect(pendingText).toContain(DEV_ORIGIN);

  // 引数不足・書式不正は厳密に弾く。数値化で先頭ゼロを落とさない。
  handleCommand("approve", server, out);
  expect(captured.output.join("")).toContain("使い方: approve");
  handleCommand(`approve ${cliRequestId} 42`, server, out);
  expect(captured.output.join("")).toContain("approve 失敗");
  expect(server.listPending()).toHaveLength(1);

  handleCommand(`approve ${cliRequestId} 000042`, server, out);
  expect(captured.output.join("")).toContain(`approved ${cliRequestId}`);
  const ok = await collector.waitForType("auth_ok");
  expect(ok.message.type).toBe("auth_ok");

  handleCommand("status", server, out);
  const statusText = captured.output.join("");
  expect(statusText).toContain("acceptance=open");
  expect(statusText).toContain("authorized=1");
  expect(statusText).toContain("pairingSuccess=1");

  // 2件目を作って reject する。
  const second = await openCollected(server.endpoint, DEV_ORIGIN);
  second.socket.send(pairingStartMessage());
  const secondPending = await second.collector.waitForType("pairing_pending");
  if (secondPending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const secondRequestId = secondPending.message.requestId;
  handleCommand(`reject ${secondRequestId}`, server, out);
  expect(captured.output.join("")).toContain(`rejected ${secondRequestId}`);
  const rejectError = await second.collector.waitForErrorCode("PAIRING_REJECTED");
  expect(rejectError.message.type).toBe("error");

  handleCommand("accept close", server, out);
  expect(captured.output.join("")).toContain("state=closed");
  handleCommand("pending", server, out);
  expect(captured.output.join("")).toContain("pending: (none)");
  expect(handleCommand("quit", server, out)).toBe(true);
});

test("CLIのstatusは受付状態・各接続数・理由別拒否集計を出す", async () => {
  const server = await startServer();
  const captured = captureOutput();
  const out = captured.out;
  handleCommand("status", server, out);
  let text = captured.output.join("");
  expect(text).toContain("acceptance=closed");
  expect(text).toContain("connections=0");
  server.openAcceptance();
  handleCommand("status", server, out);
  text = captured.output.join("");
  expect(text).toContain("acceptance=open");
  // 拒否を1件起こすと集計に出る。
  await expect(openRaw(server.endpoint, "https://evil.example")).rejects.toThrow();
  handleCommand("status", server, out);
  text = captured.output.join("");
  expect(text).toContain("origin_rejected=1");
});

// ---------- 既存の検証 ----------

test("不許可・欠落・null の Origin を拒否する", async () => {
  const server = await startServer();
  await expect(openRaw(server.endpoint, "https://evil.example")).rejects.toThrow();
  await expect(openRaw(server.endpoint)).rejects.toThrow();
  await expect(openRaw(server.endpoint, "null")).rejects.toThrow();
  expect(server.getStats().upgradeRejected).toBe(3);
});

test("Host・path の不一致を拒否する", async () => {
  const server = await startServer();
  const readResponse = (payload: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write(payload);
      });
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        if (buffer.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", (error: Error) => {
        reject(error);
      });
    });
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const badHost = await readResponse(
    `GET /v1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${DEV_ORIGIN}\r\n\r\n`,
  );
  expect(badHost).toContain("403");
  const badPath = await readResponse(
    `GET /v2 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${DEV_ORIGIN}\r\n\r\n`,
  );
  expect(badPath).toContain("403");
});

test("loopback 以外に bind しない", async () => {
  const server = await startServer();
  expect(server.endpoint.startsWith("ws://127.0.0.1:")).toBe(true);
  expect(server.endpoint.endsWith("/v1")).toBe(true);
  await expect(
    createBridgeServer({ port: 0, host: "0.0.0.0", allowedOrigins: [PROD_ORIGIN] }),
  ).rejects.toThrow(RangeError);
});

test("ポート競合時は探索せず失敗する", async () => {
  const server = await startServer();
  await expect(
    createBridgeServer({ port: server.port, allowedOrigins: [PROD_ORIGIN] }),
  ).rejects.toThrow();
});

test("maxConnections は未認証接続も含めて上限拒否し切断後に枠が回復する", async () => {
  const server = await startServer({ limits: { maxConnections: 2 } });
  server.openAcceptance();
  const first = await openRaw(server.endpoint, DEV_ORIGIN);
  const second = await openRaw(server.endpoint, DEV_ORIGIN);
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  expect(server.getConnectionCount()).toBe(2);
  expect(server.getStats().upgradeRejected).toBeGreaterThanOrEqual(1);
  // 1枠を空けると回復する。
  first.terminate();
  await waitForCondition(() => server.getConnectionCount() === 1);
  const third = await openRaw(server.endpoint, DEV_ORIGIN);
  expect(server.getConnectionCount()).toBe(2);
  second.terminate();
  third.terminate();
  await waitForCondition(() => server.getConnectionCount() === 0);
});

test("handshake 未到達の予約は有限時間で回収され枠が回復する", async () => {
  // verify 通過後に `connection` へ到達しない handshake 失敗でも、予約が
  // 恒久に残らず有限時間で回収されることを確かめる。通常経路の消費と
  // 同時 upgrade の上限保証は従来どおりである。
  const server = await startServer({
    limits: {
      maxConnections: 1,
      maxUnauthorizedConnections: 1,
      maxPendingPairings: 1,
      pairingStartTimeoutMs: 60,
      maxPairingRequestsPerOrigin: 1000,
      maxPairingRequestsTotal: 1000,
    },
  });
  server.openAcceptance();
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  // upgrade 要求バイトと RST を続けて送り、`connection` 到達前の失敗経路
  // （予約だけが残る）を誘発する。読み取りは行わない。
  const poison = async (): Promise<void> => {
    const socket = connect(server.port, "127.0.0.1", () => {
      socket.write(
        `GET /v1 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${DEV_ORIGIN}\r\n\r\n`,
      );
      socket.destroy();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  await poison();
  await poison();
  // 予約の回収（有限時間）を待って通常の接続が通ることを確かめる。
  // 予約漏れが残っていれば上限拒否で失敗し続ける。
  const waitForOpen = async (): Promise<WebSocket> => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      try {
        return await openRaw(server.endpoint, DEV_ORIGIN);
      } catch {
        if (Date.now() >= deadline) throw new Error("回復後の接続を観測できない。");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
  const opened = await waitForOpen();
  const collector = new TextCollector(opened);
  const auth = await authorizeAndMux(server, opened, collector);
  expect(auth.connectionId).not.toBe("");
  // 上限保証は維持する。1枠の使用中に次の upgrade は拒否される。
  expect(server.getConnectionCount()).toBe(1);
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  opened.terminate();
  await waitForCondition(() => server.getConnectionCount() === 0);
});

test("指定接続だけを切断し他接続は維持する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const firstOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  await authorizeAndMux(server, firstOpened.socket, firstOpened.collector);
  const secondOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  await authorizeAndMux(server, secondOpened.socket, secondOpened.collector);
  // 未認証接続にもIDを払い出す。
  const raw = await openRaw(server.endpoint, DEV_ORIGIN);
  void new TextCollector(raw);
  await waitForCondition(() => server.listConnections().length === 3);
  const listed = server.listConnections();
  expect(listed).toHaveLength(3);
  const ids = new Set(listed.map((item) => item.connectionId));
  expect(ids.size).toBe(3);
  for (const item of listed) {
    expect(item.origin).toBe(DEV_ORIGIN);
  }
  const authorizedCount = listed.filter((item) => item.authorized).length;
  expect(authorizedCount).toBe(2);
  // 指定接続だけを運用切断する。
  const target = listed.find((item) => item.authorized);
  if (target === undefined) throw new Error("認証済み接続がない。");
  const firstClosed = firstOpened.collector.waitClose();
  const secondClosed = secondOpened.collector.waitClose();
  server.disconnectConnection(target.connectionId);
  // 即時失効は物理切断完了と別に検証する。戻り直後は一覧に残り authorized が false になる。
  const revoked = server
    .listConnections()
    .find((item) => item.connectionId === target.connectionId);
  expect(revoked?.authorized).toBe(false);
  // 切断対象のどちらか一方が閉じる。
  const raced = await Promise.race([firstClosed, secondClosed]);
  expect(raced.code).toBe(1008);
  expect(raced.reason).toBe("operator disconnect");
  // 不明IDは明示エラーとし、全切断へ fallback しない。
  expect(() => server.disconnectConnection("conn-unknown")).toThrow(RangeError);
  // 残存側だけが業務を通せる。
  const alive = server.listConnections().find((item) => item.authorized) ?? undefined;
  expect(alive).not.toBeUndefined();
});

test("運用切断は 1008・固定 reason で未認証接続も切れる", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  await waitForCondition(() => server.listConnections().length === 1);
  const listed = server.listConnections();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.authorized).toBe(false);
  const target = listed[0]?.connectionId;
  if (target === undefined) throw new Error("接続IDがない。");
  const closed = collector.waitClose();
  server.disconnectConnection(target);
  const result = await closed;
  expect(result.code).toBe(1008);
  expect(result.reason).toBe("operator disconnect");
  try {
    await waitForCondition(() => server.listConnections().length === 0);
  } catch (error) {
    const remaining = server.listConnections().map((item) => ({
      connectionId: item.connectionId,
      origin: item.origin,
      authorized: item.authorized,
    }));
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `運用切断後の一覧消失待ちがタイムアウトした。${detail} 残存: ${JSON.stringify(remaining)}`,
    );
  }
  expect(server.listConnections()).toHaveLength(0);
  // 接続IDは再利用しない。
  const { collector: secondCollector } = await openCollected(server.endpoint, DEV_ORIGIN);
  void secondCollector;
  await waitForCondition(() => server.listConnections().length === 1);
  const nextId = server.listConnections()[0]?.connectionId;
  expect(nextId).not.toBe(target);
});

// ---------- 0.3 の mux 経路 ----------

test("同一WSでmux→Session往復しlatest反映と診断echo・pongが返る", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);

  // latest（client→server）は受信箱へ反映される。
  const latest = await auth.mux.conn.createSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  latest.sendLatest({ x: 1 });
  latest.sendLatest({ x: 2 });
  await waitForCondition(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 2;
  });
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  expect(server.getStats().latestStored).toBe(2);

  // reliable の診断 echo・ping に応答する。
  const diag = await auth.mux.conn.createSession({
    sessionId: "diag-1",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(diag);
  await diag.sendReliable({ op: "echo", id: "diag-1", value: { hello: "world" } });
  const echoed = await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "echo",
  );
  expect(echoed).toEqual({ op: "echo", id: "diag-1", value: { hello: "world" } });
  await diag.sendReliable({ op: "ping", id: "diag-p1" });
  const pong = await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
  expect(pong).toEqual({ op: "pong", id: "diag-p1" });
  expect(server.getStats().diagnosticEcho).toBe(1);
  expect(server.getStats().diagnosticPing).toBe(1);
  // 業務 requestId を wire に追加しない。
  expect("requestId" in (echoed as Record<string, unknown>)).toBe(false);
});

test("診断の旧形状（id無し）は当該Sessionのみ中断する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  const old = await auth.mux.conn.createSession({
    sessionId: "old-shape",
    kind: "reliable",
    direction: "bidirectional",
  });
  const good = await auth.mux.conn.createSession({
    sessionId: "new-shape",
    kind: "reliable",
    direction: "bidirectional",
  });
  const goodCollected = collectSession(good);
  const oldEnd = waitSessionEnd(old);
  // `id` の無い旧形状は厳密形状に合わず、当該 Session のみ中断する。
  await old.sendReliable({ op: "ping" });
  const end = await oldEnd;
  expect(end.kind).toBe("aborted");
  // 他 Session と Connection は継続し、明示 id 付きは応答する。
  await good.sendReliable({ op: "ping", id: "new-shape-1" });
  const pong = await goodCollected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
  expect(pong).toEqual({ op: "pong", id: "new-shape-1" });
  expect(auth.mux.conn.closed).toBe(false);
});

test("auth_ok直後のbinaryを失わず処理する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const pendingId = pending.message.requestId;
  const listed = server.listPending().find((item) => item.requestId === pendingId);
  if (listed === undefined) throw new Error("保留がない。");
  server.approvePairing(listed.requestId, listed.code);
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  // `auth_ok` 受信直後に binary を送る（切替中の保持経路を通りうる）。
  const mux = startClientMux(socket, collector, ok.message.connectionId);
  const diag = await mux.conn.createSession({
    sessionId: "immediate",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(diag);
  await diag.sendReliable({ op: "ping", id: "immediate-1" });
  const pong = await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
  expect(pong).toEqual({ op: "pong", id: "immediate-1" });
});

test("mux移行後のtextは境界違反で終了する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  await authorizeAndMux(server, socket, collector);
  const closed = collector.waitClose();
  // mux 開始後に text を送る。
  socket.send(pairingStartMessage());
  const result = await closed;
  expect(result.code).toBe(1008);
  await waitForCondition(() => server.getConnectionCount() === 0);
  // 認可は失効し、再承認なしに業務は通らない。
  expect(server.listConnections()).toHaveLength(0);
});

test("Session破損時に他Sessionは継続する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  const bad = await auth.mux.conn.createSession({
    sessionId: "bad-1",
    kind: "reliable",
    direction: "bidirectional",
  });
  const good = await auth.mux.conn.createSession({
    sessionId: "good-1",
    kind: "reliable",
    direction: "bidirectional",
  });
  const goodCollected = collectSession(good);
  const badEnd = waitSessionEnd(bad);
  // 診断用途外の payload は当該 Session のみ中断する。
  await bad.sendReliable({ op: "unknown-command", value: 1 });
  const end = await badEnd;
  expect(end.kind).toBe("aborted");
  // 他 Session は継続する。
  await good.sendReliable({ op: "ping", id: "good-1" });
  const pong = await goodCollected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
  expect(pong).toEqual({ op: "pong", id: "good-1" });
  expect(auth.mux.conn.closed).toBe(false);
});

test("WS closeで全終了し認可は失効する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  await auth.mux.conn.createSession({
    sessionId: "s1",
    kind: "reliable",
    direction: "bidirectional",
  });
  expect(server.listConnections().find((item) => item.authorized)).not.toBeUndefined();
  socket.terminate();
  await waitForCondition(() => server.getConnectionCount() === 0);
  expect(server.listConnections()).toHaveLength(0);
  void collector;
});

test("運用切断はmux接続を即時1008で閉じ他接続は維持する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const first = await openCollected(server.endpoint, DEV_ORIGIN);
  const firstAuth = await authorizeAndMux(server, first.socket, first.collector);
  const second = await openCollected(server.endpoint, DEV_ORIGIN);
  const secondAuth = await authorizeAndMux(server, second.socket, second.collector);
  const listed = server.listConnections();
  const target = listed.find((item) => item.authorized);
  if (target === undefined) throw new Error("認可済みがない。");
  const firstClosed = first.collector.waitClose();
  const secondClosed = second.collector.waitClose();
  server.disconnectConnection(target.connectionId);
  const raced = await Promise.race([firstClosed, secondClosed]);
  expect(raced.code).toBe(1008);
  expect(raced.reason).toBe("operator disconnect");
  // 残存側は診断 echo を続けられる。
  const survivor = target.connectionId === firstAuth.connectionId ? secondAuth : firstAuth;
  const session = await survivor.mux.conn.createSession({
    sessionId: "survive",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(session);
  await session.sendReliable({ op: "ping", id: "survive-1" });
  await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
});

test("再接続再承認で業務再開しlatestMailboxは維持される", async () => {
  const server = await startServer({
    limits: { maxConnections: 2, maxUnauthorizedConnections: 2, maxPendingPairings: 2 },
  });
  server.openAcceptance();
  const first = await openCollected(server.endpoint, DEV_ORIGIN);
  const firstAuth = await authorizeAndMux(server, first.socket, first.collector);
  const latest1 = await firstAuth.mux.conn.createSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  latest1.sendLatest({ x: 1 });
  await waitForCondition(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 1;
  });
  first.socket.terminate();
  await waitForCondition(() => server.getConnectionCount() === 0);
  // 切断で受信箱は消さない。
  expect(server.getLatest("pose")).toEqual({ x: 1 });

  const second = await openCollected(server.endpoint, DEV_ORIGIN);
  const secondAuth = await authorizeAndMux(server, second.socket, second.collector);
  // 旧接続の Session 状態は残らず、新接続で同名 Session を使える。
  const latest2 = await secondAuth.mux.conn.createSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  latest2.sendLatest({ x: 2 });
  await waitForCondition(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 2;
  });
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  const diag = await secondAuth.mux.conn.createSession({
    sessionId: "diag-re",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(diag);
  await diag.sendReliable({ op: "ping", id: "diag-re-1" });
  await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
});

test("受信上限の超過はclose 1009で通知する", async () => {
  const server = await startServer({ limits: { maxWebSocketMessageBytes: 256 } });
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const closed = collector.waitClose();
  socket.send(
    JSON.stringify({ v: PROTOCOL_VERSION, type: "pairing_start", extra: "x".repeat(1024) }),
  );
  const result = await closed;
  // 受信上限は WS メッセージのバイト数であり、分割フレームも合算する。
  expect(result.code).toBe(1009);
});

test("latestは受信箱に最新値を残す", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  const latest = await auth.mux.conn.createSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  latest.sendLatest({ x: 1 });
  latest.sendLatest({ x: 2 });
  await waitForCondition(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 2;
  });
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  expect(server.getStats().latestStored).toBe(2);
});

test("同名Sessionの二重作成は拒否し既存は継続する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  await auth.mux.conn.createSession({
    sessionId: "dup",
    kind: "reliable",
    direction: "bidirectional",
  });
  await expect(
    auth.mux.conn.createSession({
      sessionId: "dup",
      kind: "reliable",
      direction: "bidirectional",
    }),
  ).rejects.toThrow();
  const survivor = auth.mux.conn.getSession("dup");
  if (survivor === undefined) throw new Error("既存 Session がない。");
  const collected = collectSession(survivor);
  await survivor.sendReliable({ op: "ping", id: "dup-1" });
  await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["op"] === "pong",
  );
});
