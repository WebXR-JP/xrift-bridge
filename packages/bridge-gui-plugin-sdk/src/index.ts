/**
 * GUI プラグイン実装者が参照する公開 SDK 契約。
 *
 * 管理記述子・companion の公開面（宣言・endpoint 工場・endpoint・
 * emission port）・束縛個体限定の参照口・登録口・相対資産宣言の型だけを
 * 束ねる。具象プラグインの import・既定登録の副作用・Electrobun/Bun/Node
 * 実体・ホストソースパス参照を持たない。
 *
 * @packageDocumentation
 */
export {
  isPluginKind,
  type BoundPluginRef,
  type GuiPluginManagementDescriptor,
  type OwnedPluginInstanceInfo,
  type PluginAssignmentCandidate,
  type PluginAssignmentPolicy,
  type PluginAssignmentRequest,
  type PluginAssignmentTarget,
  type PluginBindingInfo,
  type PluginOwnershipPhase,
  type PluginSessionMetadata,
} from "./management.ts";
export {
  type PluginCompanionDeclaration,
  type PluginEmissionPort,
  type PluginEndpoint,
  type PluginEndpointFactory,
  type ResolvedPluginCompanion,
} from "./companion.ts";
export {
  type GuiPluginCompanionRegistrar,
  type GuiPluginEndpointRegistrar,
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
