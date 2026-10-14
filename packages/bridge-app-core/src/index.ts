/**
 * ブリッジアプリのプラグイン基盤（汎用 entry）。
 *
 * 公開内容は `./core` と同じであり、具象プラグイン（`textPlugin`・
 * `diagnosticPlugin`・`TEXT_*`・`DIAGNOSTIC_*`・通信契約）は含まない。
 * 具象を使う箇所は各プラグインパッケージ（`bridge-plugin-text`・
 * `bridge-plugin-diagnostic`）を参照する。
 *
 * @packageDocumentation
 */
export * from "./core.ts";
