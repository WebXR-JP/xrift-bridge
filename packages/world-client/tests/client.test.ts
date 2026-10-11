/**
 * 0.3 クライアントの統合検証。
 *
 * 製品 `world-client` と、`ws` 上に `bridge-protocol/transport` のサーバ側
 * `Connection` を載せた試験ハーネスを接続する。認可前テキスト
 * （`pairing_start`・`pairing_pending`・`auth_ok`）の往復はハーネスが担い、
 * 認可後 mux の相手は製品 transport である。
 *
 * 送受信の到着待ちは出来事の到達で確定する。認証まわりに時限は設けず、
 * 取消は `AbortSignal`、通信失敗はソケットの close 通知で扱う。
 */
import { afterEach, expect, test } from "vite-plus/test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { PROTOCOL_VERSION, parseBridgeMessage, stringifyBridgeMessage } from "bridge-protocol";
import {
  Connection,
  WsMessageStream,
  type InboundSession as TransportInboundSession,
  type LatestSenderSession as TransportLatestSenderSession,
  type RawSocket,
  type TimerScheduler,
  type WsMessageStreamOptions,
} from "bridge-protocol/transport";
import {
  WorldClientError,
  createConnectionRequest,
  type InboundSession,
  type SessionProvider,
} from "../src/index.ts";
import { normalizeSocketData } from "../src/browser-socket.ts";

// ADR: libp2p の `Logger` は呼出可能と付帯操作の合成型であり、
// 試験用の無操作実装は構造で組み立てる。
function createTestLogger(): WsMessageStreamOptions["log"] {
  const callable = (..._args: unknown[]): void => {};
  const log = callable as unknown as WsMessageStreamOptions["log"];
  (log as unknown as { error: (..._args: unknown[]) => void }).error = () => {};
  (log as unknown as { trace: (..._args: unknown[]) => void }).trace = () => {};
  (log as unknown as { enabled: boolean }).enabled = false;
  (log as unknown as { newScope: () => WsMessageStreamOptions["log"] }).newScope = () => log;
  return log;
}

/**
 * 認可後の transport に渡す差し替え可能なタイマー。発火させずに保持する。
 *
 * 認証まわりに時限は無いため、手で進める手段は持たない。
 */
class ManualScheduler implements TimerScheduler {
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  setTimeout(handler: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
}

/** 試験用サーバ側の `RawSocket` 適合。振り分けはハーネスが行う。 */
class TestServerSocket implements RawSocket {
  private readonly bytesHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly closedHandlers = new Set<(cause?: Error) => void>();
  private closedNotified = false;
  private closeCause: Error | undefined;

  constructor(private readonly socket: WebSocket) {
    socket.on("close", () => {
      this.notifyClosed(this.closeCause);
    });
    socket.on("error", (cause: Error) => {
      this.closeCause = cause;
    });
  }

  sendBytes(bytes: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("開いていないソケットには送れない。");
    }
    this.socket.send(bytes, { binary: true }, (error?: Error | null) => {
      if (error !== undefined && error !== null) this.notifyClosed(error);
    });
  }

  bufferedBytes(): number {
    return this.socket.bufferedAmount;
  }

  closeSocket(): void {
    try {
      this.socket.close();
    } catch {
      // 閉塞時の例外は無視する。
    }
  }

  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandlers.add(handler);
  }

  onClosed(handler: (cause?: Error) => void): void {
    if (this.closedNotified) {
      try {
        handler(this.closeCause);
      } catch {
        // 購読者の例外は無視する。
      }
      return;
    }
    this.closedHandlers.add(handler);
  }

  /** ハーネスが振り分けた受信 binary を流す。 */
  receiveBytes(bytes: Uint8Array): void {
    if (this.closedNotified) return;
    for (const handler of [...this.bytesHandlers]) {
      try {
        handler(bytes);
      } catch {
        // 購読者の例外で適合を壊さない。
      }
    }
  }

  /** 終了を流す（重複しても一度だけ）。 */
  notifyClosed(cause?: Error): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    if (cause !== undefined) this.closeCause = cause;
    for (const handler of [...this.closedHandlers]) {
      try {
        handler(this.closeCause);
      } catch {
        // 購読者の例外は無視する。
      }
    }
    this.closedHandlers.clear();
  }
}

/** 試験受信値をテキスト化する。 */
function rawToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

/** 試験受信値をバイナリ化する。 */
function rawToBytes(data: RawData): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array((data as ArrayBuffer).slice(0));
}

/**
 * 型に無い送信口を試験限定で見せる。実行時は engine の検査に委ね、型の誤用が
 * 実行時の拒否（`SessionError`）になることを確かめる。
 */
function misuse(session: unknown): {
  sendReliable(value: unknown): Promise<void>;
  sendLatest(value: unknown): void;
} {
  return session as {
    sendReliable(value: unknown): Promise<void>;
    sendLatest(value: unknown): void;
  };
}

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const PAIRING = { requestId: "pair-1", code: "123456" };

/** ハーネスの操作口。 */
interface Harness {
  readonly port: number;
  readonly latestMailbox: Map<string, unknown>;
  readonly latestLog: Array<{ sessionId: string; payload: unknown }>;
  readonly receivedReliable: Array<{ sessionId: string; payload: unknown }>;
  readonly serverSessions: Map<string, TransportInboundSession<"server">>;
  approve(): void;
  openServerLatest(sessionId: string): Promise<TransportLatestSenderSession<"server">>;
  abortServerSession(sessionId: string, cause?: Error): void;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  closeServerSide(code?: number, reason?: string): void;
  observedClose(): Promise<{ code: number; reason: string }>;
  serverConnection(): Connection<"server"> | null;
}

/**
 * 認可前テキストを扱い、承認でサーバ側 mux を開始する試験ハーネス。
 *
 * `pairing_start` には自動で `pairing_pending` を返し、`approve()` で
 * `auth_ok`（text）を送って直ちに mux を開始する。以降は binary のみ mux
 * へ流し、text は境界違反として閉じる。reliable 受信は折り返し、latest
 * 受信は受信箱へ格納する。
 */
function startHarness(options?: { autoPairing?: boolean }): Promise<Harness> {
  const autoPairing = options?.autoPairing ?? true;
  const latestMailbox = new Map<string, unknown>();
  const latestLog: Array<{ sessionId: string; payload: unknown }> = [];
  const receivedReliable: Array<{ sessionId: string; payload: unknown }> = [];
  const serverSessions = new Map<string, TransportInboundSession<"server">>();
  const serverScheduler = new ManualScheduler();
  let connectionSeq = 0;
  let active: WebSocket | null = null;
  let muxed = false;
  let raw: TestServerSocket | null = null;
  let connection: Connection<"server"> | null = null;
  let closeResolve: ((close: { code: number; reason: string }) => void) | null = null;
  const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
    closeResolve = resolve;
  });

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    // 逐次接続のみ扱う。新しい接続で状態を作り直す。
    active = socket;
    muxed = false;
    raw = null;
    connection = null;
    serverSessions.clear();
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (muxed) {
        if (!isBinary) {
          socket.close(1008, "server: text after mux");
          return;
        }
        raw?.receiveBytes(rawToBytes(data));
        return;
      }
      if (isBinary) {
        socket.close(1008, "server: pre-auth binary");
        return;
      }
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "pairing_start") {
        if (!autoPairing) return;
        socket.send(
          stringifyBridgeMessage({
            v: PROTOCOL_VERSION,
            type: "pairing_pending",
            requestId: PAIRING.requestId,
            code: PAIRING.code,
          }),
        );
      }
    });
    socket.on("close", (code: number, reason: Buffer) => {
      raw?.notifyClosed();
      closeResolve?.({ code, reason: reason.toString("utf-8") });
      closeResolve = null;
    });
  });

  function attachSession(session: TransportInboundSession<"server">): void {
    serverSessions.set(session.sessionId, session);
    session.onEnd(() => {
      if (serverSessions.get(session.sessionId) === session) {
        serverSessions.delete(session.sessionId);
      }
    });
    if (session.kind === "reliable") {
      session.onMessage((payload) => {
        receivedReliable.push({ sessionId: session.sessionId, payload });
        void session.sendReliable(payload).catch(() => {
          // 終端後の送出失敗は無視する。
        });
      });
    } else {
      session.onMessage((payload) => {
        latestMailbox.set(session.sessionId, payload);
        latestLog.push({ sessionId: session.sessionId, payload });
      });
    }
  }

  return new Promise((resolvePromise) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolvePromise({
        port: address.port,
        latestMailbox,
        latestLog,
        receivedReliable,
        serverSessions,
        approve: () => {
          const socket = active;
          if (socket === null) throw new Error("接続前に承認はできない。");
          connectionSeq += 1;
          socket.send(
            stringifyBridgeMessage({
              v: PROTOCOL_VERSION,
              type: "auth_ok",
              requestId: PAIRING.requestId,
              connectionId: `conn-${connectionSeq}`,
            }),
          );
          // 試験では送出完了を待たず直ちに mux を開始する。製品ブリッジは
          // 送出 callback で開始するが、到着順序（text→binary）は変わらない。
          const serverRaw = new TestServerSocket(socket);
          raw = serverRaw;
          connection = new Connection({
            transport: new WsMessageStream(serverRaw, {
              direction: "inbound",
              log: createTestLogger(),
            }),
            role: "server",
            connectionId: `conn-${connectionSeq}`,
            scheduler: serverScheduler,
            onSession: attachSession,
            onClose: () => undefined,
          });
          muxed = true;
        },
        openServerLatest: async (
          sessionId: string,
        ): Promise<TransportLatestSenderSession<"server">> => {
          const current = connection;
          if (current === null) throw new Error("mux 開始前に開けない。");
          return current.createSession({ sessionId, kind: "latest", direction: "to_client" });
        },
        abortServerSession: (sessionId: string, cause?: Error): void => {
          const session = serverSessions.get(sessionId);
          if (session === undefined) throw new Error("サーバ側に対象がない。");
          session.abort(cause);
        },
        sendText: (text: string): void => {
          if (active === null) throw new Error("接続前に送出はできない。");
          active.send(text);
        },
        sendBinary: (bytes: Uint8Array): void => {
          if (active === null) throw new Error("接続前に送出はできない。");
          active.send(bytes, { binary: true });
        },
        closeServerSide: (code = 1008, reason = "server close"): void => {
          if (active === null) throw new Error("接続前に切断はできない。");
          active.close(code, reason);
        },
        observedClose: (): Promise<{ code: number; reason: string }> => closedPromise,
        serverConnection: (): Connection<"server"> | null => connection,
      });
    });
  });
}

const servers: WebSocketServer[] = [];
const providers: SessionProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => {
            resolvePromise();
          });
        }),
    ),
  );
});

/** 承認まで進めて管理口を受け取る。両方の約束を扱う。 */
async function connectApproved(
  harness: Harness,
  scheduler: ManualScheduler,
): Promise<{ pairingRequestId: string; provider: SessionProvider }> {
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
  });
  const pairing = await request.pairingInfo;
  harness.approve();
  const provider = await request.sessionProvider;
  providers.push(provider);
  return { pairingRequestId: pairing.requestId, provider };
}

test("比較コード表示・承認・同一WS上のmuxでreliable往復できる", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
  });
  const pairing = await request.pairingInfo;
  expect(pairing.requestId).toBe("pair-1");
  expect(pairing.code).toBe("123456");

  harness.approve();
  const provider = await request.sessionProvider;
  providers.push(provider);
  expect(provider.connectionId).toBe("conn-1");
  expect(provider.isAlive).toBe(true);

  const session = await provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  expect(session.sessionId).toBe("chat");
  expect(session.kind).toBe("reliable");
  expect(session.direction).toBe("bidirectional");
  expect(session.isAlive).toBe(true);

  const received: unknown[] = [];
  session.onMessage((payload) => {
    received.push(payload);
  });
  // サーバ起点の送信も同一 Session で受ける（双方向）。
  await waitFor(() => harness.serverSessions.has("chat"), "サーバ側 Session の成立");
  const serverSession = harness.serverSessions.get("chat");
  if (serverSession === undefined) throw new Error("サーバ側 Session を特定できない。");
  if (serverSession.kind !== "reliable") throw new Error("サーバ側 Session の種別が想定外である。");
  await serverSession.sendReliable({ hello: "server" });

  await session.sendReliable({ op: "ping" });
  await waitFor(() => received.length >= 2, "往復とサーバ起点の受信");
  expect(received).toEqual([{ hello: "server" }, { op: "ping" }]);
});

test("latestの同期受付・置換・サーバ側反映と種別境界", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const { provider } = await connectApproved(harness, scheduler);

  const pose = await provider.tryCreateSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  // 同期受付であり、戻りは配送完了を意味しない。
  pose.sendLatest({ x: 1 });
  pose.sendLatest({ x: 2 });
  await waitFor(() => harness.latestMailbox.get("pose") !== undefined, "サーバ側受信箱への反映");
  expect(harness.latestMailbox.get("pose")).toEqual({ x: 2 });
  expect(harness.latestLog).toEqual([
    { sessionId: "pose", payload: { x: 1 } },
    { sessionId: "pose", payload: { x: 2 } },
  ]);

  const chat = await provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  // 種別と送信 API の不一致は受け付けない（型に無い誤用は試験限定の見なしで
  // 実行し、engine の `SessionError` になることを確かめる）。
  let chatMisuse: unknown;
  try {
    misuse(chat).sendLatest({ x: 1 });
  } catch (error) {
    chatMisuse = error;
  }
  expect(chatMisuse).toBeInstanceOf(Error);
  expect((chatMisuse as { code?: unknown }).code).toBe("kind-violation");
  await expect(chat.sendReliable({ x: 1 })).resolves.toBeUndefined();
  const poseMisuse = await misuse(pose)
    .sendReliable({ x: 1 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(poseMisuse).toBeInstanceOf(Error);
  expect((poseMisuse as { code?: unknown }).code).toBe("kind-violation");
});

test("サーバ起点latest to_clientをinbound Sessionで受ける", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const { provider } = await connectApproved(harness, scheduler);

  const inbound: InboundSession[] = [];
  provider.onSession((session) => {
    inbound.push(session);
  });
  const serverSession = await harness.openServerLatest("news");
  serverSession.sendLatest("n1");
  serverSession.sendLatest("n2");

  await waitFor(() => inbound.length === 1, "inbound Session の通知");
  const session = inbound[0];
  if (session === undefined) throw new Error("inbound Session を特定できない。");
  expect(session.sessionId).toBe("news");
  expect(session.kind).toBe("latest");
  expect(session.direction).toBe("to_client");
  // 購読前の到着分も順序どおり渡る。
  const received: unknown[] = [];
  session.onMessage((payload) => {
    received.push(payload);
  });
  await waitFor(() => received.length >= 2, "サーバ起点 latest の受信");
  expect(received).toEqual(["n1", "n2"]);
  expect(session.isAlive).toBe(true);
});

test("FINの往復で正常終了できる", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const { provider } = await connectApproved(harness, scheduler);
  const session = await provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  await session.sendReliable({ op: "ping" });
  await waitFor(() => harness.receivedReliable.length >= 1, "サーバ側の受信");
  const serverSession = harness.serverSessions.get("chat");
  if (serverSession === undefined) throw new Error("サーバ側 Session を特定できない。");

  let clientRemoteEnded = false;
  const clientEnd = new Promise<{ kind: string }>((resolvePromise) => {
    session.onEnd((end) => {
      resolvePromise({ kind: end.kind });
    });
  });
  session.onRemoteEnd(() => {
    clientRemoteEnded = true;
  });

  await session.closeWrite();
  await waitFor(() => serverSession.peerEnded, "サーバ側の FIN 観測");
  await serverSession.closeWrite();
  const end = await clientEnd;
  expect(clientRemoteEnded).toBe(true);
  expect(end.kind).toBe("closed");
  expect(session.isAlive).toBe(false);
});

test("利用者closeで待機送信が拒否され二重決着しない", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const { provider } = await connectApproved(harness, scheduler);
  const session = await provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  let closedCount = 0;
  provider.onClosed(() => {
    closedCount += 1;
  });

  // 送信の解決には microtask の往復が要るため、同期の close が先に立ち、
  // 待機は結果不明として拒否される。transport が一度だけ決着する。
  const pending = session.sendReliable({ op: "ping" });
  let settled = 0;
  const counted = pending.then(
    () => {
      settled += 1;
    },
    () => {
      settled += 1;
    },
  );
  provider.close();
  await expect(counted).resolves.toBeUndefined();
  await expect(pending).rejects.toThrow();
  expect(settled).toBe(1);
  expect(provider.isAlive).toBe(false);
  expect(closedCount).toBe(1);
  // 終端後の送信は受け付けない。
  await expect(session.sendReliable({ op: "ping" })).rejects.toThrow();
});

test("RSTで Session が中断し以降の送信を拒否する", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const { provider } = await connectApproved(harness, scheduler);
  const chat = await provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  const pose = await provider.tryCreateSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  await chat.sendReliable({ op: "ping" });
  await waitFor(() => harness.receivedReliable.length >= 1, "サーバ側の受信");

  const chatEnd = new Promise<{ kind: string }>((resolvePromise) => {
    chat.onEnd((end) => {
      resolvePromise({ kind: end.kind });
    });
  });
  harness.abortServerSession("chat", new Error("test rst"));
  const end = await chatEnd;
  expect(end.kind).toBe("aborted");
  expect(chat.isAlive).toBe(false);
  await expect(chat.sendReliable({ op: "ping" })).rejects.toThrow();

  const poseEnd = new Promise<{ kind: string }>((resolvePromise) => {
    pose.onEnd((end) => {
      resolvePromise({ kind: end.kind });
    });
  });
  harness.abortServerSession("pose", new Error("test rst"));
  await poseEnd;
  expect(() => pose.sendLatest({ x: 1 })).toThrow();
  // 他 Session と Connection は維持する。
  expect(provider.isAlive).toBe(true);
});

test("サーバ切断で認可失効し再ペアリングで再承認できる", async () => {
  const harness = await startHarness();
  const firstScheduler = new ManualScheduler();
  const first = await connectApproved(harness, firstScheduler);
  expect(first.provider.isAlive).toBe(true);
  const before = await first.provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  await before.sendReliable({ op: "ping" });
  await waitFor(() => harness.receivedReliable.length >= 1, "切断前の往復");

  let closedCount = 0;
  first.provider.onClosed(() => {
    closedCount += 1;
  });
  harness.closeServerSide(1008, "server close");
  await waitFor(() => !first.provider.isAlive, "認可失効");
  expect(closedCount).toBe(1);
  await expect(before.sendReliable({ op: "ping" })).rejects.toThrow();

  // 再接続は再ペアリングが必要であり、旧認可は引き継がない。
  const secondScheduler = new ManualScheduler();
  const second = await connectApproved(harness, secondScheduler);
  expect(second.provider).not.toBe(first.provider);
  expect(second.provider.connectionId).toBe("conn-2");
  const after = await second.provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  await after.sendReliable({ op: "ping" });
  await waitFor(() => harness.receivedReliable.length >= 2, "再承認後の往復");
});

test("重複するコード通知は管理口の約束を拒否する", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
  });
  // 表示済みの比較コードは確定しており、拒否に変わらない。
  const pairing = await request.pairingInfo;
  expect(pairing.requestId).toBe("pair-1");
  harness.sendText(
    stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "pairing_pending",
      requestId: "pair-1",
      code: "123456",
    }),
  );
  await expect(request.sessionProvider).rejects.toMatchObject({ code: "UNEXPECTED_MESSAGE" });
});

test("異なる要求のauth_okは拒否する", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
  });
  await request.pairingInfo;
  harness.sendText(
    stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "auth_ok",
      requestId: "pair-other",
      connectionId: "conn-9",
    }),
  );
  await expect(request.sessionProvider).rejects.toMatchObject({ code: "UNEXPECTED_MESSAGE" });
});

test("認可前のbinaryは境界違反として終了する", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
  });
  await request.pairingInfo;
  harness.sendBinary(new Uint8Array([0, 0, 0, 1, 0x7b, 0x7d]));
  await expect(request.sessionProvider).rejects.toMatchObject({ code: "UNEXPECTED_BINARY" });
});

test("mux移行後のtextは境界違反として終了する", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const { provider } = await connectApproved(harness, scheduler);
  let closedCount = 0;
  provider.onClosed(() => {
    closedCount += 1;
  });
  harness.sendText(
    stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "error",
      code: "SOMETHING",
      message: "late text",
    }),
  );
  await waitFor(() => !provider.isAlive, "違反後の終端");
  expect(closedCount).toBe(1);
  await harness.observedClose();
});

test("承認待ちの取消はCONNECT_CANCELLEDになる", async () => {
  const harness = await startHarness();
  const scheduler = new ManualScheduler();
  const controller = new AbortController();
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
    signal: controller.signal,
  });
  // 比較コードの到達（open 往復）より先に同期で取り消すため、両方とも未決着である。
  controller.abort();
  await expect(request.pairingInfo).rejects.toMatchObject({ code: "CONNECT_CANCELLED" });
  await expect(request.sessionProvider).rejects.toMatchObject({ code: "CONNECT_CANCELLED" });
});

test("承認前の切断はCONNECTION_CLOSEDになる", async () => {
  // 比較コードを返さないハーネスで、コード受信前の切断を起こす。
  const harness = await startHarness({ autoPairing: false });
  const scheduler = new ManualScheduler();
  const request = createConnectionRequest({
    endpoint: `ws://127.0.0.1:${harness.port}/v1`,
    scheduler,
  });
  // 両方の約束に拒否時の扱いを付け、未処理の拒否を残さない。
  const pairingSettled = request.pairingInfo.then(
    () => "resolved",
    (error: unknown) => error,
  );
  const providerSettled = request.sessionProvider.then(
    () => "resolved",
    (error: unknown) => error,
  );
  // 接続確立の到達を待ってから切断する（到達前は操作口が失敗する）。
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      harness.closeServerSide(1008, "server close before approval");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("切断の実行に失敗した。");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await expect(request.pairingInfo).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  await expect(request.sessionProvider).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  expect(await pairingSettled).toMatchObject({ code: "CONNECTION_CLOSED" });
  expect(await providerSettled).toMatchObject({ code: "CONNECTION_CLOSED" });
});

test("Blobの受信値を順序どおりバイナリ化できる", async () => {
  const first = await normalizeSocketData(new Blob(["abc"]));
  const second = await normalizeSocketData("text");
  if (first.kind !== "bytes") throw new Error("バイナリに正規化できない。");
  expect(new TextDecoder().decode(first.bytes)).toBe("abc");
  if (second.kind !== "text") throw new Error("テキストに正規化できない。");
  expect(second.text).toBe("text");
});

test("不正なendpointでは生成できない", () => {
  expect(() => createConnectionRequest({ endpoint: "ws://localhost:3100/v1" })).toThrow(RangeError);
  expect(() => createConnectionRequest({ endpoint: "" })).toThrow(RangeError);
});

test("取り消し済みの合図では接続を開始しない", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = createConnectionRequest({
    endpoint: "ws://127.0.0.1:3100/v1",
    signal: controller.signal,
  });
  await expect(request.pairingInfo).rejects.toBeInstanceOf(WorldClientError);
  await expect(request.sessionProvider).rejects.toMatchObject({ code: "CONNECT_CANCELLED" });
});
