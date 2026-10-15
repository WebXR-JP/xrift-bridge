/**
 * 同梱プラグインの選択と登録順の宣言（composition root）。
 *
 * backend が具象を知らずに済むよう、同梱の選択と登録順（text→diagnostic→udp）
 * をここに宣言する。各プラグインの GUI 登録単位
 * （`bridge-plugin-text/gui`・`bridge-plugin-diagnostic/gui`・
 * `bridge-plugin-udp/gui`）を import してよいのはここだけであり、
 * `main` 配下は汎用の登録関数だけを受け取る。登録済みインスタンスや
 * registry singleton を持たず、呼ぶたびに新しい登録単位を渡すため、
 * 同じ登録関数を複数 backend で使い回せる。
 *
 * companion 宣言の解決（相対 entrypoint→解決済み view パス）は backend が
 * 注入された resolver で行い、ここでは行わない。resolver 自体は静的 manifest
 * （`bundled-plugin-assets.ts`）との照合だけであり、endpoint 工場を import
 * しない。
 *
 * @packageDocumentation
 */
import type { GuiPluginRegistrar } from "bridge-gui-plugin-sdk/registration";
import { BUNDLED_PLUGIN_ASSETS, resolveBundledViewPath } from "./bundled-plugin-assets.ts";
import { textGuiRegistration } from "bridge-plugin-text/gui";
import { diagnosticGuiRegistration } from "bridge-plugin-diagnostic/gui";
import { udpGuiRegistration } from "bridge-plugin-udp/gui";

/**
 * 解決前の companion 宣言を manifest と照合し、解決済み view パスを返す。
 *
 * backend の registrar が登録時に使う resolver である。SDK の型を変更せずに
 * 済む形であり、解決は静的 manifest との照合だけである。
 *
 * @param kind - companion の宣言した種別トークン。
 * @param viewEntry - companion の宣言した相対 entrypoint。
 * @returns 解決済みの view パス。
 * @throws `RangeError` — 未登録種別・相対 entrypoint の不一致の場合。
 */
export function resolveBundledPluginViewPath(kind: string, viewEntry: string): string {
  return resolveBundledViewPath(BUNDLED_PLUGIN_ASSETS, kind, viewEntry);
}

/**
 * 同梱プラグインを登録する。登録順は text→diagnostic→udp であり、
 * 管理表示の種別表もこの順に生成される。
 *
 * @param registrar - backend が渡す汎用の登録口。
 */
export function registerBundledPlugins(registrar: GuiPluginRegistrar): void {
  registrar.registerPlugin(textGuiRegistration);
  registrar.registerPlugin(diagnosticGuiRegistration);
  registrar.registerPlugin(udpGuiRegistration);
}

/**
 * 何も登録しない。空構成の検証用であり、本番では使わない。
 *
 * @param _registrar - 使わない登録口。
 */
export function registerNoPlugins(_registrar: GuiPluginRegistrar): void {}
