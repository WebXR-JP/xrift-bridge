/**
 * 相対資産宣言の型。
 *
 * ③c で使う、子画面が同梱する相対資産（HTML・CSS・表示素材）の宣言だけを
 * 置く。この単位では解決・読込み・結線の変更を行わず、型の置き場だけを
 * 用意する。実行時の依存を持たない。
 *
 * @packageDocumentation
 */

/**
 * 子画面が同梱する相対資産1件の宣言。
 */
export interface GuiPluginAssetDeclaration {
  /** 子画面の view パスを起点とする相対パス。空でないこと。 */
  readonly relativePath: string;
}

/**
 * companion が申告する相対資産の一覧。
 */
export interface GuiPluginAssetManifest {
  /** 結線後に読み込む同梱子画面の view パス。 */
  readonly viewPath: string;
  /** 同梱する相対資産の一覧。無ければ空配列。 */
  readonly assets: readonly GuiPluginAssetDeclaration[];
}

/**
 * 相対資産のパスか判定する。空・絶対パス・親遡りは受け付けない。
 *
 * @param value - 検査する未知値。
 * @returns 子画面起点の相対パスなら真。
 */
export function isRelativeAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.includes("://")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return true;
}
