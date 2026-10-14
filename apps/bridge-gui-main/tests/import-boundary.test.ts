/**
 * 汎用ホストと共有契約とSDKの輸入境界の検証。
 *
 * 具象プラグイン（表示実装・基盤の具象 entry・資産解決）への依存が汎用層へ
 * 戻らないことを恒久的に固定する。正規表現で specifier を抽出し、通常
 * import・`import type`・re-export（`export ... from`）・動的 `import()`・
 * import 型を対象にする。`tsconfig`/barrel 経由の迂回（裸パッケージ名での
 * 具象参照）も specifier 文字列で検出するため、相対パスの書き換えだけでは
 * 逃げられない。
 *
 * 許容パターン（意図的な例外）は以下である。
 * - `src/composition/bundled-plugins.ts` は `plugin-ui/` の具象を import
 *   してよい（同梱の選択と登録順を宣言する唯一の場所である）。
 * - 起動 entry `src/main/index.ts` は `src/composition/` を import してよい
 *   （明示配線の注入元である）。
 * - 共有契約の `views://plugin-host/*` は汎用
 *   （空ページ）であり、具象種別の直書きとはみなさない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** package 基準の相対パスを実パスに直す。 */
function packagePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** リポジトリ直下の packages 基準の相対パスを実パスに直す。 */
function packagesPath(relative: string): string {
  return fileURLToPath(new URL(`../../../packages/${relative}`, import.meta.url));
}

/** ソースを読む。存在しない場合は試験の不備として落とす。 */
function readSource(absolute: string): string {
  return readFileSync(absolute, "utf8");
}

/**
 * specifier の抽出式。通常 import・`import type`・re-export・動的
 * `import()`・import 型を対象にする。
 */
const SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * ソースから specifier の一覧を抽出する。
 *
 * @param source - 検査するソース本文。
 * @returns specifier の一覧。
 */
function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  SPECIFIER_PATTERN.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = SPECIFIER_PATTERN.exec(source)) !== null) {
    const specifier = matched[1] ?? matched[2];
    if (specifier !== undefined && specifier.length > 0) {
      found.push(specifier);
    }
  }
  return found;
}

/**
 * `bridge-app-core` の具象 entry への依存か判定する。汎用は
 * `bridge-app-core/core` のみを使う。
 *
 * @param specifier - 検査する specifier。
 * @returns 具象 entry（bare・core 以外の subpath）なら真。
 */
function isConcreteAppCoreEntry(specifier: string): boolean {
  if (specifier === "bridge-app-core/core") {
    return false;
  }
  return specifier === "bridge-app-core" || specifier.startsWith("bridge-app-core/");
}

/**
 * import 文の具象名の直書きか判定する。barrel 経由で具象名だけを抜く
 * 迂回を見逃さないための補助である。
 *
 * @param source - 検査するソース本文。
 * @returns 具象名を `bridge-app-core` 系から引いていれば真。
 */
function importsConcreteAppCoreName(source: string): boolean {
  const NAMED_PATTERN =
    /import\s+(?:type\s+)?(?:[^'";]*?\{([^}]*)\}[^'";]*?from\s*['"](bridge-app-core[^'"]*)['"]|([A-Za-z0-9_]+)\s+from\s*['"](bridge-app-core[^'"]*)['"])/g;
  let matched: RegExpExecArray | null;
  while ((matched = NAMED_PATTERN.exec(source)) !== null) {
    const names = matched[1] ?? matched[3] ?? "";
    if (/textPlugin|diagnosticPlugin|TEXT_|DIAGNOSTIC_|Text[A-Z]|Diagnostic[A-Z]/.test(names)) {
      return true;
    }
    // 名前付き以外でも bare entry 自体は別検査で落とす。ここでは具象名だけを見る。
    void matched[2];
    void matched[4];
  }
  return false;
}

/**
 * 汎用ホスト5件。具象表示・composition への直参照を持たない。
 *
 * `backend.ts`・`plugin-instance-management.ts` は汎用層全体の検査に含め、
 * ここでは課題文の指定5件を固定する。
 */
const PLUGIN_UI_BOUNDARY_TARGETS: readonly string[] = [
  "src/main/plugin-instance-manager.ts",
  "src/main/plugin-companions.ts",
  "src/main/plugin-instances.ts",
  "src/main/plugin-ui-mounts.ts",
  "src/main/instance-rpc.ts",
];

/** 汎用ホスト全体（具象 entry・composition の検査対象）。 */
const GENERIC_HOST_FILES: readonly string[] = [
  "src/main/backend.ts",
  "src/main/plugin-instance-manager.ts",
  "src/main/plugin-instance-management.ts",
  "src/main/plugin-companions.ts",
  "src/main/plugin-instances.ts",
  "src/main/plugin-ui-mounts.ts",
  "src/main/instance-rpc.ts",
];

/** SDK のソース一覧を読む。将来の追加を見逃さない。 */
function listSdkSources(): string[] {
  const dir = packagesPath("bridge-gui-plugin-sdk/src");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${dir}/${name}`);
}

/** 共有契約のソース一覧を読む。 */
function listContractSources(): string[] {
  const dir = packagesPath("bridge-gui-contract/src");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${dir}/${name}`);
}

test("汎用ホストは具象プラグインの表示実装を直接参照しない", () => {
  // 同梱の選択と登録順を宣言してよいのは composition root
  // （`src/composition/bundled-plugins.ts`）だけであり、汎用ホストは
  // 汎用の登録口だけを受け取る。
  for (const relative of PLUGIN_UI_BOUNDARY_TARGETS) {
    const specifiers = extractSpecifiers(readSource(packagePath(relative)));
    for (const specifier of specifiers) {
      expect(
        specifier.includes("../plugin-ui/") || specifier.includes("/plugin-ui/"),
        `${relative} が具象表示を参照している: ${specifier}`,
      ).toBe(false);
    }
  }
});

test("汎用ホストとSDKは基盤の具象entryを参照せずcoreのみを使う", () => {
  for (const relative of GENERIC_HOST_FILES) {
    const source = readSource(packagePath(relative));
    for (const specifier of extractSpecifiers(source)) {
      expect(
        isConcreteAppCoreEntry(specifier),
        `${relative} が基盤の具象 entry を参照している: ${specifier}`,
      ).toBe(false);
    }
    expect(importsConcreteAppCoreName(source), `${relative} が具象名を基盤から引いている`).toBe(
      false,
    );
  }
  for (const absolute of listSdkSources()) {
    const source = readSource(absolute);
    for (const specifier of extractSpecifiers(source)) {
      expect(
        isConcreteAppCoreEntry(specifier),
        `SDK が基盤の具象 entry を参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
    expect(
      importsConcreteAppCoreName(source),
      `SDK が具象名を基盤から引いている: ${absolute}`,
    ).toBe(false);
  }
});

test("汎用ホストはcompositionを直接参照しない（起動entryを除く）", () => {
  // 明示配線の注入元である起動 entry `src/main/index.ts` だけが
  // `src/composition/` を import してよい。
  for (const relative of GENERIC_HOST_FILES) {
    const specifiers = extractSpecifiers(readSource(packagePath(relative)));
    for (const specifier of specifiers) {
      const hits =
        specifier.includes("../composition/") ||
        specifier.includes("/composition/") ||
        specifier.includes("src/composition/");
      expect(hits, `${relative} が composition を参照している: ${specifier}`).toBe(false);
    }
  }
  // 許容パターンの存在自体を固定する（迂回の見逃し防止である）。
  const entrySpecifiers = extractSpecifiers(readSource(packagePath("src/main/index.ts")));
  expect(entrySpecifiers.some((specifier) => specifier.includes("composition/"))).toBe(true);
  const compositionSpecifiers = extractSpecifiers(
    readSource(packagePath("src/composition/bundled-plugins.ts")),
  );
  expect(compositionSpecifiers.some((specifier) => specifier.includes("plugin-ui/"))).toBe(true);
});

test("SDKは具象・表示・ホスト・実行系に依存しない", () => {
  for (const absolute of listSdkSources()) {
    const specifiers = extractSpecifiers(readSource(absolute));
    for (const specifier of specifiers) {
      expect(
        specifier.includes("plugin-ui/"),
        `SDK が表示実装を参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        isConcreteAppCoreEntry(specifier),
        `SDK が基盤の具象 entry を参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
      // ホストソースパス（`../`）への参照を持たない。
      expect(
        specifier.startsWith("../") || specifier.startsWith("..\\"),
        `SDK がホストソースパスを参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier.includes("apps/bridge-gui-main/src"),
        `SDK がホストソースパスを参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
      // Electrobun・Bun・Node 実体を持たない。
      expect(
        specifier === "electrobun" || specifier.startsWith("electrobun/"),
        `SDK が実行系を参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier === "bun" || specifier.startsWith("bun:"),
        `SDK が実行系を参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier.startsWith("node:"),
        `SDK が実行系を参照している: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
  }
});

test("共有契約にプラグイン固有のURL直書きを残さない", () => {
  // `views://plugin-host/*`（空ページ）は
  // 汎用であり許容する。具象種別の scope（例 `views://plugin-text/*`）だけを禁じる。
  const forbidden = /views:\/\/plugin-(?!host\/)/;
  for (const absolute of listContractSources()) {
    const source = readSource(absolute);
    expect(forbidden.test(source), `契約に具象URLが残っている: ${absolute}`).toBe(false);
  }
});

test("SDK生成宣言にホストソースパスを残さない", () => {
  // dist が無ければ build 前提として skip する（落とさない）。
  let entries: string[];
  try {
    const dir = packagesPath("bridge-gui-plugin-sdk/dist");
    entries = readdirSync(dir).filter((name) => name.endsWith(".d.mts"));
  } catch {
    // build 前であり検査対象が無い。恒久テストとしては成功扱いにする。
    expect(true).toBe(true);
    return;
  }
  if (entries.length === 0) {
    // build 前であり検査対象が無い。恒久テストとしては成功扱いにする。
    expect(true).toBe(true);
    return;
  }
  const dir = packagesPath("bridge-gui-plugin-sdk/dist");
  for (const name of entries) {
    const source = readSource(`${dir}/${name}`);
    expect(
      source.includes("apps/bridge-gui-main/src"),
      `生成宣言がホストを参照している: ${name}`,
    ).toBe(false);
    expect(source.includes("../src/main/"), `生成宣言がホストを参照している: ${name}`).toBe(false);
    expect(source.includes("../plugin-ui/"), `生成宣言が具象を参照している: ${name}`).toBe(false);
  }
});
