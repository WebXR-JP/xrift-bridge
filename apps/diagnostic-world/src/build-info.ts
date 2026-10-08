/**
 * 実行ビルドの識別子。
 *
 * vite.config.ts の `define` で `__DIAGNOSTIC_BUILD__` に埋め込む。
 * 診断パネルと診断結果に表示・記録する（秘密値・payload は含まない）。
 *
 * @packageDocumentation
 */

/** 実行ビルドの識別子。 */
export interface DiagnosticBuildInfo {
  /** パッケージのバージョン。 */
  readonly version: string;
  /** ビルド時の git コミット（短縮）。取得できない場合は `unknown`。 */
  readonly commit: string;
  /** ビルド時刻（ISO 8601）。 */
  readonly builtAt: string;
}

declare const __DIAGNOSTIC_BUILD__: DiagnosticBuildInfo;

/**
 * 実行ビルドの識別子を返す。
 *
 * @returns ビルド時に埋め込んだ識別子の写し。
 */
export function getBuildInfo(): DiagnosticBuildInfo {
  return { ...__DIAGNOSTIC_BUILD__ };
}
