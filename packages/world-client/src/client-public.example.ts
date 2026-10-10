/**
 * ワールド内からブリッジへ接続するためのクライアント。
 *
 * Public APIの参考用。公開型のみ記載。0.3 構想のスケッチであり正本ではない。
 *
 * @packageDocumentation
 */

import type { PairingCode, PairingRequestId, StreamKind as SessionKind } from "bridge-protocol";

/**
 * セッションの送信方向。正本 0.2 にないため構想スケッチ内で定義し、
 * 0.3 の正本に置き換える。`reliable` は双方向可、`latest` は一方向のみ。
 */
export type SessionDirection = "to_client" | "to_server" | "bidirectional";

/** 接続時の設定 */
export interface ConnectOptions {
  /**
   * ブリッジの接続先。`ws://127.0.0.1:<port>/v1` のみ受け付ける。
   */
  readonly endpoint: string;
  /**
   * 送信する `Origin`。
   *
   * Node 診断用途に限定する。ブラウザでは指定せず、ブラウザが付与する
   * `Origin` を使うこと。Node では未指定だと `Origin` が送出されないため、
   * ブリッジの接続前検証を通過できない。
   */
  readonly origin?: string;
  /**
   * 要求応答の待ち時間（ミリ秒）。有限の正数。
   *
   * 0.2 由来の項目であり、0.3 の request/response 相関の扱いに合わせて見直す。
   *
   * @defaultValue `10000`（省略時に接続処理が適用）。
   */
  readonly requestTimeoutMs?: number;
  /**
   * 0.2 由来の項目であり、0.3 ではアプリ層の待機上限を設けない方向のため見直す。
   *
   * @defaultValue `128`（省略時に接続処理が適用）。
   */
  readonly maxPendingReliable?: number;
  /**
   * 送信メッセージ1件の上限（UTF-8 にシリアライズした JSON 全体のバイト数）。
   *
   * 送信受付前に検査し、超過はローカルで明示エラーにする。
   * 待機総バイトの上限ではなく、1件ごとの検査である。
   *
   * @defaultValue `65536`（省略時に接続処理が適用）。
   */
  readonly maxMessageBytes?: number;
  /**
   * 接続開始から比較コード受信までの待ち時間（ミリ秒）。
   *
   * 有限の正の整数かつタイマー安全範囲（1以上2147483647以下）であること。
   * コード受信で解除し、人間の承認待ちを打ち切らない。
   *
   * @defaultValue 生成時の `requestTimeoutMs`（省略時に接続処理が適用）。
   */
  readonly timeoutMs?: number;
  /**
   * 接続試行を取り消す合図。取消時は `CONNECT_CANCELLED` で拒否しソケットを閉じる。
   */
  readonly signal?: AbortSignal;
}

/** ブリッジが発行した比較コードの表示用情報。 */
export interface PairingInfo {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** ASCII 数字 6 文字の比較コード。 */
  readonly code: PairingCode;
  /** 承認期限の絶対時刻。 */
  readonly expiresAt: number;
  /** 承認までの残り時間（ミリ秒）。 */
  readonly expiresInMs: number;
}

/**
 * セッション作成時のオプション
 *
 * latest, reliableはここで固定する
 */
export interface SessionOptions {
  readonly direction: SessionDirection;
  readonly kind: SessionKind;
}

/**
 * セッション1つあたりの管理オブジェクト。
 *
 * Session は一連のやりとりの単位であり、既定は双方向 yamux stream 1本である。
 * request/response 相関はブリッジ層に持たず、上位層の責務とする。
 */
export interface Session {
  readonly isAlive: boolean;
  /**
   * `reliable` 送信。stream 内で直列化し下位 backpressure を待つ。
   *
   * @returns 完了はローカル送信処理完了であり、相手の受信・業務完了ではない。
   */
  sendReliable(value: unknown): Promise<void>;
  /**
   * `latest` 送信の同期受付。yamux 投入前に最新値を置換する。
   *
   * 戻りは配送完了を意味しない。値ごとの配送 Promise は作らない。
   */
  sendLatest(value: unknown): void;
  onReceive(): (value: unknown) => void;
  onClosed(): () => void;
  close(): void;
}

/**
 * 認証完了後に初めて受け取れる、セッション管理用interface
 */
export interface SessionProvider {
  isAlive: boolean;
  /** 戻り値の型はいい感じのやつを考えたい */
  tryCreateSession(options: SessionOptions): Promise<Session>;
  onClosed(): () => void;
  /** 全セッションを閉じる。内部的にWebSocket接続も終了する */
  close(): void;
}

/**
 * 接続開始リクエストを送った時に受け取る、2つのPromiseを含む型
 *
 * 内部的にWebSocket接続を開始する
 * pairingInfoはブリッジからのペアリングコードが来たら届く
 * sessionProviderは認証完了後に受け取る
 */
export interface ConnectionRequest {
  readonly pairingInfo: Promise<PairingInfo>;
  readonly sessionProvider: Promise<SessionProvider>;
}

export declare function createConnectionRequest(options: ConnectOptions): ConnectionRequest;
