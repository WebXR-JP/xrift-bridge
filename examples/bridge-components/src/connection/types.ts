/**
 * ブリッジ接続の公開型と、接続開始の差し替え口。
 *
 * 写し（`BridgeSnapshot`）には表示に要る情報だけを載せる。比較コードは
 * 画面表示のみに使い、保存・送信・同期の対象にしない。
 *
 * @packageDocumentation
 */
import type { ConnectOptions, ConnectionRequest } from "world-client";

/** 接続のおおまかな進行。 */
export type BridgePhase = "idle" | "connecting" | "awaiting_approval" | "authorized" | "ended";

/** 比較コードの表示用情報。承認時に両画面で見比べる。 */
export interface PairingView {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: string;
  /** ASCII 数字6文字の比較コード。 */
  readonly code: string;
}

/** 表示用の失敗内容。 */
export interface BridgeErrorView {
  /** 機械可読の符号。 */
  readonly code: string;
  /** 人間可読の説明。 */
  readonly message: string;
}

/** 購読者へ配る接続状態の写し。 */
export interface BridgeSnapshot {
  /** 進行。 */
  readonly phase: BridgePhase;
  /** 正規化済みの接続先。 */
  readonly endpoint: string;
  /** 表示中の比較コード。承認待ち以外は `null`。 */
  readonly pairing: PairingView | null;
  /** 直近の失敗。無ければ `null`。 */
  readonly error: BridgeErrorView | null;
}

/** 写しを受け取る購読者。 */
export type BridgeListener = (snapshot: BridgeSnapshot) => void;

/** 接続開始の差し替え口。試験では偽の管理口を返す実装を渡す。 */
export type CreateConnectionRequestFn = (options: ConnectOptions) => ConnectionRequest;

/** 接続手順の生成条件。 */
export interface BridgeConnectionOptions {
  /** ブリッジの接続先。`ws://127.0.0.1:<port>/v1` のみ受け付ける。 */
  readonly endpoint: string;
  /** 接続開始の実装。省略時は `world-client` の `createConnectionRequest` を使う。 */
  readonly createRequest?: CreateConnectionRequestFn;
}
