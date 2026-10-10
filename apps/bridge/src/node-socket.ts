/**
 * Node `ws` の WebSocket を transport の `RawSocket` に適合させる層。
 *
 * `ws` の受信は `(data, isBinary)` で text/binary を判別する。
 * `typeof data` では判別しない（text も Buffer で届く）。
 * この適合自体は WS メッセージの受信登録を持たず、呼び出し側（サーバの
 * 切替管理）が `receiveBytes` へ binary を渡す。text/binary の振り分けと
 * 切替中の保持は呼び出し側の責務であり、ここでは行わない。
 *
 * 送信は yamux の断片をそのまま1メッセージで送る。`maxPayload` 未満への
 * 分割はしない。順序は WebSocket が保証する。
 *
 * @packageDocumentation
 */
import { WebSocket } from "ws";
import type { RawSocket } from "bridge-protocol/transport";

/**
 * Node `ws` 用の `RawSocket` 適合。
 *
 * 受信 binary の配送は `receiveBytes` 経由であり、`ws` の `message`
 * イベントをここで購読しない。終了の観測（`close`・`error`）だけを
 * ここで購読し、`onClosed` へ一度だけ通知する。
 */
export class NodeWsSocket implements RawSocket {
  private readonly socket: WebSocket;
  private readonly bytesHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly closedHandlers = new Set<(cause?: Error) => void>();
  private closedNotified = false;
  private closeCause: Error | undefined;

  /**
   * @param socket - 適合させるサーバ側（または試験クライアント側）のソケット。
   */
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("close", () => {
      this.notifyClosed(this.closeCause);
    });
    socket.on("error", (cause: Error) => {
      this.closeCause = cause;
    });
  }

  /**
   * バイナリを1つの WebSocket メッセージとして送る。
   *
   * @param bytes - 送るバイナリ（yamux の断片、そのまま送る）。
   * @throws `Error` — ソケットが開いていない場合。
   */
  sendBytes(bytes: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("開いていないソケットには送れない。");
    }
    // ADR: `ws.send` の非同期失敗は `onClosed` で通知する。`sendBytes` 自体は
    // 同期 void が契約のため、callback の失敗を例外に変えない。
    // 成功時は `null`・`undefined` で呼ばれ、失敗時は `Error` で呼ばれる。
    this.socket.send(bytes, { binary: true }, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        this.notifyClosed(error);
      }
    });
  }

  /**
   * 未送出の概算バイト数（`bufferedAmount` 相当）。
   *
   * @returns 未送出量。
   */
  bufferedBytes(): number {
    return this.socket.bufferedAmount;
  }

  /**
   * 正常終了として閉じる。
   */
  closeSocket(): void {
    try {
      this.socket.close();
    } catch {
      // 閉塞時の例外は無視する。
    }
  }

  /**
   * 受信バイナリの配送登録。
   *
   * @param handler - 受信 binary を受け取る処理。
   */
  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandlers.add(handler);
  }

  /**
   * 輸送が閉じたときの通知登録。既に閉じていれば即時通知する。
   *
   * @param handler - 終了時に呼ぶ処理。
   */
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

  /**
   * 呼び出し側が振り分けた受信 binary を流す。
   *
   * 切替中に保持した分は mux 開始後に順序どおりこの口へ戻すこと。
   *
   * @param bytes - 受信した binary。
   */
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

  /**
   * 呼び出し側が観測した終了を流す（`ws` の `close` と重複しても一度だけ）。
   *
   * @param cause - 終了原因。省略時は正常終了扱い。
   */
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
