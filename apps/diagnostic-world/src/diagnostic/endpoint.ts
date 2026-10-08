/**
 * 診断の接続先（ポート入力・接続先組み立て）。React・R3F に依存しない。
 *
 * ホスト・パスは loopback 固定とし、利用者が変えられるのはポートだけにする。
 *
 * @packageDocumentation
 */

/** ブリッジの既定ポート。 */
export const DEFAULT_PORT = 3100;

/** ブリッジの固定ホスト。loopback 以外は受け付けない。 */
export const BRIDGE_LOOPBACK_HOST = "127.0.0.1";

/** ブリッジの固定パス。 */
export const BRIDGE_PATH = "/v1";

/** ポート入力の解釈結果。 */
export type ParsedPort =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly error: string };

/**
 * ポート入力を解釈する。
 *
 * @param text - 入力文字列。前後の空白は詰める。
 * @returns 有効な場合はポート番号、そうでない場合は理由。
 */
export function parsePortInput(text: string): ParsedPort {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "ポートを入力すること。" };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return { ok: false, error: "ポートは 1〜65535 の整数であること。" };
  }
  return { ok: true, port: parsed };
}

/**
 * ポート番号から正規の接続先を組み立てる。
 *
 * @param port - ポート番号。1〜65535 の整数。
 * @returns `ws://127.0.0.1:<port>/v1`。
 * @throws `RangeError` — `port` が範囲外の場合。
 */
export function buildEndpoint(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("ポートは 1〜65535 の整数であること。");
  }
  return `ws://${BRIDGE_LOOPBACK_HOST}:${port}${BRIDGE_PATH}`;
}
