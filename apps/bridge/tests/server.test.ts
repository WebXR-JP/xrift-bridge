import { afterEach, expect, test } from "vite-plus/test";
import { connect } from "node:net";
import { WebSocket, type RawData } from "ws";
import { PROTOCOL_VERSION, parseBridgeMessage, type BridgeMessage } from "bridge-protocol";
import { createWorldClient, type WorldClient } from "world-client";
import { createBridgeServer, type BridgeOptions, type BridgeServer } from "../src/server.ts";
import { PAIRING_TTL_MS } from "../src/config.ts";
import type { BridgeLogEvent } from "../src/log.ts";

const PROD_ORIGIN = "https://app.xrift.net";
const DEV_ORIGIN = "http://localhost:5173";

const servers: BridgeServer[] = [];
const clients: WorldClient[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
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
 * 作成時点から購読し続けるため `auth_ok` 直後の `credit` を取りこぼさない。
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

function authMessage(secret: string): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "auth", secret });
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

test("world-client が接続・認証・reliable echo を往復できる", async () => {
  const captured = capture();
  const server = await startServer({}, captured);
  const issued = server.issuePairing(DEV_ORIGIN);

  const client = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(client);
  const connected = await client.connect(issued.secret);
  expect(typeof connected.sessionId).toBe("string");

  const echoed = await client.sendEcho("main", { text: "到達性" });
  expect(echoed.seq).toBe(0);
  expect(echoed.payload).toEqual({ text: "到達性" });

  const pong = await client.sendCommand("main", "ping");
  expect(pong.ok).toBe(true);

  const stats = server.getStats();
  expect(stats.authSuccess).toBe(1);
  expect(stats.echoCount).toBe(1);
  expect(stats.commandCount).toBe(1);

  // 秘密値がログに出ていない。
  const logged = JSON.stringify(captured.events);
  expect(logged).not.toContain(issued.secret);
});

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

test("実際の昇格経路で Host・port・path・Origin の拒否を確認する", async () => {
  const server = await startServer();
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const readStatus = (payload: string): Promise<string> =>
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
  const badHostname = await readStatus(
    `GET /v1 HTTP/1.1\r\nHost: evil.example:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${DEV_ORIGIN}\r\n\r\n`,
  );
  expect(badHostname).toContain("403");
  const badPort = await readStatus(
    `GET /v1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${DEV_ORIGIN}\r\n\r\n`,
  );
  expect(badPort).toContain("403");
  const badPath = await readStatus(
    `GET /v2 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${DEV_ORIGIN}\r\n\r\n`,
  );
  expect(badPath).toContain("403");
  await expect(openRaw(server.endpoint, "https://evil.example")).rejects.toThrow();
  expect(server.getStats().upgradeRejected).toBe(4);
});

test("未認証では業務メッセージを送受信できない", async () => {
  const server = await startServer();
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  const closed = collector.waitClose();
  const business = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: "none",
    streamId: "main",
    kind: "reliable",
    seq: 0,
    requestId: "r1",
    payload: "x",
  });
  socket.send(business);
  const error = await collector.waitForErrorCode("NOT_AUTHENTICATED");
  expect(error.message.type).toBe("error");
  // 試行上限に達すると閉じる。
  socket.send(business);
  socket.send(business);
  const result = await closed;
  expect(result.code).toBe(1008);
});

test("再利用・期限切れ相当・未知の秘密値を拒否する", async () => {
  const server = await startServer();
  const issued = server.issuePairing(DEV_ORIGIN);

  const first = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(first);
  await first.connect(issued.secret);
  first.close();

  const second = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(second);
  await expect(second.connect(issued.secret)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  const third = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(third);
  await expect(third.connect("deadbeef".repeat(8))).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
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
  const issued = server.issuePairing(DEV_ORIGIN);
  const client = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(client);
  await client.connect(issued.secret);
  client.sendLatest("pose", { x: 1 });
  client.sendLatest("pose", { x: 2 });
  // latest に応答はないため、後続の reliable 往復で受信処理の完了を確定させる。
  const echoed = await client.sendEcho("main", { marker: "flush" });
  expect(echoed.payload).toEqual({ marker: "flush" });
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  expect(server.getStats().latestStored).toBe(2);
});

test("小さな初期クレジットでも補充で送り続けられる", async () => {
  const server = await startServer({ limits: { initialCreditWindow: 2 } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const client = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(client);
  await client.connect(issued.secret);
  for (let index = 0; index < 8; index += 1) {
    const echoed = await client.sendEcho("main", { n: index });
    expect(echoed.seq).toBe(index);
  }
});

test("ストリーム内連番の飛びを拒否する", async () => {
  const server = await startServer();
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "echo",
      sessionId: ok.message.sessionId,
      streamId: "main",
      kind: "reliable",
      seq: 5,
      requestId: "r-skip",
      payload: "x",
    }),
  );
  // auth_ok 直後の credit を消費しつつ目的の明示エラーを待つ。
  const error = await collector.waitForErrorCode("UNEXPECTED_SEQ");
  expect(error.message.type).toBe("error");
});

test("受信上限の超過は close 1009 で通知する", async () => {
  const server = await startServer({ limits: { maxMessageBytes: 256 } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  // JSON エラーや非空 reason は保証しないため、認証応答だけ待って切断を待つ。
  await collector.waitForType("auth_ok");
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

test("多バイトでも受信上限は UTF-8 バイトで判定する", async () => {
  // 文字数では 100 文字程度でも UTF-8 では上限を超える。
  const server = await startServer({ limits: { maxMessageBytes: 256 } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  await collector.waitForType("auth_ok");
  const closed = collector.waitClose();
  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "echo",
      sessionId: "s",
      streamId: "main",
      kind: "reliable",
      seq: 0,
      requestId: "r-multibyte",
      payload: "あ".repeat(100),
    }),
  );
  const result = await closed;
  expect(result.code).toBe(1009);
});

test("分割フレームの合算が上限を超えると close 1009 になる", async () => {
  const limit = 256;
  const server = await startServer({ limits: { maxMessageBytes: limit } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  const base = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: ok.message.sessionId,
    streamId: "main",
    kind: "reliable",
    seq: 0,
    requestId: "r-frag-over",
    payload: "",
  });
  const baseBytes = Buffer.byteLength(base, "utf8");
  const payloadLength = limit - baseBytes + 1;
  expect(payloadLength).toBeGreaterThan(0);
  const text = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: ok.message.sessionId,
    streamId: "main",
    kind: "reliable",
    seq: 0,
    requestId: "r-frag-over",
    payload: "x".repeat(payloadLength),
  });
  const bytes = Buffer.from(text, "utf-8");
  expect(bytes.length).toBe(limit + 1);
  const firstLength = Math.floor(bytes.length / 3);
  const secondLength = Math.floor((bytes.length - firstLength) / 2);
  const first = bytes.subarray(0, firstLength);
  const second = bytes.subarray(firstLength, firstLength + secondLength);
  const third = bytes.subarray(firstLength + secondLength);
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  expect(third.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(limit);
  expect(second.length).toBeLessThan(limit);
  expect(third.length).toBeLessThan(limit);
  expect(first.length + second.length + third.length).toBe(limit + 1);
  const before = server.getStats().echoCount;
  const closed = collector.waitClose();
  socket.send(first, { binary: false, compress: false, fin: false });
  socket.send(second, { binary: false, compress: false, fin: false });
  socket.send(third, { binary: false, compress: false, fin: true });
  const result = await closed;
  expect(result.code).toBe(1009);
  expect(server.getStats().echoCount).toBe(before);
});

test("分割フレームの合算が上限ちょうどなら echo 成功する", async () => {
  const limit = 256;
  const server = await startServer({ limits: { maxMessageBytes: limit } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  const base = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: ok.message.sessionId,
    streamId: "main",
    kind: "reliable",
    seq: 0,
    requestId: "r-frag-exact",
    payload: "",
  });
  const baseBytes = Buffer.byteLength(base, "utf8");
  const payloadLength = limit - baseBytes;
  expect(payloadLength).toBeGreaterThan(0);
  const text = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: ok.message.sessionId,
    streamId: "main",
    kind: "reliable",
    seq: 0,
    requestId: "r-frag-exact",
    payload: "x".repeat(payloadLength),
  });
  const bytes = Buffer.from(text, "utf-8");
  expect(bytes.length).toBe(limit);
  const firstLength = Math.floor(bytes.length / 3);
  const secondLength = Math.floor((bytes.length - firstLength) / 2);
  const first = bytes.subarray(0, firstLength);
  const second = bytes.subarray(firstLength, firstLength + secondLength);
  const third = bytes.subarray(firstLength + secondLength);
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  expect(third.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(limit);
  expect(second.length).toBeLessThan(limit);
  expect(third.length).toBeLessThan(limit);
  expect(first.length + second.length + third.length).toBe(limit);
  socket.send(first, { binary: false, compress: false, fin: false });
  socket.send(second, { binary: false, compress: false, fin: false });
  socket.send(third, { binary: false, compress: false, fin: true });
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-frag-exact",
  );
  expect(echoed.message.type).toBe("echo_response");
  expect(server.getStats().echoCount).toBe(1);
});

test("認証待ち超過と試行上限で閉じる", async () => {
  const idling = await startServer({ limits: { authTimeoutMs: 100 } });
  const idle = await openRaw(idling.endpoint, DEV_ORIGIN);
  const idleCollector = new FrameCollector(idle);
  const idleClosed = await idleCollector.waitClose();
  expect(idleClosed.code).toBe(1008);

  const strict = await startServer({ limits: { maxAuthAttempts: 1 } });
  const openedStrict = await openCollected(strict.endpoint, DEV_ORIGIN);
  const closed = openedStrict.collector.waitClose();
  openedStrict.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth", secret: "wrong" }));
  const result = await closed;
  expect(result.code).toBe(1008);
});

test("QUEUE_FULL は小さい上限設定で決定的に発生し明示エラーと切断になる", async () => {
  // 単一応答でバイト上限を超える設定にし、flush の競合なく決定的に発生させる。
  const server = await startServer({ limits: { maxReliableQueueBytes: 16 } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  const closed = collector.waitClose();
  socket.send(echoMessage(ok.message.sessionId, "main", 0, "r-queue-full"));
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
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  const before = server.getStats().echoCount;
  socket.send(echoMessage("wrong-session", "main", 0, "r-mismatch"));
  const error = await collector.waitForErrorCode("SESSION_MISMATCH");
  expect(error.message.type).toBe("error");
  expect(server.getStats().echoCount).toBe(before);
  // 正規セッションの連番は進んでいない。
  socket.send(echoMessage(ok.message.sessionId, "main", 0, "r-mismatch-ok"));
  const echoed = await collector.waitFor(
    (message) => message.type === "echo_response" && message.requestId === "r-mismatch-ok",
  );
  expect(echoed.message.type).toBe("echo_response");
});

test("STREAM_LIMIT は拒否し対象業務を処理しない", async () => {
  const server = await startServer({ limits: { maxStreamsPerConnection: 2 } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  const sessionId = ok.message.sessionId;
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
  const issued = server.issuePairing(DEV_ORIGIN);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const ok = await collector.waitForType("auth_ok");
  if (ok.message.type !== "auth_ok") throw new Error("認証応答ではない。");
  const beforeEcho = server.getStats().echoCount;
  const beforeCommand = server.getStats().commandCount;
  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "credit",
      sessionId: ok.message.sessionId,
      window: 8,
    }),
  );
  const error = await collector.waitForErrorCode("UNEXPECTED_DIRECTION");
  expect(error.message.type).toBe("error");
  expect(server.getStats().echoCount).toBe(beforeEcho);
  expect(server.getStats().commandCount).toBe(beforeCommand);
});

test("maxConnections は未認証接続も含めて上限拒否し切断後に枠が回復する", async () => {
  const server = await startServer({ limits: { maxConnections: 2 } });
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

test("期限切れは注入時計の境界で判定しサーバ認証経路でも拒否する", async () => {
  // 注入時計の境界値は pairing の消費結果で確認する。
  let now = 1_000_000;
  const { PairingStore } = await import("../src/pairing.ts");
  const store = new PairingStore(() => now);
  const first = store.issue("https://app.xrift.net");
  const expiresAt = first.expiresAt;
  expect(expiresAt).toBe(1_000_000 + PAIRING_TTL_MS);
  now = expiresAt;
  expect(store.consume(first.secret, "https://app.xrift.net")).toEqual({ status: "ok" });
  const second = store.issue("https://app.xrift.net");
  now = second.expiresAt + 1;
  expect(store.consume(second.secret, "https://app.xrift.net")).toEqual({ status: "expired" });

  let serverNow = 2_000_000;
  const expiring = await startServer({ now: () => serverNow });
  const issued = expiring.issuePairing(DEV_ORIGIN);
  serverNow += PAIRING_TTL_MS + 1;
  const { socket, collector } = await openCollected(expiring.endpoint, DEV_ORIGIN);
  socket.send(authMessage(issued.secret));
  const error = await collector.waitForErrorCode("UNAUTHORIZED");
  expect(error.message.type).toBe("error");
});

test("応答キューの容量は UTF-8 バイトで計上する（上限ちょうど・上限超過）", async () => {
  const payloads = [
    { name: "ascii", value: "hello-ascii" },
    { name: "日本語", value: "こんにちは世界" },
    { name: "絵文字", value: "😀🎉🌊" },
  ] as const;
  for (const payload of payloads) {
    // 実応答のバイト数を大きな上限で実測する。要求IDは固定長にし、
    // 応答サイズが測定時と検証時で変わらないようにする。
    const probe = await startServer();
    const issuedProbe = probe.issuePairing(DEV_ORIGIN);
    const opened = await openCollected(probe.endpoint, DEV_ORIGIN);
    opened.socket.send(authMessage(issuedProbe.secret));
    const okProbe = await opened.collector.waitForType("auth_ok");
    if (okProbe.message.type !== "auth_ok") throw new Error("認証応答ではない。");
    opened.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: okProbe.message.sessionId,
        streamId: "main",
        kind: "reliable",
        seq: 0,
        requestId: "r-queue-0001",
        payload: payload.value,
      }),
    );
    const response = await opened.collector.waitFor(
      (message) => message.type === "echo_response" && message.requestId === "r-queue-0001",
    );
    const responseBytes = Buffer.byteLength(response.raw, "utf8");
    // 上限ちょうどは受理される。
    const exact = await startServer({ limits: { maxReliableQueueBytes: responseBytes } });
    const issuedExact = exact.issuePairing(DEV_ORIGIN);
    const openedExact = await openCollected(exact.endpoint, DEV_ORIGIN);
    openedExact.socket.send(authMessage(issuedExact.secret));
    const okExact = await openedExact.collector.waitForType("auth_ok");
    if (okExact.message.type !== "auth_ok") throw new Error("認証応答ではない。");
    openedExact.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: okExact.message.sessionId,
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
    const tight = await startServer({ limits: { maxReliableQueueBytes: responseBytes - 1 } });
    const issuedTight = tight.issuePairing(DEV_ORIGIN);
    const openedTight = await openCollected(tight.endpoint, DEV_ORIGIN);
    openedTight.socket.send(authMessage(issuedTight.secret));
    const okTight = await openedTight.collector.waitForType("auth_ok");
    if (okTight.message.type !== "auth_ok") throw new Error("認証応答ではない。");
    const closed = openedTight.collector.waitClose();
    openedTight.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: okTight.message.sessionId,
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
  const firstSecret = server.issuePairing(DEV_ORIGIN).secret;
  const secondSecret = server.issuePairing(DEV_ORIGIN).secret;
  const first = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  const second = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(first, second);
  await first.connect(firstSecret);
  await second.connect(secondSecret);
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
  const firstClosed: Array<{ code: number; reason: string }> = [];
  const secondClosed: Array<{ code: number; reason: string }> = [];
  first.onEvent((event) => {
    if (event.kind === "closed") firstClosed.push({ code: event.code, reason: event.reason });
  });
  second.onEvent((event) => {
    if (event.kind === "closed") secondClosed.push({ code: event.code, reason: event.reason });
  });
  server.disconnectConnection(target.connectionId);
  // 即時失効は物理切断完了と別に検証する。戻り直後は一覧に残り authorized が false になる。
  const revoked = server
    .listConnections()
    .find((item) => item.connectionId === target.connectionId);
  expect(revoked?.authorized).toBe(false);
  // 切断対象のどちらか一方が閉じ、他方と未認証 raw が残る。
  await waitForCondition(
    () => server.listConnections().length === 2 && firstClosed.length + secondClosed.length >= 1,
  );
  // 切断指示後は当該接続の業務を受理しない。残存側だけが業務を通せる。
  const closedSide = firstClosed.length >= 1 ? first : second;
  const aliveSide = closedSide === first ? second : first;
  void closedSide;
  expect(firstClosed[0]?.code ?? secondClosed[0]?.code).toBe(1008);
  const echoed = await aliveSide.sendEcho("main", { alive: true });
  expect(echoed.payload).toEqual({ alive: true });
  // 不明IDは明示エラーとし、全切断へ fallback しない。
  expect(() => server.disconnectConnection("conn-unknown")).toThrow(RangeError);
  expect(server.listConnections()).toHaveLength(2);
  // 再利用秘密値は拒否される。
  const retry = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(retry);
  await expect(retry.connect(firstSecret)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("運用切断は 1008・固定 reason で未認証接続も切れる", async () => {
  const server = await startServer();
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

test("world-client は切断コードを通知し未完了要求を結果不明で破棄する", async () => {
  const server = await startServer({ limits: { maxMessageBytes: 512 } });
  const issued = server.issuePairing(DEV_ORIGIN);
  const client = createWorldClient({ endpoint: server.endpoint, origin: DEV_ORIGIN });
  clients.push(client);
  await client.connect(issued.secret);
  const closedEvents: Array<{ code: number; reason: string }> = [];
  client.onEvent((event) => {
    if (event.kind === "closed") closedEvents.push({ code: event.code, reason: event.reason });
  });
  // 受信上限を超える巨大要求を送り、サーバの close 1009 を誘発する。
  const pending = client.sendEcho("main", { big: "x".repeat(2048) });
  await expect(pending).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  await waitForCondition(() => closedEvents.length >= 1);
  expect(closedEvents[0]?.code).toBe(1009);
});
