/**
 * Node の `ws` とブラウザ WebSocket の差を吸収する最小抽象。
 *
 * yamux の mux フェーズではバイナリだけを扱う。認可プリリュードの
 * テキストはこの層の外（`./prelude.ts`）で直接ソケットを触って行い、
 * mux 開始後にこの抽象へ切り替える。
 *
 * @packageDocumentation
 */

/** mux フェーズの輸送に必要な最小操作。 */
export interface RawSocket {
  /** Node の `ws` かブラウザかを区別する表示名。観測用。 */
  readonly kind: "node" | "browser";
  /**
   * バイナリを1つの WebSocket メッセージとして送る。
   *
   * 順序は WebSocket が保証する。送信失敗は同期例外か `onClosed` で通知する。
   */
  sendBytes(bytes: Uint8Array): void;
  /** 未送出の概算バイト数（`ws.bufferedAmount` 相当）。 */
  bufferedBytes(): number;
  /** 正常終了として閉じる。 */
  closeSocket(): void;
  /** 受信バイナリの配送登録。テキストは mux フェーズでは来ない前提。 */
  onBytes(handler: (bytes: Uint8Array) => void): void;
  /** 輸送が閉じたときの通知登録。 */
  onClosed(handler: (cause?: Error) => void): void;
}
