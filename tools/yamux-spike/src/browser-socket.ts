/**
 * ブラウザ WebSocket 用 RawSocket 実装。
 *
 * ブラウザ側は `ws` パッケージを使えないため、グローバル WebSocket で
 * 同じ輸送抽象を満たす。Node 側の実装とはこのファイルで分岐する。
 *
 * @packageDocumentation
 */

import type { RawSocket } from "./raw-socket.ts";

/**
 * ブラウザの WebSocket を RawSocket 化する。
 *
 * @param ws - 送受信に使う WebSocket。プリリュード完了後の状態であること。
 * @returns バイナリ専用の輸送抽象。
 */
export function wrapBrowserSocket(ws: WebSocket): RawSocket {
  let bytesHandler: ((bytes: Uint8Array) => void) | undefined;
  let closedHandler: ((cause?: Error) => void) | undefined;
  let closedNotified = false;
  const notifyClosed = (cause?: Error): void => {
    if (closedNotified) return;
    closedNotified = true;
    closedHandler?.(cause);
  };
  ws.binaryType = "arraybuffer";
  ws.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data instanceof ArrayBuffer) {
      bytesHandler?.(new Uint8Array(data.slice(0)));
      return;
    }
    if (data instanceof Blob) {
      // Blob は非同期でしか読めないため、到着順を保ったまま配送する。
      void data.arrayBuffer().then((buffer) => {
        bytesHandler?.(new Uint8Array(buffer));
      });
      return;
    }
    // テキストは mux フェーズでは来ない前提のため無視する。
  };
  ws.onclose = () => {
    notifyClosed();
  };
  ws.onerror = () => {
    notifyClosed(new Error("ブラウザ WebSocket でエラーが起きた"));
  };
  return {
    kind: "browser",
    sendBytes(bytes: Uint8Array): void {
      // ブラウザの send は BufferSource を要求するため、正確な大きさで複写する。
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      ws.send(copy.buffer);
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
