/**
 * テキスト表示要求の受信で使う公開型。
 *
 * @packageDocumentation
 */

/** テキスト受信の状態。直近本文の有無と専用セッションの終端を表す。 */
export type TextReceiveStatus = "waiting" | "received" | "ended";

/** 購読者へ配るテキスト表示用の写し。本文は表示専用である。 */
export interface TextSnapshot {
  /** 受信状態。待機・受信済み・中断のいずれかである。 */
  readonly status: TextReceiveStatus;
  /** 直近の本文。未受信・中断前未受信では `null`。 */
  readonly text: string | null;
  /** 直近の表示要求の相関識別子。未受信では `null`。 */
  readonly id: string | null;
}

/** 写しを受け取る購読者。 */
export type TextListener = (snapshot: TextSnapshot) => void;
