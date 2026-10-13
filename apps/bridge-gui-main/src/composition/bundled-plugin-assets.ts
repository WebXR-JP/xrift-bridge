/**
 * 同梱プラグイン資産の静的 manifest（composition）。
 *
 * 相対 entrypoint から Electrobun の view 名・配置先・解決済み `views://`
 * パス・コピー元/先への対応付けだけを持ち、platform API・companion factory
 * を import しない。runtime の登録（`bundled-plugins.ts`）と
 * `electrobun.config.ts` の生成は同じ表から純粋関数で導く。実行時の依存を
 * 持たない。
 *
 * @packageDocumentation
 */

/**
 * 同梱プラグイン1件分の資産対応付け。相対 entrypoint 群から view 名・
 * 配置先・解決済みパス・コピー元/先への写像である。
 *
 * 複写元・複写先は package 基準の相対パスで書く（Hutch の解決であり、
 * 起動時の作業ディレクトリに依存しない）。
 */
export interface BundledPluginAssetEntry {
  /** companion の種別トークン。登録表の照合に使う。 */
  readonly kind: string;
  /** Electrobun の view 名。 */
  readonly viewName: string;
  /** 資産ルート（package 基準）。相対 entrypoint 群の起点。 */
  readonly sourceDir: string;
  /** 配置先の view 配置先（package 基準の写し先の接頭辞）。 */
  readonly viewDir: string;
  /** 子画面の相対 entrypoint（例 `index.html`）。資産ルート起点。 */
  readonly viewEntry: string;
  /** 表示スクリプトの相対 entrypoint（例 `index.ts`）。資産ルート起点。 */
  readonly scriptEntry: string;
  /** 表示様式の相対 entrypoint（例 `index.css`）。資産ルート起点。 */
  readonly styleEntry: string;
  /** 子画面スクリプトの複写元（`build.views` の entrypoint）。 */
  readonly scriptSource: string;
  /** 子画面 HTML の複写元。 */
  readonly htmlSource: string;
  /** 子画面 HTML の複写先。 */
  readonly htmlTarget: string;
  /** 子画面 CSS の複写元。 */
  readonly cssSource: string;
  /** 子画面 CSS の複写先。 */
  readonly cssTarget: string;
  /** 解決済みの view パス（`views://...`）。registry に載せる値である。 */
  readonly viewPath: string;
}

/**
 * 同梱プラグイン資産の静的 manifest。登録順は text→diagnostic であり、
 * 管理表示の種別表もこの順に生成される。
 */
export const BUNDLED_PLUGIN_ASSETS: readonly BundledPluginAssetEntry[] = [
  {
    kind: "text",
    viewName: "plugin-text",
    sourceDir: "src/plugin-ui/text",
    viewDir: "views/plugin-text",
    viewEntry: "index.html",
    scriptEntry: "index.ts",
    styleEntry: "index.css",
    scriptSource: "src/plugin-ui/text/index.ts",
    htmlSource: "src/plugin-ui/text/index.html",
    htmlTarget: "views/plugin-text/index.html",
    cssSource: "src/plugin-ui/text/index.css",
    cssTarget: "views/plugin-text/index.css",
    viewPath: "views://plugin-text/index.html",
  },
  {
    kind: "diagnostic",
    viewName: "plugin-diagnostic",
    sourceDir: "src/plugin-ui/diagnostic",
    viewDir: "views/plugin-diagnostic",
    viewEntry: "index.html",
    scriptEntry: "index.ts",
    styleEntry: "index.css",
    scriptSource: "src/plugin-ui/diagnostic/index.ts",
    htmlSource: "src/plugin-ui/diagnostic/index.html",
    htmlTarget: "views/plugin-diagnostic/index.html",
    cssSource: "src/plugin-ui/diagnostic/index.css",
    cssTarget: "views/plugin-diagnostic/index.css",
    viewPath: "views://plugin-diagnostic/index.html",
  },
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
 * @param manifest - 静的 manifest。
 * @returns view 名から entrypoint への表。
 */
export function buildBundledPluginViews(
  manifest: readonly BundledPluginAssetEntry[],
): Record<string, { entrypoint: string }> {
  const views: Record<string, { entrypoint: string }> = {};
  for (const entry of manifest) {
    views[entry.viewName] = { entrypoint: entry.scriptSource };
  }
  return views;
}

/**
 * プラグイン部分の `copy` 表を作る。鍵が複写元・値が複写先である。
 *
 * @param manifest - 静的 manifest。
 * @returns 複写元から複写先への表。
 */
export function buildBundledPluginCopy(
  manifest: readonly BundledPluginAssetEntry[],
): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const entry of manifest) {
    copy[entry.htmlSource] = entry.htmlTarget;
    copy[entry.cssSource] = entry.cssTarget;
  }
  return copy;
}
