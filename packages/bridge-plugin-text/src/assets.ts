/**
 * テキスト子画面の純粋な資産宣言（`./assets`）。
 *
 * ホストへ宣言するのは解決後の相対 entry（`index.html`）と配置名だけであり、
 * プラグイン内部の TS・HTML・CSS ソースパスを持たない。種別トークン・相対
 * entrypoint の定義元は `gui-contract` であり、ここでは再定義しない。
 * 実行時依存を持たず、型と定数だけからなる。
 *
 * @packageDocumentation
 */
import { TEXT_MOUNT_KIND, TEXT_VIEW_ENTRY } from "./gui-contract.ts";

/**
 * テキスト子画面の資産対応付け。ホストの静的 manifest がこの宣言から
 * staging 配置・view 表・copy 表を導く。
 */
export const TEXT_PLUGIN_ASSET = {
  /** companion の種別トークン。登録表の照合に使う。 */
  kind: TEXT_MOUNT_KIND,
  /** Electrobun の view 名。 */
  viewName: "plugin-text",
  /** 配置先の view 配置先（`views/` 配下）。 */
  viewDir: "views/plugin-text",
  /** 子画面の相対 entrypoint（`index.html`）。 */
  viewEntry: TEXT_VIEW_ENTRY,
  /** 解決済みの view パス（`views://...`）。registry に載せる値である。 */
  viewPath: "views://plugin-text/index.html",
} as const;

/** テキスト子画面の資産対応付けの型。 */
export type TextPluginAsset = typeof TEXT_PLUGIN_ASSET;
