import { expect, test } from "vite-plus/test";
import type { Logger, StreamMessageEvent } from "@libp2p/interface";
import {
  DEFAULT_DRAIN_THRESHOLD_BYTES,
  WsMessageStream,
  type RawSocket,
} from "../src/transport/message-stream.ts";

// ADR: libp2p の `Logger` は呼出可能と付帯操作の合成型であり、
// テスト用の無操作実装は構造で組み立てる。合成の正当な構築手段として使う。
function createTestLogger(): Logger {
  const callable = (..._args: unknown[]): void => {};
  const log = callable as unknown as Logger;
  log.error = (..._args: unknown[]): void => {};
  log.trace = (..._args: unknown[]): void => {};
  log.enabled = false;
  log.newScope = () => log;
  return log;
}

/** 送受信・未送出量・終了をテスト操作口で操る `RawSocket`。 */
class StubRawSocket implements RawSocket {
  readonly sent: Uint8Array[] = [];
  private bytesHandler: ((bytes: Uint8Array) => void) | undefined;
  private closedHandler: ((cause?: Error) => void) | undefined;
  private stagedBytes = 0;
  private readonly autoClose: boolean;

  constructor(autoClose = true) {
    this.autoClose = autoClose;
  }

  sendBytes(bytes: Uint8Array): void {
    this.sent.push(bytes);
    this.stagedBytes += bytes.byteLength;
  }

  bufferedBytes(): number {
    return this.stagedBytes;
  }

  closeSocket(): void {
    if (this.autoClose) this.closedHandler?.();
  }

  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandler = handler;
  }

  onClosed(handler: (cause?: Error) => void): void {
    this.closedHandler = handler;
  }

  /** 受信バイナリを届ける。 */
  deliver(bytes: Uint8Array): void {
    this.bytesHandler?.(bytes);
  }

  /** 未送出量を 0 にする（相手が読んだ扱い）。 */
  flushStaged(): void {
    this.stagedBytes = 0;
  }

  /** 輸送側から閉じる。 */
  remoteClose(cause?: Error): void {
    this.closedHandler?.(cause);
  }

  /** 送信済みを結合する。 */
  sentJoined(): Uint8Array {
    const total = this.sent.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.sent) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

function collectMessages(stream: WsMessageStream): Uint8Array[] {
  const out: Uint8Array[] = [];
  stream.addEventListener("message", (event) => {
    const data = (event as StreamMessageEvent).data;
    out.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.subarray()));
  });
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} が ${ms}ms 以内に終わらない`)), ms);
    }),
  ]);
}

test("送信したバイト列を順序どおり送る", async () => {
  const socket = new StubRawSocket();
  const stream = new WsMessageStream(socket, { direction: "outbound", log: createTestLogger() });
  expect(stream.send(new Uint8Array([1, 2, 3]))).toBe(true);
  expect(stream.send(new Uint8Array([4, 5]))).toBe(true);
  expect(socket.sent).toHaveLength(2);
  expect(socket.sentJoined()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  await withTimeout(stream.close(), 2000, "終了");
});

test("受信断片をメッセージ境界なく連続バイト列で渡す", async () => {
  const socket = new StubRawSocket();
  const stream = new WsMessageStream(socket, { direction: "inbound", log: createTestLogger() });
  const received = collectMessages(stream);
  // yamux フレーム相当の 20B を WS メッセージ境界と無関係な刻みで届ける。
  const original = new Uint8Array(20).map((_value, index) => index);
  socket.deliver(original.subarray(0, 7));
  socket.deliver(original.subarray(7, 8));
  socket.deliver(original.subarray(8));
  expect(join(received)).toEqual(original);
  await withTimeout(stream.close(), 2000, "終了");
});

test("未送出量がしきい値を超えたら詰まりを報告し引いたら drain を出す", async () => {
  expect(DEFAULT_DRAIN_THRESHOLD_BYTES).toBe(1024 * 1024);
  const socket = new StubRawSocket();
  const stream = new WsMessageStream(socket, {
    direction: "outbound",
    log: createTestLogger(),
    drainThresholdBytes: 10,
  });
  // 未送出 10B で詰まりを報告する。
  expect(stream.send(new Uint8Array(10).fill(0x61))).toBe(false);
  let drained = false;
  const waiting = stream.onDrain().then(() => {
    drained = true;
  });
  // 未送出のままでは解けない。
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(drained).toBe(false);
  // 未送出が引けば polling で drain が出て解ける。
  socket.flushStaged();
  await withTimeout(waiting, 2000, "drain 待ち");
  expect(drained).toBe(true);
  await withTimeout(stream.close(), 2000, "終了");
});

test("close は輸送終了で解ける", async () => {
  const socket = new StubRawSocket();
  const stream = new WsMessageStream(socket, { direction: "outbound", log: createTestLogger() });
  stream.send(new Uint8Array([1]));
  // `closeSocket` が輸送終了を起こし、待ちが解ける。
  await withTimeout(stream.close(), 2000, "終了");
  expect(stream.status).toBe("closed");
});

test("close は輸送が終わらなくても待ちを残さない", async () => {
  // 輸送が終了通知を返さない場合の待機解消。1 秒の打切りで解決する。
  const socket = new StubRawSocket(false);
  const stream = new WsMessageStream(socket, { direction: "outbound", log: createTestLogger() });
  const started = Date.now();
  await withTimeout(stream.close(), 3000, "打切り終了");
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});
