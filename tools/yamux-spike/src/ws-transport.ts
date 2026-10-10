/**
 * WebSocket 上のバイト列を yamux の MessageStream として見せる層。
 *
 * WS メッセージ境界と yamux フレーム境界は無関係であり、受信側は
 * 到着した断片を単なる連続バイト列として `onData` へ渡す（yamux 内の
 * Decoder がフレーム境界を復元する）。送信側の分割・集約は観測用の
 * 方針（`OutgoingPolicy`）で切り替え、復元できることを試作で確かめる。
 *
 * @packageDocumentation
 */

import { AbstractMessageStream } from "@libp2p/utils";
import type { AbortOptions, Logger, MessageStreamDirection } from "@libp2p/interface";
import type { SendResult } from "@libp2p/utils";
import { Uint8ArrayList } from "uint8arraylist";
import type { RawSocket } from "./raw-socket.ts";

/** 送信バイト列の WS メッセージへの載せ方（試作の観測用）。 */
export type OutgoingPolicy =
  | { readonly kind: "passthrough" }
  | { readonly kind: "split"; readonly maxChunkBytes: number }
  | { readonly kind: "coalesce"; readonly delayMs: number };

/** 輸送の生成条件。 */
export interface WsTransportOptions {
  readonly direction: MessageStreamDirection;
  readonly log: Logger;
  /** 送信方針。既定はそのまま1メッセージで送る。 */
  readonly outgoing?: OutgoingPolicy;
  /** 輸送が詰まったとみなす未送出バイト数の目安。既定は 1MiB。 */
  readonly drainThresholdBytes?: number;
  readonly inactivityTimeout?: number;
  readonly maxReadBufferLength?: number;
}

/**
 * WebSocket 上で yamux のバイト列を運ぶ MessageStream。
 *
 * yamux の `YamuxMuxer` は `MessageStream` を要求するため、この層で
 * 要求を満たす。流れ制御（window）は yamux stream 側が担い、この層は
 * 輸送の詰まり具合だけを `canSendMore` で返す。
 */
export class WsMessageStream extends AbstractMessageStream {
  private readonly socket: RawSocket;
  private readonly outgoing: OutgoingPolicy;
  private readonly drainThresholdBytes: number;
  private coalescePending: Uint8Array[] = [];
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private closeResolve: (() => void) | undefined;
  private socketClosed = false;
  /** 輸送詰まりの再確認タイマ。`ws` に drain 通知がないための代替。 */
  private drainPoller: ReturnType<typeof setInterval> | undefined;
  /** 呼び出された `sendData` の回数（yamux 書き込みの件数）。観測用。 */
  public sendDataCalls = 0;
  /** 実際に送出した WS メッセージの数。観測用。 */
  public wsMessageCount = 0;

  /**
   * @param socket - プリリュード完了後のバイナリ専用ソケット。
   * @param options - 方向・方針などの生成条件。
   */
  constructor(socket: RawSocket, options: WsTransportOptions) {
    super({
      log: options.log,
      direction: options.direction,
      inactivityTimeout: options.inactivityTimeout,
      maxReadBufferLength: options.maxReadBufferLength,
    });
    this.socket = socket;
    this.outgoing = options.outgoing ?? { kind: "passthrough" };
    this.drainThresholdBytes = options.drainThresholdBytes ?? 1024 * 1024;
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
    this.sendDataCalls += 1;
    const bytes = data.subarray();
    if (this.outgoing.kind === "split") {
      // 1つの yamux 書き込みを複数の WS メッセージに分割する。
      const size = Math.max(1, this.outgoing.maxChunkBytes);
      for (let offset = 0; offset < bytes.byteLength; offset += size) {
        this.sendOne(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
      }
    } else if (this.outgoing.kind === "coalesce") {
      // 複数回の yamux 書き込みを1つの WS メッセージに集約する。
      this.coalescePending.push(new Uint8Array(bytes));
      if (this.coalesceTimer === undefined) {
        const delay = this.outgoing.delayMs;
        this.coalesceTimer = setTimeout(() => this.flushCoalesced(), delay);
      }
    } else {
      this.sendOne(new Uint8Array(bytes));
    }
    const canSendMore = this.socket.bufferedBytes() < this.drainThresholdBytes;
    // ADR: `ws`（Node・ブラウザとも）に書き込み再開の通知はないため、
    // 詰まりを報告した後は未送出量の polling で `drain` を出す。
    // 出さないと基底の `writableNeedsDrain` が残り `close()`・`onDrain()` が
    // 永遠に待つ（writeBuffer 空・window 更新到来なしの組み合わせで確定する）。
    // 本番実装では通知駆動の再検討が要るが、試作は polling で足りる。
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
    // 試作の見張りが node プロセスを残さないようにする（ブラウザには unref がない）。
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

  /** 集約待ちのバイト列を結合して1メッセージで送る。 */
  private flushCoalesced(): void {
    this.coalesceTimer = undefined;
    if (this.coalescePending.length === 0) return;
    const total = this.coalescePending.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of this.coalescePending) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    this.coalescePending = [];
    this.sendOne(joined);
  }

  /** WS メッセージを1件送り、送出数を数える。 */
  private sendOne(bytes: Uint8Array): void {
    this.wsMessageCount += 1;
    this.socket.sendBytes(bytes);
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

  /** 基底の公開抽象の実装。集約待ちを流してから閉じる。 */
  async close(_options?: AbortOptions): Promise<void> {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
      this.flushCoalesced();
    }
    this.stopDrainPolling();
    if (this.status === "closed" || this.status === "aborted" || this.socketClosed) return;
    await new Promise<void>((resolve) => {
      this.closeResolve = resolve;
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
