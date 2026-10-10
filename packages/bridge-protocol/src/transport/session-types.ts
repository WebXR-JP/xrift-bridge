/**
 * Session の公開 capability 型（判別 Union）。
 *
 * 実行時の状態機械は `SessionEngine`（`session.ts`）が担い、両方の送信 API を
 * 持つ。ここでは `kind` と `direction`（追加フィールドなしで判別できる）で
 * 判別できる公開型だけを定め、型レベルで使える API を制限する。`Connection`
 * は engine そのものを狭窄型で返すため、型に出さないメソッドも実行時には残り、
 * 型を回避した誤用は従来の `SessionError` で拒否する（`TypeError` にしない）。
 * 実行時検証（種別・方向の組合せ、役割との整合）は engine と `Connection` が
 * 担い、ここでは表さない。
 *
 * @packageDocumentation
 */

import type { ConnectionRole } from "./connection.ts";
import type { SessionEnd } from "./session.ts";

/**
 * role ごとの latest 送信方向（outbound の向き）。
 *
 * 作成側は送信側であり、client は `to_server`、server は `to_client` を開く。
 */
export interface LatestSendDirectionMap {
  readonly client: "to_server";
  readonly server: "to_client";
}

/**
 * role ごとの latest 受信方向（inbound の向き）。
 *
 * 受信側は送信側の逆であり、client は `to_client`、server は `to_server` を受ける。
 */
export interface LatestReceiveDirectionMap {
  readonly client: "to_client";
  readonly server: "to_server";
}

/**
 * 公開 Session の共通部。
 *
 * 判別子（`kind`・`direction`）と capability 別の API は各型が定める。
 * `terminate` は `Connection` が担うため公開しない。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
interface SessionCommon<R extends ConnectionRole> {
  /** この Session の論理名。 */
  readonly sessionId: string;
  /** この側が `client`・`server` のどちらであるか。 */
  readonly side: R;
  /** 全体終端していなければ真。 */
  readonly isAlive: boolean;
  /** 受け渡し済みの受信件数。 */
  readonly receivedCount: number;
  /** latest で古い・同値のため捨てた受信件数。 */
  readonly staleDroppedCount: number;
  /** latest で飛び越えた連番の合計。 */
  readonly missingSeqCount: number;
  /** latest の受信連番の最大値。未受信は -1 である。 */
  readonly lastRecvSeq: number;
  /** 自側の送信終了（`closeWrite` 受付）済みか。 */
  readonly writeEnded: boolean;
  /** 相手 FIN の処理（EOF 通知）済みか。 */
  readonly peerEnded: boolean;
  /**
   * 相手 FIN（読み終わり）を購読する。
   *
   * 自側の送信は継続できる。処理済みなら登録時に同期で即時通知する。
   *
   * @param handler - 相手 FIN の処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onRemoteEnd(handler: () => void): () => void;
  /**
   * Session 全体の終端を購読する。一度だけ通知する。
   *
   * 終端済みなら登録時に同期で即時通知する。
   *
   * @param handler - 終端内容を受け取る処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onEnd(handler: (end: SessionEnd) => void): () => void;
  /**
   * 送信方向を正常終了する（FIN）。
   *
   * 新規送信を止め、受付済みの排出後に FIN を送る。二重呼び出しは同じ結果を返す。
   *
   * @returns FIN 送出の完了で解ける約束。
   */
  closeWrite(): Promise<void>;
  /**
   * 即時中断する（RST）。
   *
   * 待機送信・未完成フレームを破棄する。他 Session は維持する。二重呼び出しは無視する。
   *
   * @param error - 中断の原因。省略時は Session の中断として扱う。
   */
  abort(error?: Error): void;
}

/**
 * 双方向 reliable Session。
 *
 * `sendReliable` と `onMessage` を持つ。`kind`・`direction` で判別して使う。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
export interface ReliableSession<
  R extends ConnectionRole = ConnectionRole,
> extends SessionCommon<R> {
  /** 配送種別。reliable は双方向のみである。 */
  readonly kind: "reliable";
  /** 許す送信方向。reliable は双方向のみである。 */
  readonly direction: "bidirectional";
  /**
   * 確実に届けたい値を送る。
   *
   * @param value - 配送する JSON 値（`null` を含む）。
   * @returns ローカル送信処理の完了で解ける約束。相手受信・業務完了ではない。
   */
  sendReliable(value: unknown): Promise<void>;
  /**
   * 受信した payload を購読する。
   *
   * 登録前の到着分は順序どおり渡す。購読者の例外は隔離する。
   *
   * @param handler - payload を受け取る処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onMessage(handler: (payload: unknown) => void): () => void;
}

/**
 * latest 送信側 Session。
 *
 * `sendLatest` だけを持ち、`onMessage` は持たない。方向は役割で決まる。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
export interface LatestSenderSession<
  R extends ConnectionRole = ConnectionRole,
> extends SessionCommon<R> {
  /** 配送種別。latest は一方向のみである。 */
  readonly kind: "latest";
  /** 許す送信方向。役割に応じた送信方向のみである。 */
  readonly direction: LatestSendDirectionMap[R];
  /**
   * 最新の状態を送る（同期受付）。
   *
   * 値ごとの約束は作らず、非同期失敗は Session の終端通知で知らせる。
   *
   * @param value - 配送する JSON 値（`null` を含む）。
   */
  sendLatest(value: unknown): void;
}

/**
 * latest 受信側 Session。
 *
 * `onMessage` だけを持ち、`sendLatest` は持たない。方向は役割で決まる。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
export interface LatestReceiverSession<
  R extends ConnectionRole = ConnectionRole,
> extends SessionCommon<R> {
  /** 配送種別。latest は一方向のみである。 */
  readonly kind: "latest";
  /** 許す送信方向。役割に応じた受信方向のみである。 */
  readonly direction: LatestReceiveDirectionMap[R];
  /**
   * 受信した payload を購読する。
   *
   * 登録前の到着分は順序どおり渡す。購読者の例外は隔離する。
   *
   * @param handler - payload を受け取る処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onMessage(handler: (payload: unknown) => void): () => void;
}

/**
 * 公開 Session（`kind`・`direction` で判別する合併）。
 *
 * `kind` が `"reliable"` なら双方向、`"latest"` なら `direction` で送受信が決まる。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
export type Session<R extends ConnectionRole = ConnectionRole> =
  | ReliableSession<R>
  | LatestSenderSession<R>
  | LatestReceiverSession<R>;

/**
 * inbound として受け取れる Session（reliable または latest 受信側）。
 *
 * `Connection` の `onSession` 通知の型である。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
export type InboundSession<R extends ConnectionRole = ConnectionRole> =
  | ReliableSession<R>
  | LatestReceiverSession<R>;

/**
 * outbound として開ける Session（reliable または latest 送信側）。
 *
 * 動的な合法要求に対する `createSession` の戻り型である。
 *
 * @typeParam R - この Session が属する `Connection` の役割。
 */
export type OutboundSession<R extends ConnectionRole = ConnectionRole> =
  | ReliableSession<R>
  | LatestSenderSession<R>;
