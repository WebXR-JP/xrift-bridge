/**
 * GUI プラグイン実装者が参照する公開 SDK 契約。
 *
 * 管理記述子・companion の公開面・登録口・相対資産宣言の型だけを束ねる。
 * 具象プラグインの import・既定登録の副作用・Electrobun/Bun/Node 実体・
 * ホストソースパス参照を持たない。
 *
 * @packageDocumentation
 */
export {
  isPluginKind,
  type GuiPluginAccess,
  type GuiPluginManagementDescriptor,
  type GuiPluginObservation,
  type OwnedPluginInstanceInfo,
  type PluginAssignmentCandidate,
  type PluginAssignmentPolicy,
  type PluginAssignmentRequest,
  type PluginAssignmentTarget,
  type PluginBindingInfo,
  type PluginOperationAccess,
  type PluginOwnershipPhase,
  type PluginSessionMetadata,
  type Stop,
} from "./management.ts";
export {
  type CompanionDesiredBinding,
  type CompanionRequestEnv,
  type PluginCompanion,
  type PluginCompanionDeclaration,
} from "./companion.ts";
export {
  type GuiPluginCompanionRegistrar,
  type GuiPluginManagementRegistrar,
  type GuiPluginRegisterFunction,
  type GuiPluginRegistrar,
  type GuiPluginRegistration,
} from "./registration.ts";
export {
  isRelativeAssetPath,
  type GuiPluginAssetDeclaration,
  type GuiPluginAssetManifest,
} from "./assets.ts";
