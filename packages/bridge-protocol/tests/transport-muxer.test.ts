import { expect, test } from "vite-plus/test";
import { AbstractMessageStream } from "@libp2p/utils";
import type { Logger, StreamMessageEvent } from "@libp2p/interface";
import type { SendResult } from "@libp2p/utils";
import { Uint8ArrayList } from "uint8arraylist";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import {
  MAX_INBOUND_STREAMS,
  MAX_OUTBOUND_STREAMS,
  MUX_STREAM_WINDOW_BYTES,
  bridgeMuxer,
  type BridgeMuxer,
} from "../src/transport/muxer.ts";
import { FrameDecoder, encodeFrameJson } from "../src/transport/framing.ts";

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
 * 実輸送と同様に到着は非同期であり、順序は保たれる。同期配送では送受信の
 * 交互進行が起きず、読み側緩衝の上限で abort するため非同期にする。
 * 終了は送出済みの到着より後に相手へ伝える。
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

/** 対向 duplex と両端 muxer の束。 */
interface MuxPair {
  readonly clientMuxer: BridgeMuxer;
  readonly serverMuxer: BridgeMuxer;
  readonly clientPipe: MemoryPipe;
  readonly serverPipe: MemoryPipe;
}

function createMuxPair(): MuxPair {
  const clientPipe = new MemoryPipe("outbound");
  const serverPipe = new MemoryPipe("inbound");
  clientPipe.peer = serverPipe;
  serverPipe.peer = clientPipe;
  const clientMuxer = bridgeMuxer()().createStreamMuxer(clientPipe);
  const serverMuxer = bridgeMuxer()().createStreamMuxer(serverPipe);
  return { clientMuxer, serverMuxer, clientPipe, serverPipe };
}

async function disposeMuxPair(pair: MuxPair): Promise<void> {
  await pair.clientMuxer.close().catch(() => undefined);
  await pair.serverMuxer.close().catch(() => undefined);
}

/** muxer の `stream` イベントから相手開始 stream をまとめて取り出す。 */
function waitForInboundStreams(
  muxer: BridgeMuxer,
  count: number,
  timeoutMs = 5000,
): Promise<YamuxStream[]> {
  return new Promise((resolve, reject) => {
    const out: YamuxStream[] = [];
    const timer = setTimeout(() => {
      muxer.removeEventListener("stream", onStream);
      reject(new Error(`inbound stream の到着が期限切れになった（${out.length}/${count}件のみ）`));
    }, timeoutMs);
    const onStream = (event: Event): void => {
      out.push((event as CustomEvent<YamuxStream>).detail);
      if (out.length === count) {
        clearTimeout(timer);
        muxer.removeEventListener("stream", onStream);
        resolve(out);
      }
    };
    muxer.addEventListener("stream", onStream);
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
async function collectFrames(
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

/** 1往復の echo を行う。サーバ側は受けた値をそのまま返す。 */
async function echoOnce(
  clientStream: YamuxStream,
  serverStream: YamuxStream,
  value: unknown,
): Promise<unknown> {
  clientStream.send(encodeFrameJson(value));
  const received = await collectFrames(serverStream, 1);
  serverStream.send(encodeFrameJson(received[0]));
  const echoed = await collectFrames(clientStream, 1);
  return echoed[0];
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

/** 受信 window の現在値を読む。 */
function readRecvWindow(stream: YamuxStream): number {
  // ADR: `recvWindow` は型上 private だが実行時は公開 field であり、
  // 自動拡大の抑止が効くかの直接証拠に必要なため構造で読み取る。
  // 存在しなければ観測不能として失敗する（偽装しない）。
  const record = stream as unknown as { recvWindow?: unknown };
  if (typeof record.recvWindow !== "number") throw new Error("recvWindow を観測できない");
  return record.recvWindow;
}

test("固定設定が期待値である", () => {
  expect(MUX_STREAM_WINDOW_BYTES).toBe(256 * 1024);
  expect(MAX_INBOUND_STREAMS).toBe(32);
  expect(MAX_OUTBOUND_STREAMS).toBe(32);
});

test("複数の stream を同時に開き独立に往復できる", async () => {
  const pair = createMuxPair();
  try {
    const count = 4;
    const opened = await Promise.all(
      Array.from({ length: count }, () => pair.clientMuxer.createStream()),
    );
    // 1つの受け口でまとめて取る。受け口を複数並べると最初の1件が全員に届くため。
    const accepted = await waitForInboundStreams(pair.serverMuxer, count);
    const rounds = await Promise.all(
      opened.map((clientStream, index) =>
        echoOnce(clientStream, accepted[index]!, { stream: index }),
      ),
    );
    expect(rounds).toHaveLength(4);
    for (const [index, value] of rounds.entries()) {
      expect((value as { stream: number }).stream).toBe(index);
    }
    for (const stream of [...opened, ...accepted]) await stream.close().catch(() => undefined);
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("FIN で片方向が終わり逆方向は継続できる", async () => {
  const pair = createMuxPair();
  try {
    const events: string[] = [];
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = (await waitForInboundStreams(pair.serverMuxer, 1))[0]!;
    const record = (tag: string, type: string) => (): void => {
      events.push(`${tag}:${type}`);
    };
    serverStream.addEventListener("remoteCloseWrite", record("server", "remoteCloseWrite"));
    serverStream.addEventListener("end", record("server", "end"));
    clientStream.addEventListener("remoteCloseWrite", record("client", "remoteCloseWrite"));
    clientStream.addEventListener("end", record("client", "end"));
    clientStream.send(encodeFrameJson({ hello: "fin" }));
    await collectFrames(serverStream, 1);
    // クライアントの送信方向だけを閉じる。
    await clientStream.close();
    await waitFor(
      () => events.includes("server:remoteCloseWrite") && events.includes("server:end"),
      5000,
      "サーバ側の FIN 観測",
    );
    // 逆方向は継続できる。
    serverStream.send(encodeFrameJson({ reply: "reverse-ok" }));
    const reply = await collectFrames(clientStream, 1);
    expect(reply[0]).toEqual({ reply: "reverse-ok" });
    await serverStream.close();
    await waitFor(
      () => events.includes("client:remoteCloseWrite") && events.includes("client:end"),
      5000,
      "クライアント側の FIN 観測",
    );
    expect(pair.clientMuxer.status).toBe("open");
    expect(pair.serverMuxer.status).toBe("open");
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("RST で対象 stream だけが中断し他 stream は継続する", async () => {
  const pair = createMuxPair();
  try {
    const events: string[] = [];
    const streamA = await pair.clientMuxer.createStream();
    const streamB = await pair.clientMuxer.createStream();
    const [serverA, serverB] = await waitForInboundStreams(pair.serverMuxer, 2);
    serverA!.addEventListener("close", () => events.push("serverA:close"));
    serverB!.addEventListener("close", () => events.push("serverB:close"));
    streamA.send(encodeFrameJson({ a: 1 }));
    await collectFrames(serverA!, 1);
    // A だけを即時中断する。
    streamA.abort(new Error("rst-spike"));
    await waitFor(() => events.includes("serverA:close"), 5000, "サーバ側 A の中断観測");
    // B は影響を受けない。
    const echoed = await echoOnce(streamB, serverB!, { b: 2 });
    expect(echoed).toEqual({ b: 2 });
    expect(events.some((entry) => entry.startsWith("serverB:close"))).toBe(false);
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("GoAway で mux 全体の終了が観測できる", async () => {
  const pair = createMuxPair();
  try {
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = (await waitForInboundStreams(pair.serverMuxer, 1))[0]!;
    await echoOnce(clientStream, serverStream, { g: 0 });
    await pair.clientMuxer.close();
    await waitFor(() => pair.serverMuxer.status === "closed", 5000, "サーバ muxer の終了");
    expect(pair.clientMuxer.status).toBe("closed");
    expect(pair.serverMuxer.status).toBe("closed");
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("32 本まで開け33 本目を拒否する", async () => {
  const pair = createMuxPair();
  try {
    // ADR: 受信口の追加前に開いた stream は earlyStreams に溜まり、
    // 既定上限（10 件）で muxer が abort するため、受信口を先に付ける。
    const accepted = waitForInboundStreams(pair.serverMuxer, 32);
    const streams: YamuxStream[] = [];
    for (let index = 0; index < 32; index += 1) {
      streams.push(await pair.clientMuxer.createStream());
    }
    expect(streams).toHaveLength(32);
    await accepted;
    // 33 本目は上限超過で拒否する。
    await expect(pair.clientMuxer.createStream()).rejects.toThrow();
    for (const stream of streams) await stream.close().catch(() => undefined);
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("RTT 確知後も受信 window が 256KiB を超えない", async () => {
  const pair = createMuxPair();
  try {
    // ping で RTT を確知させる。自動拡大は RTT 既知が条件のため。
    const clientRtt = await pair.clientMuxer.ping();
    const serverRtt = await pair.serverMuxer.ping();
    expect(Number.isFinite(clientRtt)).toBe(true);
    expect(Number.isFinite(serverRtt)).toBe(true);
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = (await waitForInboundStreams(pair.serverMuxer, 1))[0]!;
    const initialRecvWindow = readRecvWindow(serverStream);
    const chunk = new Uint8Array(32 * 1024);
    chunk.fill(0x62);
    const totalSends = 160; // 5MiB。初期 window（256KiB）を大幅に超える。
    let maxRecvWindow = initialRecvWindow;
    const reading = (async (): Promise<number> => {
      let received = 0;
      const expected = totalSends * chunk.byteLength;
      const started = Date.now();
      while (received < expected) {
        if (Date.now() - started > 20000) throw new Error("全量受信が期限切れになった");
        const part = await readChunk(serverStream, 20000);
        received += part.byteLength;
        maxRecvWindow = Math.max(maxRecvWindow, readRecvWindow(serverStream));
      }
      return received;
    })();
    for (let index = 0; index < totalSends; index += 1) clientStream.send(chunk);
    const receivedBytes = await reading;
    expect(receivedBytes).toBe(totalSends * chunk.byteLength);
    // 自動拡大の抑止：5MiB 送信後も受信 window は 256KiB を超えない。
    expect(maxRecvWindow).toBeLessThanOrEqual(256 * 1024);
    await clientStream.close().catch(() => undefined);
    await serverStream.close().catch(() => undefined);
  } finally {
    await disposeMuxPair(pair);
  }
}, 30_000);
