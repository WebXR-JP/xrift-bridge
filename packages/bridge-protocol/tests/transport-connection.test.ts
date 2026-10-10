import { expect, test } from "vite-plus/test";
import { AbstractMessageStream } from "@libp2p/utils";
import type { Logger, StreamMessageEvent } from "@libp2p/interface";
import type { SendResult } from "@libp2p/utils";
import { Uint8ArrayList } from "uint8arraylist";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import { bridgeMuxer, type BridgeMuxer } from "../src/transport/muxer.ts";
import { FrameDecoder, encodeFrameJson } from "../src/transport/framing.ts";
import { Connection } from "../src/transport/connection.ts";
import type {
  LatestCreateSessionRequest,
  ReliableCreateSessionRequest,
} from "../src/transport/connection.ts";
import { type SessionEnd, type SessionEngine } from "../src/transport/session.ts";
import type { ReliableSession, Session } from "../src/transport/session-types.ts";
import type { TimerScheduler } from "../src/transport/timers.ts";
import { PROTOCOL_VERSION, type SessionDirection, type SessionKind } from "../src/messages.ts";
import { parseBridgeMessage } from "../src/validate.ts";

// ADR: libp2p の `Logger` は呼出可能と付帯操作の合成型であり、
// テスト用の無操作実装は構造で組み立てる。合成の正当な構築手段として使う。
function createTestLogger(): Logger {
  const callable = (..._args: unknown[]): void => void 0;
  const log = callable as unknown as Logger;
  log.error = (..._args: unknown[]): void => {};
  log.trace = (..._args: unknown[]): void => {};
  log.enabled = false;
  log.newScope = () => log;
  return log;
}

/**
 * 対向へ非同期配送するメモリ duplex。実 `ws` を使わず決定的に動く。
 *
 * B1・B2 の同形であり、到着は非同期・順序保存である。
 */
class MemoryPipe extends AbstractMessageStream {
  peer?: MemoryPipe;

  constructor(direction: "inbound" | "outbound") {
    super({ log: createTestLogger(), direction });
  }

  sendData(data: Uint8ArrayList): SendResult {
    // ADR: 送出後に基底が緩衝を消費するため、相手渡しは複写する。
    const copy = new Uint8ArrayList(new Uint8Array(data.subarray()));
    const peer = this.peer;
    setTimeout(() => {
      try {
        peer?.onData(copy);
      } catch {
        // 終了後の到着は失われる（実輸送では届かないか無視される）。
      }
    }, 0);
    return { sentBytes: data.byteLength, canSendMore: true };
  }

  sendReset(_err: Error): void {
    const peer = this.peer;
    setTimeout(() => {
      peer?.onRemoteReset();
    }, 0);
  }

  sendPause(): void {}

  sendResume(): void {}

  async close(): Promise<void> {
    const peer = this.peer;
    // 送出済みの到着より後に輸送終了を伝える（順序保存）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    peer?.onTransportClosed();
  }
}

/**
 * 手で時間を進める fake scheduler。keepalive の予約と残留を確認できる。
 *
 * keepalive 単体テストと同形であり、実タイマーを使わない。
 */
class FakeScheduler implements TimerScheduler {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.now + delayMs, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** 未発火の予約数。 */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** 指定時間だけ進め、期限の来た予約を順に発火する。 */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.due <= end && timer.due < nextDue) {
          nextDue = timer.due;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = timer.due;
      timer.handler();
    }
    this.now = end;
  }
}

/** 対向 duplex の束。 */
interface Duplex {
  readonly outboundPipe: MemoryPipe;
  readonly inboundPipe: MemoryPipe;
}

function createDuplex(): Duplex {
  const outboundPipe = new MemoryPipe("outbound");
  const inboundPipe = new MemoryPipe("inbound");
  outboundPipe.peer = inboundPipe;
  inboundPipe.peer = outboundPipe;
  return { outboundPipe, inboundPipe };
}

/** Connection 側の観測束。 */
interface ConnEndpoint {
  readonly conn: Connection;
  readonly sessions: Session[];
  readonly closes: Error[];
  readonly scheduler: FakeScheduler;
}

/** 向き合った Connection 対を作る。 */
function createConnectionPair(connectionId = "conn-1"): {
  duplex: Duplex;
  client: ConnEndpoint;
  server: ConnEndpoint;
} {
  const duplex = createDuplex();
  const build = (role: "client" | "server"): ConnEndpoint => {
    const sessions: Session[] = [];
    const closes: Error[] = [];
    const scheduler = new FakeScheduler();
    const conn = new Connection({
      transport: role === "client" ? duplex.outboundPipe : duplex.inboundPipe,
      role,
      connectionId,
      scheduler,
      onSession: (session) => {
        sessions.push(session);
      },
      onClose: (cause) => {
        closes.push(cause);
      },
    });
    return { conn, sessions, closes, scheduler };
  };
  return { duplex, client: build("client"), server: build("server") };
}

/** 生 muxer 側の観測束（相手の不正ハンドシェイク用）。 */
interface RawEndpoint {
  readonly muxer: BridgeMuxer;
}

function createRawMuxer(pipe: MemoryPipe): RawEndpoint {
  return { muxer: bridgeMuxer()().createStreamMuxer(pipe) };
}

/** 条件が満たされるまで待つ。満たされなければ期限切れで失敗する。 */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`${what} が ${timeoutMs}ms 以内に満たされない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** マイクロタスクの消化を待つ。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 期待件数の payload を購読して集める。 */
function collectPayloads(session: Session, count: number, timeoutMs = 5000): Promise<unknown[]> {
  // ADR: 公開 Union 型では sender が `onMessage` を持たないが、ここで渡すのは
  // 受信可能な Session であり、実行時の公開値は engine そのもののため委譲で動く。
  const engine = session as unknown as SessionEngine;
  return new Promise((resolve, reject) => {
    const out: unknown[] = [];
    // ADR: 登録前の到着分は登録時に同期で渡るため、`unsub` の確定前に
    // 呼ばれる場合がある。`let`＋任意呼びで TDZ を避ける。
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(`payload ${count}件の受信が期限切れになった（${out.length}件のみ）`));
    }, timeoutMs);
    unsub = engine.onMessage((payload) => {
      out.push(payload);
      if (out.length === count) {
        clearTimeout(timer);
        unsub?.();
        resolve(out);
      }
    });
  });
}

/** 終端通知を1件待つ。 */
function waitSessionEnd(session: Session, timeoutMs = 5000): Promise<SessionEnd> {
  return new Promise((resolve, reject) => {
    // ADR: 終端済みへの登録は同期で即時通知されるため、`unsub` の確定前に
    // 呼ばれる場合がある。`let`＋任意呼びで TDZ を避ける。
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error("終端通知が期限切れになった"));
    }, timeoutMs);
    unsub = session.onEnd((end) => {
      clearTimeout(timer);
      unsub?.();
      resolve(end);
    });
  });
}

/** 相手側 Session の到着を待つ。 */
async function waitInboundSession(endpoint: ConnEndpoint, index: number): Promise<Session> {
  await waitFor(() => endpoint.sessions.length > index, 5000, "相手側 Session の登録");
  return endpoint.sessions[index]!;
}

/** reliable であることを確かめて返す。テスト設定の誤りは投げる。 */
function requireReliable(session: Session): ReliableSession {
  if (session.kind !== "reliable") {
    throw new Error("テスト設定の誤り：reliable ではない Session を使った。");
  }
  return session;
}

/** 生 stream の `close` を待つ（RST の観測）。 */
function waitStreamClose(stream: YamuxStream, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("stream の終了が期限切れになった"));
    }, timeoutMs);
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeEventListener("close", onClose);
    };
    stream.addEventListener("close", onClose);
  });
}

/** stream の `message` 断片を1件取り出す。 */
function readChunk(stream: YamuxStream, timeoutMs = 5000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("stream 受信が期限切れになった"));
    }, timeoutMs);
    const onMessage = (event: StreamMessageEvent): void => {
      const data = event.data;
      cleanup();
      resolve(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.subarray()));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("受信前に stream が閉じた"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("close", onClose);
    };
    stream.addEventListener("message", onMessage);
    stream.addEventListener("close", onClose);
  });
}

/** 期待件数の framing 値を stream から集める。 */
async function collectRawFrames(
  stream: YamuxStream,
  count: number,
  timeoutMs = 5000,
): Promise<unknown[]> {
  const decoder = new FrameDecoder();
  const out: unknown[] = [];
  const started = Date.now();
  while (out.length < count) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`framing ${count}件の受信が期限切れ（${out.length}件のみ）`);
    }
    const chunk = await readChunk(stream, timeoutMs);
    out.push(...decoder.push(chunk));
  }
  return out;
}

/** 生 muxer から create_session を送る。 */
async function openRawSession(
  raw: RawEndpoint,
  fields: {
    readonly connectionId: string;
    readonly sessionId: string;
    readonly kind: SessionKind;
    readonly direction: SessionDirection;
  },
): Promise<YamuxStream> {
  const stream = await raw.muxer.createStream();
  stream.send(
    encodeFrameJson({
      v: PROTOCOL_VERSION,
      type: "create_session",
      ...fields,
    }),
  );
  return stream;
}

test("client起点のreliable双方向で双方のSessionが登録・対応する", async () => {
  const { client, server } = createConnectionPair();
  try {
    const clientSession = await client.conn.createSession({
      sessionId: "sess-1",
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverSession = await waitInboundSession(server, 0);
    // 双方の対応表に載る。
    expect(client.conn.getSession("sess-1")).toBe(clientSession);
    expect(server.conn.getSession("sess-1")).toBe(serverSession);
    expect(client.conn.sessionCount).toBe(1);
    expect(server.conn.sessionCount).toBe(1);
    // 往復できる。
    await clientSession.sendReliable({ n: 1 });
    expect(await collectPayloads(serverSession, 1)).toEqual([{ n: 1 }]);
    await requireReliable(serverSession).sendReliable({ n: 2 });
    expect(await collectPayloads(clientSession, 1)).toEqual([{ n: 2 }]);
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});

test("server起点のlatest to_clientで双方のSessionが登録・対応する", async () => {
  const { client, server } = createConnectionPair();
  try {
    const serverSession = await server.conn.createSession({
      sessionId: "live-1",
      kind: "latest",
      direction: "to_client",
    });
    const clientSession = await waitInboundSession(client, 0);
    expect(server.conn.getSession("live-1")).toBe(serverSession);
    expect(client.conn.getSession("live-1")).toBe(clientSession);
    // server 送信→client 受信の向きで届く。
    serverSession.sendLatest({ v: 7 });
    expect(await collectPayloads(clientSession, 1)).toEqual([{ v: 7 }]);
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});

test("役割と方向が不整合な作成は送出前に拒否する", async () => {
  const { client, server } = createConnectionPair();
  try {
    // client は to_client の送信側になれない。
    await expect(
      client.conn.createSession({ sessionId: "bad-1", kind: "latest", direction: "to_client" }),
    ).rejects.toThrow();
    // server は to_server の送信側になれない。
    await expect(
      server.conn.createSession({ sessionId: "bad-2", kind: "latest", direction: "to_server" }),
    ).rejects.toThrow();
    // 種別と方向の組合せ違反も送出前に拒否する。型で禁じる組合せのため動的に組む。
    const reliableMismatch = {
      sessionId: "bad-3",
      kind: "reliable",
      direction: "to_client",
    } as unknown as ReliableCreateSessionRequest;
    await expect(client.conn.createSession(reliableMismatch)).rejects.toThrow();
    const latestMismatch = {
      sessionId: "bad-4",
      kind: "latest",
      direction: "bidirectional",
    } as unknown as LatestCreateSessionRequest;
    await expect(server.conn.createSession(latestMismatch)).rejects.toThrow();
    // 拒否した分は登録に残らない。
    expect(client.conn.sessionCount).toBe(0);
    expect(server.conn.sessionCount).toBe(0);
    expect(client.sessions).toHaveLength(0);
    expect(server.sessions).toHaveLength(0);
    // 同名の二重作成は拒否する。
    await client.conn.createSession({
      sessionId: "dup-out",
      kind: "reliable",
      direction: "bidirectional",
    });
    await expect(
      client.conn.createSession({
        sessionId: "dup-out",
        kind: "reliable",
        direction: "bidirectional",
      }),
    ).rejects.toThrow();
    expect(client.conn.sessionCount).toBe(1);
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});

test("重複sessionIdの新規streamはRSTし既存Sessionを維持する", async () => {
  const duplex = createDuplex();
  const sessions: Session[] = [];
  const serverConn = new Connection({
    transport: duplex.inboundPipe,
    role: "server",
    connectionId: "conn-1",
    scheduler: new FakeScheduler(),
    onSession: (session) => {
      sessions.push(session);
    },
  });
  const raw = createRawMuxer(duplex.outboundPipe);
  try {
    const first = await openRawSession(raw, {
      connectionId: "conn-1",
      sessionId: "dup",
      kind: "reliable",
      direction: "bidirectional",
    });
    await waitFor(() => sessions.length === 1, 5000, "初回 Session の登録");
    const kept = sessions[0]!;
    expect(serverConn.getSession("dup")).toBe(kept);
    // 同名の新規 stream は RST される。
    const second = await openRawSession(raw, {
      connectionId: "conn-1",
      sessionId: "dup",
      kind: "reliable",
      direction: "bidirectional",
    });
    await waitStreamClose(second);
    // 既存は維持され、通知も増えない。
    expect(serverConn.getSession("dup")).toBe(kept);
    expect(serverConn.sessionCount).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(kept.isAlive).toBe(true);
    // 既存 Session は送受信できる。
    await requireReliable(kept).sendReliable({ n: 1 });
    const frames = await collectRawFrames(first, 1);
    const parsed = parseBridgeMessage(frames[0]);
    expect(parsed.type).toBe("data");
    first.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "data",
        connectionId: "conn-1",
        sessionId: "dup",
        payload: { n: 2 },
      }),
    );
    expect(await collectPayloads(kept, 1)).toEqual([{ n: 2 }]);
  } finally {
    serverConn.terminate(new Error("片付け"));
    await raw.muxer.close().catch(() => undefined);
  }
});

test("初回フレーム不正・宛先不一致・方向不整合は当該streamのみRSTする", async () => {
  const duplex = createDuplex();
  const sessions: Session[] = [];
  const serverConn = new Connection({
    transport: duplex.inboundPipe,
    role: "server",
    connectionId: "conn-1",
    scheduler: new FakeScheduler(),
    onSession: (session) => {
      sessions.push(session);
    },
  });
  const raw = createRawMuxer(duplex.outboundPipe);
  try {
    // 正常な Session を先に開く（他への影響を見張る）。
    const healthy = await openRawSession(raw, {
      connectionId: "conn-1",
      sessionId: "ok-1",
      kind: "reliable",
      direction: "bidirectional",
    });
    await waitFor(() => sessions.length === 1, 5000, "正常 Session の登録");
    const healthySession = sessions[0]!;

    // 初回が data（create_session 以外）は RST する。
    const notHandshake = await raw.muxer.createStream();
    notHandshake.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "data",
        connectionId: "conn-1",
        sessionId: "ok-1",
        payload: { n: 0 },
      }),
    );
    await waitStreamClose(notHandshake);

    // 宛先不一致は RST する。
    const wrongConn = await openRawSession(raw, {
      connectionId: "conn-other",
      sessionId: "ok-2",
      kind: "reliable",
      direction: "bidirectional",
    });
    await waitStreamClose(wrongConn);

    // 方向と役割の不整合（server 受信側に to_client 作成）は RST する。
    const wrongDir = await openRawSession(raw, {
      connectionId: "conn-1",
      sessionId: "ok-3",
      kind: "latest",
      direction: "to_client",
    });
    await waitStreamClose(wrongDir);

    // 種別と方向の組合せ違反は RST する。
    const wrongCombo = await raw.muxer.createStream();
    wrongCombo.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "create_session",
        connectionId: "conn-1",
        sessionId: "ok-4",
        kind: "reliable",
        direction: "to_client",
      }),
    );
    await waitStreamClose(wrongCombo);

    // framing 破損は RST する。
    const broken = await raw.muxer.createStream();
    broken.send(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x7b, 0x7d]));
    await waitStreamClose(broken);

    // 不正は登録に残らず、正常 Session は継続する。
    expect(sessions).toHaveLength(1);
    expect(serverConn.sessionCount).toBe(1);
    expect(healthySession.isAlive).toBe(true);
    await requireReliable(healthySession).sendReliable({ n: 9 });
    const frames = await collectRawFrames(healthy, 1);
    expect(parseBridgeMessage(frames[0])).toMatchObject({ type: "data" });
  } finally {
    serverConn.terminate(new Error("片付け"));
    await raw.muxer.close().catch(() => undefined);
  }
});

test("client側の受信不整合（to_server作成）もRSTする", async () => {
  const duplex = createDuplex();
  const sessions: Session[] = [];
  const clientConn = new Connection({
    transport: duplex.outboundPipe,
    role: "client",
    connectionId: "conn-1",
    scheduler: new FakeScheduler(),
    onSession: (session) => {
      sessions.push(session);
    },
  });
  const raw = createRawMuxer(duplex.inboundPipe);
  try {
    // client 受信側に to_server 作成は不整合である（送信側は client のはず）。
    const wrongDir = await openRawSession(raw, {
      connectionId: "conn-1",
      sessionId: "bad-1",
      kind: "latest",
      direction: "to_server",
    });
    await waitStreamClose(wrongDir);
    expect(sessions).toHaveLength(0);
    expect(clientConn.sessionCount).toBe(0);
  } finally {
    clientConn.terminate(new Error("片付け"));
    await raw.muxer.close().catch(() => undefined);
  }
});

test("GoAwayで全Sessionが終端し輸送は閉じない", async () => {
  const { duplex, client, server } = createConnectionPair();
  try {
    const clientFirst = await client.conn.createSession({
      sessionId: "go-1",
      kind: "reliable",
      direction: "bidirectional",
    });
    const clientSecond = await client.conn.createSession({
      sessionId: "go-2",
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverFirst = await waitInboundSession(server, 0);
    const serverSecond = await waitInboundSession(server, 1);
    const ends = [
      waitSessionEnd(clientFirst),
      waitSessionEnd(clientSecond),
      waitSessionEnd(serverFirst),
      waitSessionEnd(serverSecond),
    ];
    client.conn.terminate(new Error("goaway-test"));
    // 全 Session が Connection 終端として終わる。
    for (const end of ends) {
      expect((await end).kind).toBe("connection-closed");
    }
    // 両 Connection が閉じ、二重通知はない。
    await waitFor(
      () => client.closes.length === 1 && server.closes.length === 1,
      5000,
      "両側の終端通知",
    );
    client.conn.terminate(new Error("goaway-again"));
    server.conn.terminate(new Error("goaway-again"));
    await tick();
    expect(client.closes).toHaveLength(1);
    expect(server.closes).toHaveLength(1);
    expect(client.conn.closed).toBe(true);
    expect(server.conn.closed).toBe(true);
    expect(client.conn.sessionCount).toBe(0);
    // muxer は閉じるが輸送は閉じない。
    expect(duplex.outboundPipe.status).toBe("open");
    expect(duplex.inboundPipe.status).toBe("open");
    // 終端後の作成は拒否する。
    await expect(
      client.conn.createSession({
        sessionId: "go-3",
        kind: "reliable",
        direction: "bidirectional",
      }),
    ).rejects.toThrow();
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});

test("終了したSession名は再利用でき旧コールバックは後継を消さない", async () => {
  const { client, server } = createConnectionPair();
  try {
    const first = await client.conn.createSession({
      sessionId: "reuse",
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverFirst = await waitInboundSession(server, 0);
    const firstEnd = waitSessionEnd(first);
    const serverFirstEnd = waitSessionEnd(serverFirst);
    first.abort(new Error("作り直し"));
    expect((await firstEnd).kind).toBe("aborted");
    expect((await serverFirstEnd).kind).toBe("aborted");
    await waitFor(
      () => client.conn.getSession("reuse") === undefined,
      5000,
      "終了 Session の登録解除",
    );
    // 同名で作り直せる。
    const second = await client.conn.createSession({
      sessionId: "reuse",
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverSecond = await waitInboundSession(server, 1);
    expect(client.conn.getSession("reuse")).toBe(second);
    expect(server.conn.getSession("reuse")).toBe(serverSecond);
    // 後継で送受信できる（旧終了の影響はない）。
    await second.sendReliable({ n: 3 });
    expect(await collectPayloads(serverSecond, 1)).toEqual([{ n: 3 }]);
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});

test("keepaliveをmux開始時に組み込み終了開始で止める", async () => {
  const { client, server } = createConnectionPair();
  try {
    // 開始時に次回 Ping が予約される。
    expect(client.scheduler.pendingCount).toBe(1);
    expect(server.scheduler.pendingCount).toBe(1);
    // 実 mux 越しの Ping が成功し、次回が予約される。
    client.scheduler.advance(30_000);
    await tick();
    await tick();
    expect(client.scheduler.pendingCount).toBe(1);
    // 正常中は終端通知がない。
    client.scheduler.advance(60_000);
    await tick();
    await tick();
    expect(client.closes).toHaveLength(0);
    expect(server.closes).toHaveLength(0);
    // 終了開始でタイマーを解除し、残留はない。
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
    expect(client.scheduler.pendingCount).toBe(0);
    expect(server.scheduler.pendingCount).toBe(0);
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});

test("輸送の向きと役割の不一致は構築時に拒否する", () => {
  const duplex = createDuplex();
  expect(
    () =>
      new Connection({
        transport: duplex.inboundPipe,
        role: "client",
        connectionId: "conn-1",
      }),
  ).toThrow();
  expect(
    () =>
      new Connection({
        transport: duplex.outboundPipe,
        role: "server",
        connectionId: "conn-1",
      }),
  ).toThrow();
});

test("Session単位の終了・中断をConnection経由で行える", async () => {
  const { client, server } = createConnectionPair();
  try {
    const clientSession = await client.conn.createSession({
      sessionId: "op-1",
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverSession = await waitInboundSession(server, 0);
    // 方向別終了の後は送信できないが受信は継続する。
    await client.conn.closeSessionWrite("op-1");
    await expect(clientSession.sendReliable({ n: 1 })).rejects.toThrow();
    await requireReliable(serverSession).sendReliable({ n: 2 });
    expect(await collectPayloads(clientSession, 1)).toEqual([{ n: 2 }]);
    // 不在の操作は拒否する（同期 throw）。
    expect(() => client.conn.closeSessionWrite("missing")).toThrow();
    expect(() => client.conn.abortSession("missing")).toThrow();
    // 個別中断は対象だけを終える。
    const end = waitSessionEnd(serverSession);
    client.conn.abortSession("op-1", new Error("個別中断"));
    expect((await end).kind).toBe("aborted");
    expect(server.conn.sessionCount).toBe(0);
    expect(server.conn.closed).toBe(false);
  } finally {
    client.conn.terminate(new Error("片付け"));
    server.conn.terminate(new Error("片付け"));
  }
});
