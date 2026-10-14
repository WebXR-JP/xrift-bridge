/**
 * 同梱プラグイン資産の静的 manifest（composition）。
 *
 * 相対 entrypoint から Electrobun の view 名・配置先・解決済み `views://`
 * パス・コピー元/先への対応付けだけを持ち、platform API・companion factory
 * を import しない。runtime の登録（`bundled-plugins.ts`）と
 * `electrobun.config.ts` の生成は同じ表から純粋関数で導く。実行時の依存を
 * 持たない。
 *
 * 同梱表は各プラグインパッケージの `./assets` 宣言から導出する。
 * プラグイン内部の TS・HTML・CSS ソースパスを持たず、完成資産の正本は
 * 各パッケージの `dist/view` であり、stage script が staging
 * （`src/plugin-view-dist/<種別>/`）へ写す。`build.views` は両方とも
 * 汎用 stub（`src/mainview-stub.ts` の再利用）とし、`copy` は staged
 * ディレクトリごと `views/plugin-<種別>/` へ載せる形に統一する。
 *
 * @packageDocumentation
 */
import { TEXT_PLUGIN_ASSET } from "bridge-plugin-text/assets";
import { DIAGNOSTIC_PLUGIN_ASSET } from "bridge-plugin-diagnostic/assets";

/**
 * 同梱プラグイン1件分の資産対応付け。
 *
 * 相対 entrypoint（`index.html`）から view 名・配置先・解決済みパス・
 * staging 配置への写像である。複写元・複写先は package 基準の相対パスで
 * 書く（Hutch の解決であり、起動時の作業ディレクトリに依存しない）。
 */
export interface BundledPluginAssetEntry {
  /** companion の種別トークン。登録表の照合に使う。 */
  readonly kind: string;
  /** Electrobun の view 名。 */
  readonly viewName: string;
  /** 配置先の view 配置先（package 基準の写し先の接頭辞）。 */
  readonly viewDir: string;
  /** 子画面の相対 entrypoint（例 `index.html`）。ホストへ宣言する bundle の entry である。 */
  readonly viewEntry: string;
  /** 解決済みの view パス（`views://...`）。registry に載せる値である。 */
  readonly viewPath: string;
  /** staging の配置元（package 基準の相対ディレクトリ）。 */
  readonly stagedDir: string;
  /** `build.views` の汎用 stub（完成資産ではない）。 */
  readonly stubSource: string;
}

/** `build.views` の汎用 stub。管理画面と共有する（stub の分岐を作らない）。 */
const STUB_SOURCE = "src/mainview-stub.ts";

/**
 * プラグインの純粋な資産宣言から同梱表の1件を導く。
 *
 * staging 配置は種別名から一意に決まる（`src/plugin-view-dist/<種別>/`）。
 * 種別ごとの分岐を持たず、新種別の追加は呼出し側の1行である。
 *
 * @param asset - プラグインパッケージの `./assets` 宣言。
 * @returns 同梱表の1件。
 */
function deriveBundledPluginAsset(asset: {
  readonly kind: string;
  readonly viewName: string;
  readonly viewDir: string;
  readonly viewEntry: string;
  readonly viewPath: string;
}): BundledPluginAssetEntry {
  return {
    kind: asset.kind,
    viewName: asset.viewName,
    viewDir: asset.viewDir,
    viewEntry: asset.viewEntry,
    viewPath: asset.viewPath,
    stagedDir: `src/plugin-view-dist/${asset.kind}`,
    stubSource: STUB_SOURCE,
  };
}

/**
 * 同梱プラグイン資産の静的 manifest。登録順は text→diagnostic であり、
 * 管理表示の種別表もこの順に生成される。
 */
export const BUNDLED_PLUGIN_ASSETS: readonly BundledPluginAssetEntry[] = [
  deriveBundledPluginAsset(TEXT_PLUGIN_ASSET),
  deriveBundledPluginAsset(DIAGNOSTIC_PLUGIN_ASSET),
];

/**
 * 種別トークンから資産対応付けを引く。未登録なら `undefined` とし、
 * 呼び出し側が拒否する。
 *
 * @param manifest - 静的 manifest。
 * @param kind - 照合する種別トークン。
 * @returns 資産対応付け。未登録なら `undefined`。
 */
export function getBundledPluginAsset(
  manifest: readonly BundledPluginAssetEntry[],
  kind: string,
): BundledPluginAssetEntry | undefined {
  return manifest.find((entry) => entry.kind === kind);
}

/**
 * 解決前の宣言を manifest と照合し、解決済み view パスを返す。
 *
 * 種別未登録・相対 entrypoint の不一致は実装の不備であり、黙って配置を
 * 作らない。到達不能の前提であり、束縛側の拒否と例外の種類を揃える。
 *
 * @param manifest - 静的 manifest。
 * @param kind - companion の宣言した種別トークン。
 * @param viewEntry - companion の宣言した相対 entrypoint。
 * @returns 解決済みの view パス。
 * @throws `RangeError` — 未登録種別・相対 entrypoint の不一致の場合。
 */
export function resolveBundledViewPath(
  manifest: readonly BundledPluginAssetEntry[],
  kind: string,
  viewEntry: string,
): string {
  const entry = getBundledPluginAsset(manifest, kind);
  if (entry === undefined) {
    throw new RangeError(`未登録の種別の資産である: ${kind}`);
  }
  if (entry.viewEntry !== viewEntry) {
    throw new RangeError(`資産の相対 entrypoint が manifest と一致しない: ${kind}`);
  }
  return entry.viewPath;
}

/**
 * プラグイン部分の `build.views` 表を作る。値は entrypoint だけを持つ。
 *
 * 全種別で汎用 stub を entrypoint とする（完成資産は `copy` が載せる）。
 *
 * @param manifest - 静的 manifest。
 * @returns view 名から entrypoint への表。
 */
export function buildBundledPluginViews(
  manifest: readonly BundledPluginAssetEntry[],
): Record<string, { entrypoint: string }> {
  const views: Record<string, { entrypoint: string }> = {};
  for (const entry of manifest) {
    views[entry.viewName] = { entrypoint: entry.stubSource };
  }
  return views;
}

/**
 * プラグイン部分の `copy` 表を作る。鍵が複写元・値が複写先である。
 *
 * 全種別で staged ディレクトリごと配置先へ載せる（mainview の
 * 写しと同じ載せ方）。
 *
 * @param manifest - 静的 manifest。
 * @returns 複写元から複写先への表。
 */
export function buildBundledPluginCopy(
  manifest: readonly BundledPluginAssetEntry[],
): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const entry of manifest) {
    copy[entry.stagedDir] = entry.viewDir;
  }
  return copy;
}
