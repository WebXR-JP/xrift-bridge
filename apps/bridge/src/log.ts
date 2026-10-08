/**
 * 構造化診断ログの形式。
 *
 * 秘密値・ペアリング秘密・認証トークンはログに出さない。ログは JSON 1行形式で
 * 標準エラーへ出すことを既定とし、CLI の `pair` 応答（標準出力）と分離する。
 *
 * @packageDocumentation
 */

/** 診断ログの1件。`event` で種別を区別する。 */
export type BridgeLogEvent = Record<string, unknown>;

/** 構造化ログの出力先。 */
export type BridgeLogger = (event: BridgeLogEvent) => void;

/**
 * 既定のロガー。JSON 1行を標準エラーへ出す。
 *
 * @param event - 出力する診断内容。
 */
export function defaultLogger(event: BridgeLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/**
 * 診断イベントを組み立てる。
 *
 * @param event - イベント名。
 * @param fields - 付随情報。機微値を含めないこと。
 * @returns ロガーへ渡せる1件。
 */
export function logEvent(event: string, fields?: Record<string, unknown>): BridgeLogEvent {
  return { ts: new Date().toISOString(), event, ...fields };
}
