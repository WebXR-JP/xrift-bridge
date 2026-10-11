import { afterEach, expect, test } from "vite-plus/test";
import { WebSocket, type RawData } from "ws";
import { PROTOCOL_VERSION, parseBridgeMessage, type BridgeMessage } from "bridge-protocol";
import {
  Connection,
  WsMessageStream,
  type InboundSession,
  type Session,
} from "bridge-protocol/transport";
import type { WsMessageStreamOptions } from "bridge-protocol/transport";
import {
  createBridgeServer,
  type BridgeOptions,
  type BridgeServer,
  type BridgeSessionInfo,
  type ManagementEvent,
} from "../src/server.ts";
import { NodeWsSocket } from "../src/node-socket.ts";
import { attachEchoResponder } from "./echo-responder.ts";

const PROD_ORIGIN = "https://app.xrift.net";
const DEV_ORIGIN = "http://localhost:5173";

const servers: BridgeServer[] = [];
const sockets: WebSocket[] = [];
const muxConns: Connection<"client">[] = [];

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

async function startServer(options?: Partial<BridgeOptions>): Promise<BridgeServer> {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: [PROD_ORIGIN, DEV_ORIGIN],
    ...options,
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
  expect(typeof ok.message.connectionId).toBe("string");
  return { connectionId: ok.message.connectionId, requestId: pendingRequestId };
}

/** クライアント側 mux の束。 */
interface ClientMux {
  readonly raw: NodeWsSocket;
  readonly stream: WsMessageStream;
  readonly conn: Connection<"client">;
  readonly closes: Error[];
}

/**
 * 同一 WS 上でクライアント側 mux を開始する。
 *
 * `auth_ok` 受信後の binary（サーバ側の早期配送）を失わないよう、
 * 収集器の保持分を順序どおり戻し、以後の binary を適合へ流す。
 */
function startClientMux(
  socket: WebSocket,
  collector: TextCollector,
  connectionId: string,
): ClientMux {
  const raw = new NodeWsSocket(socket);
  const stream = new WsMessageStream(raw, { direction: "outbound", log: createTestLogger() });
  const closes: Error[] = [];
  const conn = new Connection<"client">({
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
function collectSession(session: InboundSession<"client">): {
  payloads: unknown[];
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
  session: Session<"client">,
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

/** 管理通知を集め、条件成立まで待てるようにする。 */
function collectManagement(server: BridgeServer): {
  events: ManagementEvent[];
  unsubscribe: () => void;
  waitFor(
    predicate: (event: ManagementEvent) => boolean,
    timeoutMs?: number,
  ): Promise<ManagementEvent>;
} {
  const events: ManagementEvent[] = [];
  const unsubscribe = server.onManagementEvent((event) => {
    events.push(event);
  });
  return {
    events,
    unsubscribe,
    async waitFor(
      predicate: (event: ManagementEvent) => boolean,
      timeoutMs = 3_000,
    ): Promise<ManagementEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `管理通知待ちがタイムアウトした。受信済み: ${JSON.stringify(events.map((event) => event.kind))}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

function sessionStartedOf(events: ManagementEvent[], sessionId: string): BridgeSessionInfo[] {
  return events
    .filter((event) => event.kind === "session-started" && event.session.sessionId === sessionId)
    .map((event) => (event as { session: BridgeSessionInfo }).session);
}

function sessionEndedOf(events: ManagementEvent[], localSessionId: string): ManagementEvent[] {
  return events.filter(
    (event) => event.kind === "session-ended" && event.session.localSessionId === localSessionId,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 生存セッションの公開 ----------

test("未認可の接続ではセッションが公開されない", async () => {
  const server = await startServer();
  server.enableAcceptance();
  expect(server.listSessions()).toEqual([]);
  expect(server.getSession("session-1")).toBeUndefined();
  const { socket } = await openCollected(server.endpoint, DEV_ORIGIN);
  // 開始待ちでも公開されない。
  expect(server.listSessions()).toEqual([]);
  socket.send(pairingStartMessage());
  await waitForCondition(() => server.listPending().length === 1);
  // 承認待ちでも公開されない。
  expect(server.listSessions()).toEqual([]);
  expect(server.getSession("session-1")).toBeUndefined();
});

test("承認だけでは公開されず作成で開始通知と一覧が整合する", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  // 承認成功や切替完了だけでは利用開始ではなく、公開されない。
  expect(server.listSessions()).toEqual([]);
  expect(management.events.some((event) => event.kind === "session-started")).toBe(false);

  const session = await auth.mux.conn.createSession({
    sessionId: "diag-1",
    kind: "reliable",
    direction: "bidirectional",
  });
  const started = await management.waitFor(
    (event) => event.kind === "session-started" && event.session.sessionId === "diag-1",
  );
  if (started.kind !== "session-started") throw new Error("開始通知ではない。");
  // 公開情報は接続・論理名・種別方向を持ち、識別子はローカル採番である。
  expect(started.session.connectionId).toBe(auth.connectionId);
  expect(started.session.localSessionId).toMatch(/^session-\d+$/);
  expect(started.session.kind).toBe("reliable");
  expect(started.session.direction).toBe("bidirectional");
  // wire の論理名は取得キーに使わない。
  expect(server.getSession("diag-1")).toBeUndefined();
  const listed = server.listSessions();
  expect(listed).toHaveLength(1);
  expect(listed[0]).toEqual(started.session);
  const fetched = server.getSession(started.session.localSessionId);
  expect(fetched).not.toBeUndefined();
  expect(fetched?.sessionId).toBe("diag-1");

  // 公開後も応答器の往復は通り、既存の振る舞いを壊さない。
  const stopResponding = attachEchoResponder(server);
  const collected = collectSession(session);
  await session.sendReliable({ 往復: "公開後も継続-1" });
  const echoed = await collected.waitForPayload(
    (payload) =>
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>)["往復"] === "公開後も継続-1",
  );
  expect(echoed).toEqual({ 往復: "公開後も継続-1" });
  stopResponding();
  management.unsubscribe();
});

test("latestセッションも公開される", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  const latest = await auth.mux.conn.createSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  const started = await management.waitFor(
    (event) => event.kind === "session-started" && event.session.sessionId === "pose",
  );
  if (started.kind !== "session-started") throw new Error("開始通知ではない。");
  expect(started.session.kind).toBe("latest");
  expect(started.session.direction).toBe("to_server");
  expect(server.listSessions()).toHaveLength(1);
  latest.sendLatest({ x: 7 });
  await waitForCondition(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 7;
  });
  management.unsubscribe();
});

test("購読後の取得で初期同期でき識別子で重複を除ける", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  await auth.mux.conn.createSession({
    sessionId: "early",
    kind: "reliable",
    direction: "bidirectional",
  });
  // 購読前に作られた分は一覧で拾い、通知と識別子で重複を除く。
  await waitForCondition(() => server.listSessions().length === 1);
  const management = collectManagement(server);
  const listed = server.listSessions();
  expect(listed).toHaveLength(1);
  const merged = new Map<string, BridgeSessionInfo>();
  for (const info of [
    ...management.events
      .filter((event) => event.kind === "session-started")
      .map((event) => (event as { session: BridgeSessionInfo }).session),
    ...listed,
  ]) {
    merged.set(info.localSessionId, info);
  }
  // 通知が未到達でも一覧で1件になり、両方が届いても重複しない。
  expect(merged.size).toBe(1);
  management.unsubscribe();
});

test("セッション終了の通知は一度だけ出す", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  const session = await auth.mux.conn.createSession({
    sessionId: "once",
    kind: "reliable",
    direction: "bidirectional",
  });
  const started = await management.waitFor(
    (event) => event.kind === "session-started" && event.session.sessionId === "once",
  );
  if (started.kind !== "session-started") throw new Error("開始通知ではない。");
  const localSessionId = started.session.localSessionId;
  const clientEnd = waitSessionEnd(session);
  session.abort(new Error("試験中断"));
  await clientEnd;
  const ended = await management.waitFor(
    (event) => event.kind === "session-ended" && event.session.localSessionId === localSessionId,
  );
  if (ended.kind !== "session-ended") throw new Error("終了通知ではない。");
  expect(ended.end.kind).toBe("aborted");
  // 終了後は一覧・取得から外れ、通知が重複しない。
  expect(server.listSessions()).toEqual([]);
  expect(server.getSession(localSessionId)).toBeUndefined();
  socket.terminate();
  await collector.waitClose();
  await sleep(200);
  expect(sessionEndedOf(management.events, localSessionId)).toHaveLength(1);
  management.unsubscribe();
});

test("終了後に同名で再作成すると別識別子になる", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  void collector;
  const auth = await authorizeAndMux(server, socket, collector);
  const first = await auth.mux.conn.createSession({
    sessionId: "reuse",
    kind: "reliable",
    direction: "bidirectional",
  });
  const firstStarted = await management.waitFor(
    (event) =>
      event.kind === "session-started" &&
      event.session.sessionId === "reuse" &&
      sessionStartedOf(management.events, "reuse").length === 1,
  );
  if (firstStarted.kind !== "session-started") throw new Error("開始通知ではない。");
  const firstEnd = waitSessionEnd(first);
  first.abort(new Error("旧世代の終了"));
  await firstEnd;
  await management.waitFor(
    (event) =>
      event.kind === "session-ended" &&
      event.session.localSessionId === firstStarted.session.localSessionId,
  );
  const second = await auth.mux.conn.createSession({
    sessionId: "reuse",
    kind: "reliable",
    direction: "bidirectional",
  });
  void second;
  const secondStarted = await management.waitFor(
    (event) =>
      event.kind === "session-started" &&
      event.session.sessionId === "reuse" &&
      event.session.localSessionId !== firstStarted.session.localSessionId,
  );
  if (secondStarted.kind !== "session-started") throw new Error("開始通知ではない。");
  // 同名でも識別子は再利用せず、古い割当てと混同しない。
  expect(secondStarted.session.localSessionId).not.toBe(firstStarted.session.localSessionId);
  expect(server.getSession(firstStarted.session.localSessionId)).toBeUndefined();
  expect(server.getSession(secondStarted.session.localSessionId)?.sessionId).toBe("reuse");
  expect(server.listSessions()).toHaveLength(1);
  management.unsubscribe();
});

test("別接続の同名セッションを混同しない", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const firstOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  const firstAuth = await authorizeAndMux(server, firstOpened.socket, firstOpened.collector);
  const secondOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  const secondAuth = await authorizeAndMux(server, secondOpened.socket, secondOpened.collector);
  const firstSession = await firstAuth.mux.conn.createSession({
    sessionId: "shared",
    kind: "reliable",
    direction: "bidirectional",
  });
  void firstSession;
  const secondSession = await secondAuth.mux.conn.createSession({
    sessionId: "shared",
    kind: "reliable",
    direction: "bidirectional",
  });
  void secondSession;
  await management.waitFor(() => sessionStartedOf(management.events, "shared").length === 2);
  const infos = sessionStartedOf(management.events, "shared");
  expect(infos).toHaveLength(2);
  // 別接続の同名は表示名が同じでも識別子と接続が異なる。
  expect(infos[0]?.localSessionId).not.toBe(infos[1]?.localSessionId);
  expect(infos[0]?.connectionId).not.toBe(infos[1]?.connectionId);
  expect(server.listSessions()).toHaveLength(2);
  // 片方の終了はもう片方に影響しない。
  const firstEnd = waitSessionEnd(firstSession);
  firstSession.abort(new Error("片側の終了"));
  await firstEnd;
  const firstInfo = infos.find((info) => info.connectionId === firstAuth.connectionId);
  if (firstInfo === undefined) throw new Error("片側の公開情報がない。");
  await management.waitFor(
    (event) =>
      event.kind === "session-ended" && event.session.localSessionId === firstInfo.localSessionId,
  );
  const secondInfo = infos.find((info) => info.connectionId === secondAuth.connectionId);
  if (secondInfo === undefined) throw new Error("残存側の公開情報がない。");
  expect(server.getSession(secondInfo.localSessionId)?.sessionId).toBe("shared");
  expect(server.listSessions()).toHaveLength(1);
  management.unsubscribe();
});

test("対象接続の切断で全セッションが即時に失効する", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  await auth.mux.conn.createSession({
    sessionId: "rel-1",
    kind: "reliable",
    direction: "bidirectional",
  });
  await auth.mux.conn.createSession({
    sessionId: "lat-1",
    kind: "latest",
    direction: "to_server",
  });
  await management.waitFor(() => server.listSessions().length === 2);
  const before = server.listSessions();
  expect(before).toHaveLength(2);
  server.disconnectConnection(auth.connectionId);
  // 終端開始の時点で一覧・取得から消えている（物理切断待ちまで残さない）。
  expect(server.listSessions()).toEqual([]);
  for (const info of before) {
    expect(server.getSession(info.localSessionId)).toBeUndefined();
  }
  const closed = collector.waitClose();
  expect((await closed).code).toBe(1008);
  // 各セッションの終了通知は一度ずつ届く。
  for (const info of before) {
    await management.waitFor(
      (event) =>
        event.kind === "session-ended" && event.session.localSessionId === info.localSessionId,
    );
  }
  await sleep(200);
  for (const info of before) {
    expect(sessionEndedOf(management.events, info.localSessionId)).toHaveLength(1);
  }
  management.unsubscribe();
});

test("FINだけでは終了通知を出さず全体終了で出す", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  void collector;
  const auth = await authorizeAndMux(server, socket, collector);
  const clientSession = await auth.mux.conn.createSession({
    sessionId: "fin-only",
    kind: "reliable",
    direction: "bidirectional",
  });
  const started = await management.waitFor(
    (event) => event.kind === "session-started" && event.session.sessionId === "fin-only",
  );
  if (started.kind !== "session-started") throw new Error("開始通知ではない。");
  const localSessionId = started.session.localSessionId;
  // 片方向の終了（FIN）では全体終了にならず、公開も維持される。
  await clientSession.closeWrite();
  await sleep(250);
  expect(
    management.events.some(
      (event) => event.kind === "session-ended" && event.session.localSessionId === localSessionId,
    ),
  ).toBe(false);
  expect(server.listSessions()).toHaveLength(1);
  const serverSession = server.getSession(localSessionId);
  expect(serverSession?.sessionId).toBe("fin-only");
  if (serverSession === undefined) throw new Error("生存中の取得に失敗した。");
  if (serverSession.kind !== "reliable") throw new Error("種別が reliable ではない。");
  // 両方向の終了で全体終了になり、終了通知が出る。
  const clientEnd = waitSessionEnd(clientSession);
  await serverSession.closeWrite();
  const ended = await management.waitFor(
    (event) => event.kind === "session-ended" && event.session.localSessionId === localSessionId,
  );
  if (ended.kind !== "session-ended") throw new Error("終了通知ではない。");
  expect(ended.end.kind).toBe("closed");
  await clientEnd;
  expect(server.getSession(localSessionId)).toBeUndefined();
  management.unsubscribe();
});

test("購読者の例外を隔離し通知中の切断でも順序が壊れない", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const recorded: ManagementEvent[] = [];
  // 例外を投げる購読者がいても後続へ届く。
  const unsubscribeThrower = server.onManagementEvent(() => {
    throw new Error("購読者の例外");
  });
  let disconnected = false;
  const unsubscribeDisconnector = server.onManagementEvent((event) => {
    // 開始通知の配送中に切断し、再入の通知順序を確かめる。
    if (!disconnected && event.kind === "session-started") {
      disconnected = true;
      server.disconnectConnection(event.session.connectionId);
    }
  });
  const unsubscribeRecorder = server.onManagementEvent((event) => {
    recorded.push(event);
  });
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeAndMux(server, socket, collector);
  await auth.mux.conn.createSession({
    sessionId: "order",
    kind: "reliable",
    direction: "bidirectional",
  });
  await collector.waitClose();
  await waitForCondition(() =>
    recorded.some((event) => event.kind === "session-ended" && event.session.sessionId === "order"),
  );
  const startedIndex = recorded.findIndex(
    (event) => event.kind === "session-started" && event.session.sessionId === "order",
  );
  const endedIndex = recorded.findIndex(
    (event) => event.kind === "session-ended" && event.session.sessionId === "order",
  );
  // 例外があっても記録側へ届き、「終了→開始」の逆順にならない。
  expect(startedIndex).toBeGreaterThanOrEqual(0);
  expect(endedIndex).toBeGreaterThanOrEqual(0);
  expect(startedIndex).toBeLessThan(endedIndex);
  const localSessionId = (recorded[startedIndex] as { session: BridgeSessionInfo }).session
    .localSessionId;
  expect(
    recorded.filter(
      (event) => event.kind === "session-ended" && event.session.localSessionId === localSessionId,
    ),
  ).toHaveLength(1);
  unsubscribeThrower();
  unsubscribeDisconnector();
  unsubscribeRecorder();
});

test("getSessionは生存中のみ返し終了後はundefinedになる", async () => {
  const server = await startServer();
  server.enableAcceptance();
  const management = collectManagement(server);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  void collector;
  const auth = await authorizeAndMux(server, socket, collector);
  // 未知の識別子は `undefined` である。
  expect(server.getSession("session-存在しない")).toBeUndefined();
  const session = await auth.mux.conn.createSession({
    sessionId: "lifetime",
    kind: "reliable",
    direction: "bidirectional",
  });
  const started = await management.waitFor(
    (event) => event.kind === "session-started" && event.session.sessionId === "lifetime",
  );
  if (started.kind !== "session-started") throw new Error("開始通知ではない。");
  expect(server.getSession(started.session.localSessionId)?.sessionId).toBe("lifetime");
  const clientEnd = waitSessionEnd(session);
  session.abort(new Error("寿命の終了"));
  await clientEnd;
  await management.waitFor(
    (event) =>
      event.kind === "session-ended" &&
      event.session.localSessionId === started.session.localSessionId,
  );
  expect(server.getSession(started.session.localSessionId)).toBeUndefined();
  management.unsubscribe();
});
