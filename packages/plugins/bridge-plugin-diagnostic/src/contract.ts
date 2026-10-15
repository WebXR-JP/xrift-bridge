/**
 * 診断の通信契約（ワールドと本体の双方が参照する）。
 *
 * ブラウザ安全のため、サーバー側の実装依存を import しない。
 * 型と定数と純粋な判定のみで構成する。
 *
 * @packageDocumentation
 */

/**
 * 診断の echo 応答用セッションの論理名。
 *
 * 割当て候補の特定に使う。論理名の一致は内容の互換性や真正性の証明ではない。
 */
export const DIAGNOSTIC_ECHO_SESSION_ID = "diag-echo" as const;

/**
 * 診断の ping 応答用セッションの論理名。
 *
 * 割当て候補の特定に使う。論理名の一致は内容の互換性や真正性の証明ではない。
 */
export const DIAGNOSTIC_PING_SESSION_ID = "diag-ping" as const;

/**
 * 診断の応答用セッションの論理名の一覧。
 *
 * 割当て候補の特定に使う。論理名の一致は内容の互換性や真正性の証明ではない。
 */
export const DIAGNOSTIC_SESSION_IDS = [
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
] as const;

/**
 * 診断の応答用セッションの論理名か判定する。
 *
 * 割当て候補の特定に使う。論理名の一致は内容の互換性や真正性の証明ではない。
 *
 * @param value - 判定する値。
 * @returns `DIAGNOSTIC_SESSION_IDS` に含まれる場合に真。
 */
export function isDiagnosticSessionId(
  value: unknown,
): value is (typeof DIAGNOSTIC_SESSION_IDS)[number] {
  return typeof value === "string" && (DIAGNOSTIC_SESSION_IDS as readonly string[]).includes(value);
}
