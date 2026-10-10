/**
 * ブリッジアプリのプラグイン基盤。
 *
 * プラグイン定義とインスタンス管理、接続口の適合判定、割当て・解除、
 * 失効処理、UI 非依存の状態と操作、同梱プラグインを提供する。
 * GUI ライブラリは参照しない。
 *
 * @packageDocumentation
 */
export {
  capabilityEquals,
  type PluginDefinition,
  type PluginInstance,
  type PluginInstanceHandle,
  type PluginPort,
  type SessionCapability,
} from "./plugin.ts";
export {
  wrapServerSession,
  type AssignedLatestReceiverSession,
  type AssignedLatestSenderSession,
  type AssignedReliableSession,
  type AssignedSession,
  type RevocableAssignedSession,
  type Unsubscribe,
} from "./assigned-session.ts";
export {
  createBridgeAppCore,
  type AssignmentInfo,
  type BridgeAppCore,
  type BridgeServerPort,
} from "./app-core.ts";
export {
  DIAGNOSTIC_PLUGIN_ID,
  DIAGNOSTIC_PORT_ID,
  diagnosticPlugin,
  type DiagnosticStats,
} from "./plugins/diagnostic.ts";
