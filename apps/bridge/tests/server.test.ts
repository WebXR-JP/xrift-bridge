import { afterEach, expect, test } from "vite-plus/test";
import { connect } from "node:net";
import { WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  formatPairingCode,
  parseBridgeMessage,
  type BridgeMessage,
} from "bridge-protocol";
import {
  createBridgeServer,
  type BridgeOptions,
  type BridgeServer,
  type BridgeTransport,
} from "../src/server.ts";
import { handleCommand } from "../src/index.ts";
import type { BridgeLogEvent } from "../src/log.ts";

const PROD_ORIGIN = "https://app.xrift.net";
const DEV_ORIGIN = "http://localhost:5173";

const servers: BridgeServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // 終了済みは無視する。
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

/** 受信値をテキスト化する。 */
function rawToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data).toString("utf-8");
}

/**
 * 継続購読＋受信バッファ＋条件一致待ちの受信器。
 *
 * 作成時点から購読し続けるため `pairing_pending` 直後の `auth_ok` を取りこぼさない。
 * 既知の `credit` は目的応答待ちの間に消費するが、未知の異常フレームは
 * 無条件に読み飛ばさず明示失敗にする。固定 sleep・再試行による隠蔽はしない。
 */
class FrameCollector {
  private readonly frames: string[] = [];
  private readonly waiters = new Set<() => void>();
  private closed: { code: number; reason: string } | null = null;
  private readonly closeWaiters = new Set<(value: { code: number; reason: string }) => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      this.frames.push(rawToText(data));
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

  /** バッファ内の先頭から目的応答を探し、既知の credit だけを消費する。 */
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
        // 目的応答より前の非 credit を無条件に読み飛ばさない。
        for (let prior = 0; prior < index; prior += 1) {
          const priorRaw = this.frames[prior];
          if (priorRaw === undefined) continue;
          const priorParsed = parseBridgeMessage(priorRaw);
          if (priorParsed.type !== "credit") {
            throw new Error(`目的応答の前に想定外フレームを受信した: ${priorRaw.slice(0, 300)}`);
          }
        }
        this.frames.splice(0, index + 1);
        return { raw, message: parsed };
      }
    }
    return null;
  }

  /**
   * 条件に一致する受信を待つ。
   *
   * 先頭の既知 credit は消費して待ち続け、未知の異常フレームは失敗にする。
   */
  async waitFor(
    predicate: (message: BridgeMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    const matched = this.takeMatch(predicate);
    if (matched !== null) return matched;
    // 先頭が未知の異常なら即失敗し、credit だけなら消費して待ち続ける。
    if (this.frames.length > 0) {
      const first = this.frames[0];
      if (first !== undefined) {
        const parsed = parseBridgeMessage(first);
        if (parsed.type !== "credit") {
          throw new Error(`目的応答と異なるフレームを受信した: ${first.slice(0, 300)}`);
        }
        this.frames.shift();
        return this.waitFor(predicate, timeoutMs);
      }
    }
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
      if (this.frames.length > 0) {
        const first = this.frames[0];
        if (first !== undefined) {
          const parsed = parseBridgeMessage(first);
          if (parsed.type !== "credit") {
            throw new Error(`目的応答と異なるフレームを受信した: ${first.slice(0, 300)}`);
          }
          this.frames.shift();
        }
      }
    }
  }

  /** 指定コードの明示エラーを待つ。 */
  async waitForErrorCode(
    code: string,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    return this.waitFor((message) => message.type === "error" && message.code === code, timeoutMs);
  }

  /** 指定種別の受信を待つ。 */
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

/**
 * credit 履歴を残す受信器。
 *
 * 既存の `FrameCollector` は待機中の credit を読み飛ばすため、補充の観測には
 * 使えない。ここでは credit を破棄せず履歴に残し、目的応答の探索でも残す。
 * 想定外フレームの有無は各試験の最後に `framesOf`・`creditLimits` で asserts する。
 */
class CreditHistoryCollector {
  private readonly frames: string[] = [];
  private readonly waiters = new Set<() => void>();
  private closed: { code: number; reason: string } | null = null;
  private readonly closeWaiters = new Set<(value: { code: number; reason: string }) => void>();
  /** 受信した credit の `limit` 履歴（受信順）。 */
  readonly creditLimits: number[] = [];
  /** 受信した credit のセッション履歴（受信順）。 */
  readonly creditSessions: string[] = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const raw = rawToText(data);
      this.frames.push(raw);
      try {
        const parsed = parseBridgeMessage(raw);
        if (parsed.type === "credit") {
          this.creditLimits.push(parsed.limit);
          this.creditSessions.push(parsed.sessionId);
        }
      } catch {
        // 非準拠フレームの扱いは各試験の asserts に任せる。
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

  /** 受信フレームの写し（生テキスト、受信順）。 */
  allFrames(): string[] {
    return [...this.frames];
  }

  /** 切断していれば内容、していなければ `null`。 */
  closeState(): { code: number; reason: string } | null {
    return this.closed;
  }

  /** 条件に一致する最初の受信を取り出して待つ。credit は残し続ける。 */
  async waitFor(
    predicate: (message: BridgeMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      for (let index = 0; index < this.frames.length; index += 1) {
        const raw = this.frames[index];
        if (raw === undefined) continue;
        const parsed = parseBridgeMessage(raw);
        if (predicate(parsed)) {
          this.frames.splice(index, 1);
          return { raw, message: parsed };
        }
      }
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
    }
  }

  /** 指定の `limit` を超える credit 通知を待つ。 */
  async waitForCreditAbove(threshold: number, timeoutMs = 3_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const found = this.creditLimits.find((limit) => limit > threshold);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) {
        throw new Error(`limit が ${threshold} を超える credit を観測できない。`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

/** 接続直後から履歴収集で購読する送受信器を開く。 */
async function openHistoryCollected(
  url: string,
  origin: string,
): Promise<{ socket: WebSocket; collector: CreditHistoryCollector }> {
  const socket = await openRaw(url, origin);
  const collector = new CreditHistoryCollector(socket);
  return { socket, collector };
}

/**
 * 送信完了の通知を試験側で保留・解放できる差し替え送信路。
 *
 * 実サーバの会計経路に挿し、応答フレームのバイトは即時転送しつつ完了通知だけ
 * 保留する。制御フレーム（認証・エラー・credit 通知は対象外）は即時完了させる。
 */
function createHeldTransport(): {
  transport: BridgeTransport;
  /** 転送済みフレームの生テキスト（送信順）。 */
  forwarded: string[];
  /** 保留中の応答完了の数。 */
  heldResponses(): number;
  /** 最も古い保留を1件完了させる。 */
  releaseOne(): void;
  /** 保留をすべて完了させる。 */
  releaseAll(): void;
} {
  const forwarded: string[] = [];
  const pending: Array<(error: Error | null) => void> = [];
  return {
    transport: {
      send: (socket, text, done) => {
        forwarded.push(text);
        let holdsResponse = false;
        try {
          const parsed = parseBridgeMessage(text);
          holdsResponse = parsed.type === "echo_response" || parsed.type === "command_response";
        } catch {
          // 非準拠フレームは試験対象外のため即時完了扱いにする。
        }
        socket.send(text);
        if (holdsResponse) {
          pending.push(done);
          return;
        }
        done(null);
      },
    },
    forwarded,
    heldResponses: () => pending.length,
    releaseOne: () => {
      const done = pending.shift();
      if (done === undefined) throw new Error("解放できる保留がない。");
      done(null);
    },
    releaseAll: () => {
      let done = pending.shift();
      while (done !== undefined) {
        done(null);
        done = pending.shift();
      }
    },
  };
}

/** 指定時間だけ credit が増えないことを確かめる。増加があれば即失敗する。 */
async function expectNoNewCredit(
  collector: CreditHistoryCollector,
  baseline: number,
  timeoutMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collector.creditLimits.length > baseline) {
      throw new Error("保留中に再付与されており容量が解放されていない。");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(collector.creditLimits).toHaveLength(baseline);
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
): Promise<{ socket: WebSocket; collector: FrameCollector }> {
  const socket = await openRaw(url, origin);
  const collector = new FrameCollector(socket);
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

function echoMessage(sessionId: string, streamId: string, seq: number, requestId: string): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId,
    streamId,
    kind: "reliable",
    seq,
    requestId,
    payload: "x",
  });
}

function commandMessage(
  sessionId: string,
  streamId: string,
  seq: number,
  requestId: string,
  command = "ping",
): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "command_request",
    sessionId,
    streamId,
    kind: "reliable",
    seq,
    requestId,
    command,
  });
}

function dataLatestMessage(
  sessionId: string,
  streamId: string,
  seq: number,
  payload: unknown,
): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "data",
    sessionId,
    streamId,
    kind: "latest",
    seq,
    payload,
  });
}

/**
 * 開始→保留通知→承認→認可の往復を行い、認可情報を返す。
 *
 * ワールド画面の受信コードと管理側の保留コードが一致することも確かめる。
 * 両画面の表示が食い違えば承認対象を取り違えるため、ここで検出する。
 */
async function authorizeCollected(
  server: BridgeServer,
  socket: WebSocket,
  collector: FrameCollector,
): Promise<{ sessionId: string; requestId: string; window: number }> {
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
  return {
    sessionId: ok.message.sessionId,
    requestId: pendingRequestId,
    window: ok.message.window,
  };
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

test("受付開後のpairing_pending通知と承認後にだけ業務処理が動く", async () => {
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
  expect(typeof ok.message.sessionId).toBe("string");
  expect(ok.message.window).toBeGreaterThan(0);

  // 承認成功だけでは受付は閉じない。
  expect(server.getAcceptance().state).toBe("open");

  // 承認後に業務が動く。
  socket.send(echoMessage(ok.message.sessionId, "main", 0, "r-echo-1"));
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-echo-1",
  );
  expect(echoed.message.type).toBe("echo_response");
  socket.send(commandMessage(ok.message.sessionId, "main", 1, "r-ping-1"));
  const pong = await collector.waitFor(
    (message) => message.type === "command_response" && message.requestId === "r-ping-1",
  );
  if (pong.message.type !== "command_response") throw new Error("コマンド応答ではない。");
  expect(pong.message.ok).toBe(true);
  socket.send(dataLatestMessage(ok.message.sessionId, "pose", 0, { x: 1 }));
  socket.send(echoMessage(ok.message.sessionId, "main", 2, "r-flush-1"));
  await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-flush-1",
  );
  expect(server.getLatest("pose")).toEqual({ x: 1 });

  const stats = server.getStats();
  expect(stats.pairingSuccess).toBe(1);
  expect(stats.echoCount).toBe(2);
  expect(stats.commandCount).toBe(1);

  // 比較コードがログに出ていない。
  const logged = JSON.stringify(captured.events);
  expect(logged).not.toContain(pending.message.code);
});

test("認可前のecho・command・data・creditは拒否し業務状態を変えない", async () => {
  const server = await startServer();
  server.openAcceptance();
  // `credit` は逆方向メッセージのため `UNEXPECTED_DIRECTION` で終端する。
  // いずれも認可前の終端エラーであり、業務状態を変えない。
  const cases: Array<{ name: string; build: () => string; code: string }> = [
    {
      name: "echo",
      build: () =>
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "echo",
          sessionId: "none",
          streamId: "main",
          kind: "reliable",
          seq: 0,
          requestId: "r-pre-echo",
          payload: "x",
        }),
      code: "NOT_AUTHORIZED",
    },
    {
      name: "command",
      build: () => commandMessage("none", "main", 0, "r-pre-cmd"),
      code: "NOT_AUTHORIZED",
    },
    {
      name: "data",
      build: () => dataLatestMessage("none", "pose", 0, { x: 9 }),
      code: "NOT_AUTHORIZED",
    },
    {
      name: "credit",
      build: () =>
        JSON.stringify({ v: PROTOCOL_VERSION, type: "credit", sessionId: "none", limit: 8 }),
      code: "UNEXPECTED_DIRECTION",
    },
  ];
  for (const target of cases) {
    const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
    const closed = collector.waitClose();
    socket.send(target.build());
    const error = await collector.waitForErrorCode(target.code);
    expect(error.message.type, target.name).toBe("error");
    if (error.message.type === "error") {
      // 認可前は sessionId を含めない。
      expect(error.message.sessionId, target.name).toBeUndefined();
    }
    const result = await closed;
    expect(result.code, target.name).toBe(1008);
  }
  // 業務カウンタ・受信箱・クレジット付与が未変更である。
  const stats = server.getStats();
  expect(stats.echoCount).toBe(0);
  expect(stats.commandCount).toBe(0);
  expect(stats.latestStored).toBe(0);
  expect(server.getLatest("pose")).toBeUndefined();
  expect(stats.pairingSuccess).toBe(0);
  expect(stats.pairingFailure).toBe(4);
  expect(stats.rejectionsByReason["NOT_AUTHORIZED"]).toBe(3);
  expect(stats.rejectionsByReason["UNEXPECTED_DIRECTION"]).toBe(1);
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
      raw: JSON.stringify({ v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: 1 }),
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
    expect(error.message.sessionId).toBeUndefined();
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
  const authorized: Array<{ socket: WebSocket; collector: FrameCollector; sessionId: string }> = [];
  for (let index = 0; index < 6; index += 1) {
    const opened = await openCollected(server.endpoint, DEV_ORIGIN);
    const info = await authorizeCollected(server, opened.socket, opened.collector);
    authorized.push({
      socket: opened.socket,
      collector: opened.collector,
      sessionId: info.sessionId,
    });
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
  // 認可済みは業務を続けられる。
  const target = authorized[0];
  if (target === undefined) throw new Error("認可済みがない。");
  target.socket.send(echoMessage(target.sessionId, "main", 0, "r-cap-ok"));
  const echoed = await target.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-cap-ok",
  );
  expect(echoed.message.type).toBe("echo_response");
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
  const keeperAuth = await authorizeCollected(server, keeper.socket, keeper.collector);

  const rejected = server.rejectPairing(pending.message.requestId);
  expect(rejected).toEqual({ status: "REJECTED" });
  const error = await target.collector.waitForErrorCode("PAIRING_REJECTED");
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.requestId).toBe(pending.message.requestId);
  expect(await closed).toMatchObject({ code: 1008 });
  expect(server.listPending()).toHaveLength(0);
  expect(server.rejectPairing(pending.message.requestId)).toEqual({ status: "NOT_PENDING" });

  // 認可済みは影響なく業務を続けられる。
  keeper.socket.send(echoMessage(keeperAuth.sessionId, "main", 0, "r-keep-ok"));
  const echoed = await keeper.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-keep-ok",
  );
  expect(echoed.message.type).toBe("echo_response");
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
  await authorizeCollected(first, keeper.socket, keeper.collector);
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
  const keeperAuth = await authorizeCollected(server, keeper.socket, keeper.collector);

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

  // 認可済みは維持され業務を続けられる。
  keeper.socket.send(echoMessage(keeperAuth.sessionId, "main", 0, "r-drain-keep"));
  const echoed = await keeper.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-drain-keep",
  );
  expect(echoed.message.type).toBe("echo_response");

  // 閉の冪等性。二度目の close でも認可済みは残る。
  server.closeAcceptance();
  keeper.socket.send(echoMessage(keeperAuth.sessionId, "main", 1, "r-drain-keep2"));
  const second = await keeper.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-drain-keep2",
  );
  expect(second.message.type).toBe("echo_response");
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

// ---------- 既存の検証（新認可経路へ適応） ----------

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

test("latest は受信箱に最新値を残す", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  socket.send(dataLatestMessage(auth.sessionId, "pose", 0, { x: 1 }));
  socket.send(dataLatestMessage(auth.sessionId, "pose", 1, { x: 2 }));
  // latest に応答はないため、後続の reliable 往復で受信処理の完了を確定させる。
  socket.send(echoMessage(auth.sessionId, "main", 0, "r-flush-latest"));
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-flush-latest",
  );
  expect(echoed.message.type).toBe("echo_response");
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  expect(server.getStats().latestStored).toBe(2);
});

test("小容量でも補充で上限超の往復を続けられる（枯渇デッドロックの回帰）", async () => {
  // 初期 2・上限 4 で 10 往復する。補充がなければ 5 件目で止まるため、
  // 既定 256 件での 8 往復では証明できない。件数容量を超える反復で確認する。
  const server = await startServer({
    limits: { initialCreditWindow: 2, maxReliableQueueMessages: 4 },
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const approved = server.approvePairing(pending.message.requestId, pending.message.code);
  expect(approved.status).toBe("APPROVED");
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  expect(ok.message.window).toBe(2);
  const sessionId = ok.message.sessionId;
  for (let index = 0; index < 10; index += 1) {
    socket.send(echoMessage(sessionId, "main", index, `r-echo-${index}`));
    const echoed = await collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === `r-echo-${index}`,
    );
    expect(echoed.message.type).toBe("echo_response");
    if (echoed.message.type !== "echo_response") throw new Error("echo 応答ではない。");
    expect(echoed.message.seq).toBe(index);
  }
  // 途中で切断されておらず、容量不足の記録も残らない。
  expect(collector.closeState()).toBeNull();
  expect(server.getStats().queueFull).toBe(0);
  expect(server.getStats().echoCount).toBe(10);
});

test("ストリーム内連番の飛びを拒否する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  socket.send(echoMessage(auth.sessionId, "main", 5, "r-skip"));
  // auth_ok 直後の credit を消費しつつ目的の明示エラーを待つ。
  const error = await collector.waitForErrorCode("UNEXPECTED_SEQ");
  expect(error.message.type).toBe("error");
});

test("受信上限の超過は close 1009 で通知する", async () => {
  const server = await startServer({ limits: { maxMessageBytes: 256 } });
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  await authorizeCollected(server, socket, collector);
  const closed = collector.waitClose();
  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "echo",
      sessionId: "s",
      streamId: "main",
      kind: "reliable",
      seq: 0,
      requestId: "r-big",
      payload: "x".repeat(1024),
    }),
  );
  const result = await closed;
  // 受信上限は UTF-8 の JSON テキストのバイト数であり、分割フレームも合算する。
  // 超過時は maxPayload による close 1009 で通知する。
  expect(result.code).toBe(1009);
});

test("QUEUE_FULL は小さい上限設定で決定的に発生し明示エラーと切断になる", async () => {
  // 単一応答でバイト上限を超える設定にし、flush の競合なく決定的に発生させる。
  const server = await startServer({ limits: { maxReliableQueueBytes: 16 } });
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  const closed = collector.waitClose();
  socket.send(echoMessage(auth.sessionId, "main", 0, "r-queue-full"));
  const error = await collector.waitForErrorCode("QUEUE_FULL");
  expect(error.message.type).toBe("error");
  if (error.message.type === "error") {
    expect(error.message.requestId).toBe("r-queue-full");
  }
  const result = await closed;
  expect(result.code).toBe(1011);
  expect(server.getStats().queueFull).toBeGreaterThanOrEqual(1);
});

test("SESSION_MISMATCH は拒否し対象業務を処理しない", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  const before = server.getStats().echoCount;
  socket.send(echoMessage("wrong-session", "main", 0, "r-mismatch"));
  const error = await collector.waitForErrorCode("SESSION_MISMATCH");
  expect(error.message.type).toBe("error");
  expect(server.getStats().echoCount).toBe(before);
  // 正規セッションの連番は進んでいない。
  socket.send(echoMessage(auth.sessionId, "main", 0, "r-mismatch-ok"));
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-mismatch-ok",
  );
  expect(echoed.message.type).toBe("echo_response");
});

test("STREAM_LIMIT は拒否し対象業務を処理しない", async () => {
  const server = await startServer({ limits: { maxStreamsPerConnection: 2 } });
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  const sessionId = auth.sessionId;
  socket.send(echoMessage(sessionId, "s1", 0, "r-s1"));
  await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-s1",
  );
  socket.send(echoMessage(sessionId, "s2", 0, "r-s2"));
  await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-s2",
  );
  const before = server.getStats().echoCount;
  socket.send(echoMessage(sessionId, "s3", 0, "r-s3"));
  const error = await collector.waitForErrorCode("STREAM_LIMIT");
  expect(error.message.type).toBe("error");
  if (error.message.type === "error") {
    expect(error.message.requestId).toBe("r-s3");
  }
  expect(server.getStats().echoCount).toBe(before);
});

test("UNEXPECTED_DIRECTION は拒否し対象業務を処理しない", async () => {
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  const beforeEcho = server.getStats().echoCount;
  const beforeCommand = server.getStats().commandCount;
  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "credit",
      sessionId: auth.sessionId,
      limit: 8,
    }),
  );
  const error = await collector.waitForErrorCode("UNEXPECTED_DIRECTION");
  expect(error.message.type).toBe("error");
  expect(server.getStats().echoCount).toBe(beforeEcho);
  expect(server.getStats().commandCount).toBe(beforeCommand);
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
  const collector = new FrameCollector(opened);
  const auth = await authorizeCollected(server, opened, collector);
  expect(auth.sessionId).not.toBe("");
  // 上限保証は維持する。1枠の使用中に次の upgrade は拒否される。
  expect(server.getConnectionCount()).toBe(1);
  await expect(openRaw(server.endpoint, DEV_ORIGIN)).rejects.toThrow();
  opened.terminate();
  await waitForCondition(() => server.getConnectionCount() === 0);
});

test("応答キューの容量は UTF-8 バイトで計上する（上限ちょうど・上限超過）", async () => {
  const payloads = [
    { name: "ascii", value: "hello-ascii" },
    { name: "日本語", value: "こんにちは世界" },
    { name: "絵文字", value: "😀🎉🌊" },
  ] as const;
  for (const payload of payloads) {
    const authorizeOn = async (
      target: BridgeServer,
    ): Promise<{ socket: WebSocket; collector: FrameCollector; sessionId: string }> => {
      const opened = await openCollected(target.endpoint, DEV_ORIGIN);
      const auth = await authorizeCollected(target, opened.socket, opened.collector);
      return { socket: opened.socket, collector: opened.collector, sessionId: auth.sessionId };
    };
    // 実応答のバイト数を大きな上限で実測する。要求IDは固定長にし、
    // 応答サイズが測定時と検証時で変わらないようにする。
    let currentServer = await startServer();
    currentServer.openAcceptance();
    const probe = await authorizeOn(currentServer);
    probe.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: probe.sessionId,
        streamId: "main",
        kind: "reliable",
        seq: 0,
        requestId: "r-queue-0001",
        payload: payload.value,
      }),
    );
    const response = await probe.collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === "r-queue-0001",
    );
    const responseBytes = Buffer.byteLength(response.raw, "utf8");
    // 上限ちょうどは受理される。
    currentServer = await startServer({ limits: { maxReliableQueueBytes: responseBytes } });
    currentServer.openAcceptance();
    const openedExact = await authorizeOn(currentServer);
    openedExact.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: openedExact.sessionId,
        streamId: "main",
        kind: "reliable",
        seq: 0,
        requestId: "r-queue-0001",
        payload: payload.value,
      }),
    );
    const echoed = await openedExact.collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === "r-queue-0001",
    );
    expect(echoed.message.type, payload.name).toBe("echo_response");
    // 1バイト不足は明示エラーと切断になる。
    currentServer = await startServer({ limits: { maxReliableQueueBytes: responseBytes - 1 } });
    currentServer.openAcceptance();
    const openedTight = await authorizeOn(currentServer);
    const closed = openedTight.collector.waitClose();
    openedTight.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: openedTight.sessionId,
        streamId: "main",
        kind: "reliable",
        seq: 0,
        requestId: "r-queue-0001",
        payload: payload.value,
      }),
    );
    const queueError = await openedTight.collector.waitForErrorCode("QUEUE_FULL");
    expect(queueError.message.type).toBe("error");
    const closeResult = await closed;
    expect(closeResult.code).toBe(1011);
  }
});

test("指定接続だけを切断し他接続は維持する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const firstOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  const firstAuth = await authorizeCollected(server, firstOpened.socket, firstOpened.collector);
  const secondOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  const secondAuth = await authorizeCollected(server, secondOpened.socket, secondOpened.collector);
  void firstAuth;
  void secondAuth;
  // 未認証接続にもIDを払い出す。
  const raw = await openRaw(server.endpoint, DEV_ORIGIN);
  void new FrameCollector(raw);
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
  const targetSocket =
    firstOpened.socket.readyState === WebSocket.OPEN ? firstOpened : secondOpened;
  void targetSocket;
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

test("複数ストリームの連番は独立し片方の飛びが他方に影響しない", async () => {
  // 各ストリームが 0 から始まる独立採番であること、片方の欠番エラーが
  // 他方の期待値も自ストリームの期待値も進めないことを確かめる。
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const auth = await authorizeCollected(server, socket, collector);
  const sessionId = auth.sessionId;

  const waitEcho = async (streamId: string, seq: number, requestId: string): Promise<void> => {
    socket.send(echoMessage(sessionId, streamId, seq, requestId));
    const echoed = await collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === requestId,
    );
    expect(echoed.message.type).toBe("echo_response");
    if (echoed.message.type !== "echo_response") throw new Error("echo 応答ではない。");
    // 応答が要求したストリーム・連番に対応している。
    expect(echoed.message.streamId).toBe(streamId);
    expect(echoed.message.seq).toBe(seq);
  };

  // 交互に送っても両方が 0 から始まる。全体通し番号なら sB の 0 が拒否される。
  await waitEcho("sA", 0, "r-a0");
  await waitEcho("sB", 0, "r-b0");
  await waitEcho("sA", 1, "r-a1");
  await waitEcho("sB", 1, "r-b1");

  // sA だけ連番を飛ばすとその要求だけが明示エラーになる。
  const before = server.getStats().echoCount;
  socket.send(echoMessage(sessionId, "sA", 5, "r-a-skip"));
  const error = await collector.waitForErrorCode("UNEXPECTED_SEQ");
  expect(error.message.type).toBe("error");
  if (error.message.type === "error") {
    expect(error.message.requestId).toBe("r-a-skip");
  }
  // 飛びは処理件数に数えない。
  expect(server.getStats().echoCount).toBe(before);

  // 他方は影響なく続けられる。
  await waitEcho("sB", 2, "r-b2");
  // 飛ばした側も正しい連番を送れば再開できる。エラーで期待値は進んでいない。
  await waitEcho("sA", 2, "r-a2");
});

test("切断後は接続枠と接続別状態が残らず新接続が使える", async () => {
  // 枠上限 1 で旧接続を閉じると枠が回復し、新接続の同名ストリームが
  // 連番 0 から始まる（接続別の期待値が破棄された）ことを確かめる。
  const server = await startServer({
    limits: { maxConnections: 1, maxUnauthorizedConnections: 1, maxPendingPairings: 1 },
  });
  server.openAcceptance();
  const firstOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  const firstAuth = await authorizeCollected(server, firstOpened.socket, firstOpened.collector);
  firstOpened.socket.send(dataLatestMessage(firstAuth.sessionId, "pose", 0, { x: 1 }));
  firstOpened.socket.send(echoMessage(firstAuth.sessionId, "main", 0, "r-first"));
  const firstEcho = await firstOpened.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-first",
  );
  expect(firstEcho.message.type).toBe("echo_response");
  expect(server.getLatest("pose")).toEqual({ x: 1 });
  expect(server.getConnectionCount()).toBe(1);

  firstOpened.socket.terminate();
  await waitForCondition(() => server.getConnectionCount() === 0);
  expect(server.listConnections()).toHaveLength(0);

  // 枠が残っていたら上限 1 のため接続できない。
  const secondOpened = await openCollected(server.endpoint, DEV_ORIGIN);
  const secondAuth = await authorizeCollected(server, secondOpened.socket, secondOpened.collector);
  // 旧接続の期待値が残っていたら seq 0 は UNEXPECTED_SEQ で拒否される。
  secondOpened.socket.send(echoMessage(secondAuth.sessionId, "main", 0, "r-second"));
  const secondEcho = await secondOpened.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-second",
  );
  expect(secondEcho.message.type).toBe("echo_response");
  // 旧接続の latest が新セッションを阻害せず上書きできる。
  secondOpened.socket.send(dataLatestMessage(secondAuth.sessionId, "pose", 0, { x: 2 }));
  secondOpened.socket.send(echoMessage(secondAuth.sessionId, "main", 1, "r-flush-2"));
  const flushed = await secondOpened.collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-flush-2",
  );
  expect(flushed.message.type).toBe("echo_response");
  expect(server.getLatest("pose")).toEqual({ x: 2 });
});

test("raw接続で付与を使い切り新しいcreditで送り続けられる（3周期）", async () => {
  // 初期 2・上限 4。累積 limit を守って送り、付与→送信を3周期回す。
  // 追加付与は容量解放時のみ送るため、認証直後の通知は補充周期に数えない。
  const server = await startServer({
    limits: { initialCreditWindow: 2, maxReliableQueueMessages: 4 },
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  expect(ok.message.window).toBe(2);

  let limit = ok.message.window;
  let sent = 0;
  const sendEcho = (seq: number, requestId: string): void => {
    if (!(sent < limit)) throw new Error("累積 limit を超えて送ろうとした。");
    socket.send(echoMessage(sessionId, "main", seq, requestId));
    sent += 1;
  };
  const waitEcho = async (requestId: string, seq: number): Promise<void> => {
    const echoed = await collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === requestId,
    );
    if (echoed.message.type !== "echo_response") throw new Error("echo 応答ではない。");
    expect(echoed.message.streamId).toBe("main");
    expect(echoed.message.seq).toBe(seq);
  };

  // 周期ごとに1件送り、応答と新しい credit を観測する。
  // 付与式（C=4）から replenishment の履歴は [5, 6, 7] になる。
  const observed: number[] = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    sendEcho(cycle, `r-cycle-${cycle}`);
    await waitEcho(`r-cycle-${cycle}`, cycle);
    limit = await collector.waitForCreditAbove(limit);
    observed.push(limit);
  }
  expect(observed).toEqual([5, 6, 7]);
  expect(collector.creditLimits).toEqual([5, 6, 7]);
  for (const creditSession of collector.creditSessions) {
    expect(creditSession).toBe(sessionId);
  }
  // 使い切った付与でさらに送れる（周期外の確認）。
  sendEcho(3, "r-cycle-3");
  await waitEcho("r-cycle-3", 3);
  const grown = await collector.waitForCreditAbove(limit);
  expect(grown).toBe(8);
  expect(sent).toBe(4);
  // 切断はなく、容量不足の記録も残らない。
  expect(collector.closeState()).toBeNull();
  expect(server.getStats().queueFull).toBe(0);
  expect(server.getStats().echoCount).toBe(4);
});

test("送信完了の保留中は再付与せず1件解放で1件回復する（実会計経路）", async () => {
  // 件数容量 2・初期 2。送信完了の通知を保留できる差し替え送信路で、
  // 保留中は再付与なし→1件解放で累積 +1 を反復確認する。
  const held = createHeldTransport();
  const server = await startServer({
    limits: { initialCreditWindow: 2, maxReliableQueueMessages: 2 },
    transport: held.transport,
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;

  let limit = 2;
  let sent = 0;
  const sendEcho = (seq: number, requestId: string): void => {
    if (!(sent < limit)) throw new Error("累積 limit を超えて送ろうとした。");
    socket.send(echoMessage(sessionId, "main", seq, requestId));
    sent += 1;
  };
  const waitEcho = async (requestId: string, seq: number): Promise<void> => {
    const echoed = await collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === requestId,
    );
    if (echoed.message.type !== "echo_response") throw new Error("echo 応答ではない。");
    expect(echoed.message.seq).toBe(seq);
  };

  // 付与分を使い切る。応答バイトは届くが完了通知は保留される。
  sendEcho(0, "r-h0");
  sendEcho(1, "r-h1");
  await waitEcho("r-h0", 0);
  await waitEcho("r-h1", 1);
  expect(held.heldResponses()).toBe(2);
  // 保留中は再付与しない。
  await expectNoNewCredit(collector, 0);

  // 1件解放で1件分回復する。
  held.releaseOne();
  expect(held.heldResponses()).toBe(1);
  limit = await collector.waitForCreditAbove(limit);
  expect(limit).toBe(3);

  // 次の1件を送り、再び保留で止まる。
  sendEcho(2, "r-h2");
  await waitEcho("r-h2", 2);
  await expectNoNewCredit(collector, 1);

  // 反復：解放→付与→送信を繰り返す。
  held.releaseOne();
  limit = await collector.waitForCreditAbove(limit);
  expect(limit).toBe(4);
  sendEcho(3, "r-h3");
  await waitEcho("r-h3", 3);
  held.releaseOne();
  limit = await collector.waitForCreditAbove(limit);
  expect(limit).toBe(5);
  expect(collector.creditLimits).toEqual([3, 4, 5]);

  // 観測 limit の範囲内で送り、通知の到達より先に枠内送信しても受理される。
  sendEcho(4, "r-h4");
  await waitEcho("r-h4", 4);
  held.releaseOne();
  // credit(6) の到達を待たず、枠内（累積 6 以下）で送る。交差しても安全である。
  socket.send(echoMessage(sessionId, "main", 5, "r-h5"));
  sent += 1;
  await waitEcho("r-h5", 5);
  limit = await collector.waitForCreditAbove(limit);
  expect(limit).toBe(6);
  expect(sent).toBe(6);
  expect(collector.closeState()).toBeNull();
  expect(server.getStats().queueFull).toBe(0);
  expect(server.getStats().echoCount).toBe(6);
});

test("付与超過のreliableは業務処理前に明示拒否して切断する", async () => {
  // 初期 2・上限 4。応答の送信完了を保留できる差し替え送信路で、
  // 3件目の到達前に容量が解放→追加付与される経路を塞ぎ、決定的に超過させる。
  // 製品挙動は変えず、順序依存だけを試験側で固定する。
  const held = createHeldTransport();
  const server = await startServer({
    limits: { initialCreditWindow: 2, maxReliableQueueMessages: 4 },
    transport: held.transport,
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  const closed = collector.waitClose();
  socket.send(echoMessage(sessionId, "main", 0, "r-o0"));
  socket.send(echoMessage(sessionId, "main", 1, "r-o1"));
  socket.send(echoMessage(sessionId, "main", 2, "r-o2"));
  const error = await collector.waitFor(
    (message) => message.type === "error" && message.code === "CREDIT_EXHAUSTED",
  );
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.code).toBe("CREDIT_EXHAUSTED");
  expect(error.message.requestId).toBe("r-o2");
  const result = await closed;
  expect(result.code).toBe(1011);
  // 超過分は業務処理されていない。
  expect(server.getStats().echoCount).toBe(2);
});

test("連番誤りで拒否した要求の枠は失われない", async () => {
  // 初期 1・上限 2。拒否で消費分を解放しなければ次の正規送信が止まる。
  const server = await startServer({
    limits: { initialCreditWindow: 1, maxReliableQueueMessages: 2 },
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  // 連番を飛ばすと UNEXPECTED_SEQ で拒否され、予約の解放で追加付与が出る。
  socket.send(echoMessage(sessionId, "main", 5, "r-bad"));
  const error = await collector.waitFor((message) => message.type === "error");
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.code).toBe("UNEXPECTED_SEQ");
  expect(collector.creditLimits).toContain(3);
  // 解放されていなければ CREDIT_EXHAUSTED になる正規送信が通る。
  socket.send(echoMessage(sessionId, "main", 0, "r-ok"));
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-ok",
  );
  expect(echoed.message.type).toBe("echo_response");
  expect(server.getStats().echoCount).toBe(1);
  expect(collector.closeState()).toBeNull();
});

test("初期付与が件数容量を超える設定は拒否する", async () => {
  await expect(
    createBridgeServer({
      port: 0,
      allowedOrigins: [DEV_ORIGIN],
      limits: { initialCreditWindow: 5, maxReliableQueueMessages: 4 },
    }),
  ).rejects.toThrow(RangeError);
});

test("latest と制御フレームはクレジットを消費せず reliable の送信枠を減らさない", async () => {
  // 初期 2・上限 4。latest を3件と逆方向の制御フレームを送っても、
  // reliable の付与枠は減らず2件を通常どおり送れて切断も明示エラーも起きない。
  // latest や制御が消費側に数えられていたら合計が初期付与を超え CREDIT_EXHAUSTED になる。
  const server = await startServer({
    limits: { initialCreditWindow: 2, maxReliableQueueMessages: 4 },
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  socket.send(dataLatestMessage(sessionId, "pose", 0, { x: 0 }));
  socket.send(dataLatestMessage(sessionId, "pose", 1, { x: 1 }));
  socket.send(dataLatestMessage(sessionId, "pose", 2, { x: 2 }));
  // クライアント→サーバ向きではない制御フレーム（明示エラーになるが枠は消費しない）。
  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "credit",
      sessionId,
      limit: 99,
    }),
  );
  socket.send(echoMessage(sessionId, "main", 0, "r-nc-0"));
  socket.send(echoMessage(sessionId, "main", 1, "r-nc-1"));
  const directionError = await collector.waitFor(
    (message) => message.type === "error" && message.code === "UNEXPECTED_DIRECTION",
  );
  expect(directionError.message.type).toBe("error");
  for (const requestId of ["r-nc-0", "r-nc-1"]) {
    const echoed = await collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === requestId,
    );
    expect(echoed.message.type).toBe("echo_response");
  }
  // latest は3件とも受信箱に計数され、reliable は2件とも業務処理されている。
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  expect(server.getStats().latestStored).toBe(3);
  expect(server.getStats().echoCount).toBe(2);
  expect(collector.closeState()).toBeNull();
});

test("受信側は古い連番の latest を落として欠番に数える", async () => {
  // seq=5 の後に seq=3 を送ると後者は受信箱に入らず欠番として計数され、
  // 最新値は seq=5 のまま残る。
  const server = await startServer();
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  socket.send(dataLatestMessage(sessionId, "pose", 5, { x: 5 }));
  socket.send(dataLatestMessage(sessionId, "pose", 3, { x: 3 }));
  // latest に応答はないため、後続の reliable 往復で受信処理の完了を確定させる。
  socket.send(echoMessage(sessionId, "main", 0, "r-drop-flush"));
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-drop-flush",
  );
  expect(echoed.message.type).toBe("echo_response");
  expect(server.getLatest("pose")).toEqual({ x: 5 });
  expect(server.getStats().latestStored).toBe(1);
  expect(server.getStats().latestDropped).toBe(1);
});

test("送出完了通知の失敗は切断として扱い残キューを破棄する", async () => {
  // 応答の完了通知で失敗を返す差し替え送信路。先行応答の送出失敗で
  // 対象接続が 1011 で閉じ、後続に queued された応答が破棄されることを確かめる。
  const transport: BridgeTransport = {
    send: (socket, text, done) => {
      let isResponse = false;
      try {
        const parsed = parseBridgeMessage(text);
        isResponse = parsed.type === "echo_response" || parsed.type === "command_response";
      } catch {
        // 非準拠フレームは試験対象外のため即時完了扱いにする。
      }
      socket.send(text);
      if (isResponse) {
        done(new Error("send failure"));
        return;
      }
      done(null);
    },
  };
  const server = await startServer({ transport });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  const closed = collector.waitClose();
  socket.send(echoMessage(sessionId, "main", 0, "r-fail-0"));
  socket.send(echoMessage(sessionId, "main", 1, "r-fail-1"));
  const result = await closed;
  expect(result.code).toBe(1011);
  // 後続に queued された応答は破棄され届かない。
  const received = collector.allFrames().map((raw) => parseBridgeMessage(raw));
  expect(
    received.some(
      (message) => message.type === "echo_response" && message.requestId === "r-fail-1",
    ),
  ).toBe(false);
  await waitForCondition(() => server.getConnectionCount() === 0);
});

test("ストリーム数超過で拒否した要求の枠は失われず後続の reliable が通る", async () => {
  // 初期 1・上限 2・ストリーム数上限 1。超過した新ストリームの要求が拒否された後、
  // 解放された付与で既存ストリームの送信が通る。解放がなければ CREDIT_EXHAUSTED で閉じる。
  const server = await startServer({
    limits: { initialCreditWindow: 1, maxReliableQueueMessages: 2, maxStreamsPerConnection: 1 },
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  socket.send(echoMessage(sessionId, "s1", 0, "r-sl-ok1"));
  const first = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-sl-ok1",
  );
  expect(first.message.type).toBe("echo_response");
  // 先行応答の容量解放による追加付与を待ってから超過要求を送り、順序依存を避ける。
  await collector.waitForCreditAbove(1);
  socket.send(echoMessage(sessionId, "s2", 0, "r-sl-over"));
  const error = await collector.waitFor(
    (message) => message.type === "error" && message.code === "STREAM_LIMIT",
  );
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.requestId).toBe("r-sl-over");
  // 解放されていなければ CREDIT_EXHAUSTED になる既存ストリームの送信が通る。
  socket.send(echoMessage(sessionId, "s1", 1, "r-sl-ok2"));
  const second = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-sl-ok2",
  );
  expect(second.message.type).toBe("echo_response");
  // 超過分は業務処理されていない。
  expect(server.getStats().echoCount).toBe(2);
  expect(collector.closeState()).toBeNull();
});

test("クレジット会計は接続単位で全 reliable ストリームに共通する", async () => {
  // 初期 2・上限 4。応答の送信完了を保留できる差し替え送信路で補充経路を塞ぎ、
  // 2ストリームの合計が初期付与で止まることを確かめる。
  // ストリーム単位の会計なら各2件ずつ送れるため、3件目の拒否が共通会計の証明になる。
  const held = createHeldTransport();
  const server = await startServer({
    limits: { initialCreditWindow: 2, maxReliableQueueMessages: 4 },
    transport: held.transport,
  });
  server.openAcceptance();
  const { socket, collector } = await openHistoryCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitFor((message) => message.type === "pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  expect(server.approvePairing(pending.message.requestId, pending.message.code).status).toBe(
    "APPROVED",
  );
  const ok = await collector.waitFor((message) => message.type === "auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認可応答ではない。");
  const sessionId = ok.message.sessionId;
  const closed = collector.waitClose();
  socket.send(echoMessage(sessionId, "main", 0, "r-shared-0"));
  socket.send(echoMessage(sessionId, "other", 0, "r-shared-1"));
  socket.send(echoMessage(sessionId, "main", 1, "r-shared-2"));
  const error = await collector.waitFor(
    (message) => message.type === "error" && message.code === "CREDIT_EXHAUSTED",
  );
  if (error.message.type !== "error") throw new Error("明示エラーではない。");
  expect(error.message.requestId).toBe("r-shared-2");
  const result = await closed;
  expect(result.code).toBe(1011);
  // 超過分は業務処理されていない。
  expect(server.getStats().echoCount).toBe(2);
});
