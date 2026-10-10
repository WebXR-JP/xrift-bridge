/**
 * ブラウザ WebSocket を transport の `RawSocket` に適合させる層。
 *
 * 認可前テキストの送受信は呼び出し側（接続要求の調停）が直接ソケットを
 * 触って行い、この適合は認可後 mux フェーズのバイナリ配送だけを担う。
 * 受信の振り分け（認可前 text／認可後 binary の切替）は呼び出し側の責務で
 * あり、ここでは行わない。呼び出し側は切替後に届く binary を受信順に
 * `pushBinary` へ渡すこと。
 *
 * 送信は yamux の断片をそのまま1メッセージで送る。順序は WebSocket が
 * 保証する。
 *
 * @packageDocumentation
 */
import type { RawSocket } from "bridge-protocol/transport";

/**
 * ソケット受信値を正規化した結果。
 *
 * mux フェーズでは text が来ない前提であり、text は呼び出し側で境界違反
 * として扱う。ここでは判別だけを行い、binary の複写まで済ませる。
 */
export type NormalizedSocketData =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
    };

/**
 * ソケットの受信値を text／バイナリに正規化する。
 *
 * 生成直後に `binaryType = "arraybuffer"` を指定するため、通常は文字列か
 * `ArrayBuffer` で届く。`Blob` で届く環境では `arrayBuffer()` への変換を
 * 呼び出し側の受信鎖で直列化し（順序保持）、ここでは1件分の変換だけを
 * 行う。Node の `Buffer` 等のビューで届いた場合も複写して掴みを離す。
 *
 * @param data - `message` イベントの受信値。
 * @returns 正規化した text または複写したバイナリ。
 */
export async function normalizeSocketData(data: unknown): Promise<NormalizedSocketData> {
  if (typeof data === "string") {
    return { kind: "text", text: data };
  }
  if (data instanceof ArrayBuffer) {
    return { kind: "bytes", bytes: new Uint8Array(data.slice(0)) };
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const buffer = await data.arrayBuffer();
    return { kind: "bytes", bytes: new Uint8Array(buffer) };
  }
  if (ArrayBuffer.isView(data)) {
    // ADR: `Buffer`・`Uint8Array` 等のビューは裏の緩衝を掴み続けないよう
    // 複写する。`subarray` のまま mux へ渡さない。
    const view = data as unknown as { byteLength: number };
    if (view.byteLength === 0) return { kind: "bytes", bytes: new Uint8Array(0) };
    const source = data as unknown as Uint8Array;
    const out = new Uint8Array(source.byteLength);
    out.set(source);
    return { kind: "bytes", bytes: out };
  }
  throw new Error("ソケットの受信値の形式が想定外である。");
}

/**
 * ブラウザ WebSocket 用の `RawSocket` 適合。
 *
 * 受信 binary の配送は呼び出し側の振り分け経由（`pushBinary`）であり、
 * ソケットの `message` をここで購読しない。終了の観測（`close`・`error`）
 * だけをここで購読し、`onClosed` へ一度だけ通知する。
 */
export class BrowserSocket implements RawSocket {
  private readonly socket: WebSocket;
  private readonly bytesHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly closedHandlers = new Set<(cause?: Error) => void>();
  private closedNotified = false;
  private closeCause: Error | undefined;

  /**
   * @param socket - 適合させるソケット。生成直後に呼び出し側で
   * `binaryType = "arraybuffer"` を指定済みであること。
   */
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("error", () => {
      // ADR: `error` のみでは終わらず `close` が続くため、ここでは原因の
      // 記録に留め、通知は `close` 側で行う。
      if (this.closeCause === undefined) {
        this.closeCause = new Error("ソケット異常を検出した。");
      }
    });
    socket.addEventListener("close", () => {
      this.notifyClosed(this.closeCause);
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
    // ADR: DOM 型の `send` は共有緩衝裏のビューを受け付けないため、
    // 長さ一致の複写に載せ替える。yamux の断片は小さいため複写で足りる。
    this.socket.send(bytes.slice());
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
   * 認可プリリュード中に届く binary は呼び出し側で境界違反として終了
   * するため、ここへ渡さないこと。mux 開始後に届いた分は受信順に渡し、
   * 連続到着する最初の binary を落とさない。
   *
   * @param bytes - 受信した binary。
   */
  pushBinary(bytes: Uint8Array): void {
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
   * 呼び出し側が観測した終了を流す（ソケットの `close` と重複しても一度だけ）。
   *
   * @param cause - 終了原因。省略時はソケット観測の原因を使う。
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
