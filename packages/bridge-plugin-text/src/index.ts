/**
 * テキストプラグインの公開 entry（本体）。
 *
 * プラグイン定義と UI 非依存の状態・操作・統計を提供する。通信契約
 * （表示要求・反映確認の形状と検証）は `./contract` が持ち、ここでは
 * 再 export しない。ブラウザで使う契約だけが必要な箇所は
 * `bridge-plugin-text/contract` を参照する。
 *
 * @packageDocumentation
 */
export {
  TEXT_PLUGIN_ID,
  TEXT_PORT_ID,
  createTextPlugin,
  textPlugin,
  type TextPluginOperations,
  type TextPluginOptions,
  type TextPluginState,
  type TextSendResult,
  type TextStats,
  type TextUnknownReason,
} from "./plugin.ts";
