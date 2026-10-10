/**
 * Node の `ws` 用 RawSocket 実装（サーバ側・クライアント側共通）。
 *
 * @packageDocumentation
 */

import type { WebSocket } from "ws";
import type { RawSocket } from "./raw-socket.ts";

/** 受信データ（`ws` が渡す3形式）を Uint8Array へ正規化する。 */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (Array.isArray(data)) {
    const parts = data as Uint8Array[];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
  throw new Error(`想定外の受信形式: ${typeof data}`);
}

/**
 * Node の `ws` WebSocket を RawSocket 化する。
 *
 * @param ws - 送受信に使う WebSocket。プリリュード完了後の状態であること。
 * @returns バイナリ専用の輸送抽象。
 */
export function wrapNodeSocket(ws: WebSocket): RawSocket {
  let bytesHandler: ((bytes: Uint8Array) => void) | undefined;
  let closedHandler: ((cause?: Error) => void) | undefined;
  let closedNotified = false;
  const notifyClosed = (cause?: Error): void => {
    if (closedNotified) return;
    closedNotified = true;
    closedHandler?.(cause);
  };
  // binaryType をそろえ、受信を Uint8Array へ正規化する。
  ws.binaryType = "nodebuffer";
  ws.on("message", (data: unknown) => {
    if (typeof data === "string") return;
    bytesHandler?.(toBytes(data));
  });
  ws.on("close", () => {
    notifyClosed();
  });
  ws.on("error", (cause: Error) => {
    notifyClosed(cause);
  });
  return {
    kind: "node",
    sendBytes(bytes: Uint8Array): void {
      ws.send(bytes, { binary: true }, (cause?: Error) => {
        if (cause !== undefined && cause !== null) notifyClosed(cause);
      });
    },
    bufferedBytes(): number {
      return ws.bufferedAmount;
    },
    closeSocket(): void {
      ws.close();
    },
    onBytes(handler: (bytes: Uint8Array) => void): void {
      bytesHandler = handler;
    },
    onClosed(handler: (cause?: Error) => void): void {
      closedHandler = handler;
    },
  };
}
