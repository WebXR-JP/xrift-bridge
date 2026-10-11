/**
 * 固定テキスト表示の契約（ワールドと本体の双方が参照する）。
 *
 * ブラウザ安全のため、サーバー側の実装依存を import しない。
 * 型と純粋関数のみで構成する。
 *
 * データ形状：
 * - PC→ワールドは相関識別子とプレーンテキストの表示要求
 *  （`{ op: "show", id, text }`）。
 * - ワールド→PCは同じ識別子の反映確認（`{ op: "shown", id }`）。
 *   本文は返送しない。
 *
 * HTML・Markdown・コマンド解釈はしない。直近一件の置換表示を前提とする。
 *
 * @packageDocumentation
 */

/** PC→ワールドの表示要求の操作名。 */
export const TEXT_SHOW_OP = "show" as const;

/** ワールド→PCの反映確認の操作名。 */
export const TEXT_SHOWN_OP = "shown" as const;

/**
 * 本文の最大長（Unicode コードポイント数）。
 *
 * サロゲートペア・結合文字ではなくコードポイントで数え、改行を含む。
 */
export const TEXT_MAX_CODE_POINTS = 512;

/** 反映確認の応答期限（ミリ秒）。 */
export const TEXT_RESPONSE_TIMEOUT_MS = 10_000;

/**
 * ワールドが生成するテキスト専用セッションの論理名。
 *
 * 割当て候補の特定に使う。論理名の一致は内容の互換性や真正性の証明ではない。
 */
export const TEXT_SESSION_ID = "text" as const;

/**
 * PC→ワールドの表示要求。
 *
 * 相関識別子とプレーンテキストを持ち、HTML・Markdown・コマンド解釈はしない。
 */
export interface TextShowRequest {
  /** 操作名。表示要求のみである。 */
  readonly op: typeof TEXT_SHOW_OP;
  /** 相関識別子。非空文字列である。 */
  readonly id: string;
  /** 表示する本文。非空・上限以内・改行可である。 */
  readonly text: string;
}

/**
 * ワールド→PCの反映確認。
 *
 * 「表示用状態に反映した」ことを表し、本文は返送しない。
 */
export interface TextShownAck {
  /** 操作名。反映確認のみである。 */
  readonly op: typeof TEXT_SHOWN_OP;
  /** 対応する表示要求の相関識別子。 */
  readonly id: string;
}

/**
 * 文字列の Unicode コードポイント数を数える。
 *
 * @param text - 数える文字列。
 * @returns コードポイント数（UTF-16 単位ではない）。
 */
export function countCodePoints(text: string): number {
  // ADR: 文字列の反復子はコードポイント単位であり、サロゲートペアを
  // 一文字として数える。`Array.from` で写しにしてから数える。
  return Array.from(text).length;
}

/**
 * 相関識別子か判定する。
 *
 * @param value - 判定する値。
 * @returns 非空文字列であれば真。
 */
export function isCorrelationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 送信前検証の失敗理由。 */
export type TextInputIssue = "not-string" | "empty" | "too-long";

/**
 * 送信前検証の結果。
 *
 * 不正入力は送信前に拒否するための情報であり、受信検証とは分ける。
 */
export type TextInputValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: TextInputIssue };

/**
 * 送信する本文を送信前に検証する。
 *
 * 非空・上限（512 Unicode コードポイント）以内を受け付け、改行を許す。
 * HTML・Markdown・コマンド解釈はここでは行わない。
 *
 * @param text - 送信したい本文（境界では `unknown` として受ける）。
 * @returns 検証結果。成功時はそのまま送れる本文を返す。
 */
export function validateTextForSend(text: unknown): TextInputValidation {
  if (typeof text !== "string") return { ok: false, reason: "not-string" };
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (countCodePoints(text) > TEXT_MAX_CODE_POINTS) return { ok: false, reason: "too-long" };
  return { ok: true, text };
}

/**
 * プレーンオブジェクトか判定する。
 *
 * @param value - 判定する値。
 * @returns 配列でないオブジェクトであれば真。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 受信した表示要求を検証する（ワールド側の受信検証用）。
 *
 * 余分なキー・未知の操作名・不正な識別子・不正な本文を拒否する。
 *
 * @param payload - 受信した JSON 値。
 * @returns 表示要求の形状であれば真。
 */
export function isTextShowRequest(payload: unknown): payload is TextShowRequest {
  if (!isRecord(payload)) return false;
  // ADR: 余分なキーを黙って受理しない。未知の拡張は破壊的変更として扱う。
  if (Object.keys(payload).length !== 3) return false;
  if (payload["op"] !== TEXT_SHOW_OP) return false;
  if (!isCorrelationId(payload["id"])) return false;
  return validateTextForSend(payload["text"]).ok;
}

/**
 * 受信した反映確認を検証する（PC 側の受信検証用）。
 *
 * 余分なキー・未知の操作名・不正な識別子を拒否する。本文は含まない。
 *
 * @param payload - 受信した JSON 値。
 * @returns 反映確認の形状であれば真。
 */
export function isTextShownAck(payload: unknown): payload is TextShownAck {
  if (!isRecord(payload)) return false;
  // ADR: 余分なキーを黙って受理しない。未知の拡張は破壊的変更として扱う。
  if (Object.keys(payload).length !== 2) return false;
  if (payload["op"] !== TEXT_SHOWN_OP) return false;
  return isCorrelationId(payload["id"]);
}

/**
 * 反映確認が指定の表示要求に対応するか判定する（識別子照合）。
 *
 * 遅延・重複確認を次の要求に対応させないための判定であり、不一致は
 * 無視する（形状自体が不正な場合は別途中断の対象）。
 *
 * @param requestId - 対応を確かめたい表示要求の相関識別子。
 * @param payload - 受信した JSON 値。
 * @returns 形状が正しく識別子が一致すれば真。
 */
export function isAckForRequest(requestId: string, payload: unknown): payload is TextShownAck {
  return isTextShownAck(payload) && payload.id === requestId;
}
