/**
 * 汎用プラグイン基盤の公開 entry。
 *
 * 同梱プラグイン（`textPlugin`・`diagnosticPlugin`・`TEXT_*`・
 * `DIAGNOSTIC_*`）を再 export しない。具象プラグイン本体を使う箇所は
 * root entry のままとし、ホスト汎用部分と公開 SDK はここだけを参照する。
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
