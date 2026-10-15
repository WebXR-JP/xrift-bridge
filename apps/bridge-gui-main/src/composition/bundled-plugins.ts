/**
 * 同梱プラグインの選択と登録順の宣言（composition root）。
 *
 * backend が具象を知らずに済むよう、同梱の選択と登録順（text→diagnostic→udp）、
 * 管理記述子・companion factory の対応付けをここに宣言する。各プラグインの
 * GUI 登録口（`bridge-plugin-text/gui`・`bridge-plugin-diagnostic/gui`・`bridge-plugin-udp/gui`）を import してよいのはここだけであり、
 * `main` 配下は汎用の登録関数だけを受け取る。登録済みインスタンスや
 * registry singleton を持たず、呼ぶたびに新しい companion・公開参照口を作る
 * ため、同じ登録関数を複数 backend で使い回せる。
 *
 * companion factory は解決前の宣言（振る舞いと相対 entrypoint）だけを返し、
 * ここで静的 manifest（`bundled-plugin-assets.ts`）と照合して解決済み
 * view パスを付与し、登録表に載せる。registry は解決済みだけを扱う。
 *
 * @packageDocumentation
 */
import type { GuiPluginRegistrar } from "bridge-gui-plugin-sdk/registration";
import type { PluginCompanion, PluginCompanionDeclaration } from "bridge-gui-plugin-sdk/companion";
import { BUNDLED_PLUGIN_ASSETS, resolveBundledViewPath } from "./bundled-plugin-assets.ts";
import { createTextCompanion, textManagement } from "bridge-plugin-text/gui";
import { createDiagnosticCompanion, diagnosticManagement } from "bridge-plugin-diagnostic/gui";
import { createUdpCompanion, udpManagement } from "bridge-plugin-udp/gui";

/**
 * 解決前の宣言に解決済み view パスを付与する。相対 entrypoint は manifest と
 * 照合し、不一致・未登録は拒否する。登録表に載せるのは解決済みだけである。
 *
 * @param declaration - companion factory が返した解決前の宣言。
 * @returns 登録表に載せる解決済みの記述子。
 * @throws `RangeError` — 未登録種別・相対 entrypoint の不一致の場合。
 */
export function resolveCompanion(declaration: PluginCompanionDeclaration): PluginCompanion {
  const viewPath = resolveBundledViewPath(
    BUNDLED_PLUGIN_ASSETS,
    declaration.kind,
    declaration.viewEntry,
  );
  // ADR: 相対 entrypoint の宣言（`viewEntry`）は解決の材料であり、登録表の
  // 記述子には載せない。残余の振る舞いはそのまま引き継ぐ。
  const { viewEntry: _viewEntry, ...behavior } = declaration;
  void _viewEntry;
  return { ...behavior, viewPath };
}

/**
 * 同梱プラグインを登録する。登録順は text→diagnostic→udp であり、
 * 管理表示の種別表もこの順に生成される。
 *
 * @param registrar - backend が渡す汎用の登録口。
 */
export function registerBundledPlugins(registrar: GuiPluginRegistrar): void {
  registrar.registerPlugin({
    management: textManagement,
    createCompanion: (access) => resolveCompanion(createTextCompanion(access)),
  });
  registrar.registerPlugin({
    management: diagnosticManagement,
    createCompanion: (access) => resolveCompanion(createDiagnosticCompanion(access)),
  });
  registrar.registerPlugin({
    management: udpManagement,
    createCompanion: (access) => resolveCompanion(createUdpCompanion(access)),
  });
}

/**
 * 何も登録しない。空構成の検証用であり、本番では使わない。
 *
 * @param _registrar - 使わない登録口。
 */
export function registerNoPlugins(_registrar: GuiPluginRegistrar): void {}
