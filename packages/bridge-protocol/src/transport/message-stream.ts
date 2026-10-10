/**
 * WS メッセージ列を yamux の MessageStream として見せる層。
 *
 * WS メッセージ境界と yamux フレーム境界は無関係であり、受信側は到着した
 * 断片を単なる連続バイト列として mux へ渡す。送信側は yamux の書き込みを
 * そのまま1メッセージで送り、順序は WebSocket が保証する。
 *
 * Node の `ws` とブラウザ WebSocket の差は `RawSocket` の実装側で吸収し、
 * この層はプラットフォーム非依存に保つ。具体の適合は C/D 単位が用意する。
 *
 * @packageDocumentation
 */

import { AbstractMessageStream } from "@libp2p/utils";
import type { AbortOptions, Logger, MessageStreamDirection } from "@libp2p/interface";
import type { SendResult } from "@libp2p/utils";
import { Uint8ArrayList } from "uint8arraylist";

/**
 * mux フェーズの輸送に必要な最小操作。
 *
 * yamux の mux フェーズではバイナリだけを扱う。認可プリリュードの
 * テキストはこの層の外で直接ソケットを触って行い、mux 開始後にこの抽象へ
 * 切り替える。実装者は受信バイナリを順序どおり `onBytes` へ渡し、閉じたら
 * `onClosed` を一度だけ通知すること。
 */
export interface RawSocket {
  /**
   * バイナリを1つの WebSocket メッセージとして送る。
   *
   * 順序は WebSocket が保証する。送信失敗は同期例外か `onClosed` で通知する。
   */
  sendBytes(bytes: Uint8Array): void;
  /** 未送出の概算バイト数（`bufferedAmount` 相当）。 */
  bufferedBytes(): number;
  /** 正常終了として閉じる。 */
  closeSocket(): void;
  /** 受信バイナリの配送登録。テキストは mux フェーズでは来ない前提。 */
  onBytes(handler: (bytes: Uint8Array) => void): void;
  /** 輸送が閉じたときの通知登録。 */
  onClosed(handler: (cause?: Error) => void): void;
}

/** 輸送が詰まったとみなす未送出バイト数の既定値。 */
export const DEFAULT_DRAIN_THRESHOLD_BYTES = 1024 * 1024;

/** 輸送の生成条件。 */
export interface WsMessageStreamOptions {
  readonly direction: MessageStreamDirection;
  readonly log: Logger;
  /** 輸送が詰まったとみなす未送出バイト数の目安。既定は 1MiB。 */
  readonly drainThresholdBytes?: number;
  readonly inactivityTimeout?: number;
  readonly maxReadBufferLength?: number;
}

/**
 * WebSocket 上で yamux のバイト列を運ぶ MessageStream。
 *
 * yamux の `YamuxMuxer` は `MessageStream` を要求するため、この層で要求を
 * 満たす。流れ制御（window）は yamux stream 側が担い、この層は輸送の詰まり
 * 具合だけを `canSendMore` で返す。
 */
export class WsMessageStream extends AbstractMessageStream {
  private readonly socket: RawSocket;
  private readonly drainThresholdBytes: number;
  private closeResolve: (() => void) | undefined;
  private socketClosed = false;
  /** 輸送詰まりの再確認タイマ。`ws` に drain 通知がないための代替。 */
  private drainPoller: ReturnType<typeof setInterval> | undefined;

  /**
   * @param socket - プリリュード完了後のバイナリ専用ソケット。
   * @param options - 方向などの生成条件。
   */
  constructor(socket: RawSocket, options: WsMessageStreamOptions) {
    super({
      log: options.log,
      direction: options.direction,
      inactivityTimeout: options.inactivityTimeout,
      maxReadBufferLength: options.maxReadBufferLength,
    });
    this.socket = socket;
    this.drainThresholdBytes = options.drainThresholdBytes ?? DEFAULT_DRAIN_THRESHOLD_BYTES;
    this.socket.onBytes((bytes) => {
      // WS メッセージ境界は捨て、連続バイト列として mux へ渡す。
      this.onData(new Uint8ArrayList(bytes));
    });
    this.socket.onClosed((cause) => {
      this.socketClosed = true;
      this.stopDrainPolling();
      this.onTransportClosed(cause);
      this.closeResolve?.();
      this.closeResolve = undefined;
    });
  }

  /** 基底の公開抽象の実装。直接呼ばず `send()` 経由で使うこと。 */
  sendData(data: Uint8ArrayList): SendResult {
    // ADR: プール由来の写像を輸送に渡さないため複写する。送信後の再利用・
    // 解放による化けを防ぐ。
    const bytes = new Uint8Array(data.subarray());
    this.socket.sendBytes(bytes);
    const canSendMore = this.socket.bufferedBytes() < this.drainThresholdBytes;
    // ADR: `ws`（Node・ブラウザとも）に書き込み再開の通知はないため、
    // 詰まりを報告した後は未送出量の polling で `drain` を出す。
    // 出さないと基底の `writableNeedsDrain` が残り `close()`・`onDrain()` が
    // 永遠に待つ。
    if (!canSendMore) this.startDrainPolling();
    return { sentBytes: bytes.byteLength, canSendMore };
  }

  /** 未送出量が引くまで見張り、引いたら `drain` を出す。 */
  private startDrainPolling(): void {
    if (this.drainPoller !== undefined || this.socketClosed) return;
    this.drainPoller = setInterval(() => {
      if (this.socketClosed || this.socket.bufferedBytes() < this.drainThresholdBytes) {
        this.stopDrainPolling();
        // 基底の継続処理（自層の再送出・muxer 経由の各 stream 再開・onDrain 解決）を起こす。
        this.safeDispatchEvent("drain");
      }
    }, 5);
    // ADR: 見張りが Node プロセスを残さないようにする（ブラウザには unref がない）。
    const poller = this.drainPoller as unknown as { unref?: () => void };
    if (typeof poller.unref === "function") poller.unref();
  }

  /** 見張りを止める。 */
  private stopDrainPolling(): void {
    if (this.drainPoller !== undefined) {
      clearInterval(this.drainPoller);
      this.drainPoller = undefined;
    }
  }

  /** 基底の公開抽象の実装。直接呼ばず abort 経由で使うこと。 */
  sendReset(_err: Error): void {
    this.socket.closeSocket();
  }

  /** 基底の公開抽象の実装。WS に一時停止信号はないため何もしない。 */
  sendPause(): void {
    // WS に相手の一時停止信号はないため何もしない。
    // 受信側の読み遅れは yamux stream の pause（window 更新停止）で表す。
  }

  /** 基底の公開抽象の実装。WS に再開信号はないため何もしない。 */
  sendResume(): void {
    // sendPause と対称の何もしない実装。
  }

  /** 基底の公開抽象の実装。輸送の終了を待ってから閉じる。 */
  async close(_options?: AbortOptions): Promise<void> {
    this.stopDrainPolling();
    if (this.status === "closed" || this.status === "aborted" || this.socketClosed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.closeResolve = undefined;
        resolve();
      }, 1000);
      this.closeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.closeSocket();
    });
  }
}
