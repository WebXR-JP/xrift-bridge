/**
 * パッケージ所有境界の検証。
 *
 * 各プラグインパッケージが GUI companion と子画面資産を所有する境界を
 * 恒久的に固定する。正規表現で specifier を抽出し、通常 import・
 * `import type`・re-export（`export ... from`）・動的 `import()`・
 * import 型・`require()` を対象にする。specifier のパッケージ名だけでなく、相対参照の
 * 解決先も確認し、名称変更・相対書換えによる迂回を見逃さない。
 * プラグイン間の参照は公開 entry 越しだけを許し、`/dist/`・`/src/` 直参照を禁じる。
 *
 * 許容パターン（意図的な例外）は以下である。
 * - `src/composition/bundled-plugins.ts` は各パッケージの `./gui` だけを
 *   import してよい（同梱の選択と登録順を宣言する唯一の場所である）。
 * - `src/composition/bundled-plugin-assets.ts` は各パッケージの `./assets`
 *   宣言だけを import してよい（同梱表を導出する唯一の場所である）。
 * - 起動 entry `src/main/index.ts` は `src/composition/` を import してよい
 *   （明示配線の注入元である）。
 * - 診断の GUI 登録口（`bridge-plugin-diagnostic/gui`）は公開契約越しに
 *   `bridge-plugin-text/contract` を参照してよい（text 割当てとの排他用。
 *   内部ソース参照ではない）。
 * - 共有契約の `views://plugin-host/*` は汎用（空ページ）であり、
 *   具象種別の直書きとはみなさない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** package 基準の相対パスを実パスに直す。 */
function packagePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** リポジトリ直下の packages 基準の相対パスを実パスに直す。 */
function packagesPath(relative: string): string {
  return fileURLToPath(new URL(`../../../packages/${relative}`, import.meta.url));
}

/** リポジトリ直下の apps 基準の相対パスを実パスに直す。 */
function appsPath(relative: string): string {
  return fileURLToPath(new URL(`../../../apps/${relative}`, import.meta.url));
}

/** ソースを読む。存在しない場合は試験の不備として落とす。 */
function readSource(absolute: string): string {
  return readFileSync(absolute, "utf8");
}

/**
 * specifier の抽出式。通常 import・`import type`・re-export・動的
 * `import()`・import 型・`require()` を対象にする。
 *
 * `require()` を含める理由は、bare import の検査だけでは
 * `require("bridge-plugin-*")` による迂回を見逃すためである。
 * production source に現状 `require()` は無く、使うこと自体を禁じる
 * 検査と併せて両面で固定する。
 */
const SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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
    const specifier = matched[1] ?? matched[2] ?? matched[3];
    if (specifier !== undefined && specifier.length > 0) {
      found.push(specifier);
    }
  }
  return found;
}

/**
 * `require()` 呼び出しか判定する。迂回手段の存在自体を検出する。
 *
 * @param source - 検査するソース本文。
 * @returns `require(`・`createRequire` があれば真。
 */
function usesRequire(source: string): boolean {
  return /\brequire\s*\(/.test(source) || source.includes("createRequire");
}

/**
 * 除外すべき生成物ディレクトリ名。production source の再帰列挙で落とす。
 */
const EXCLUDED_DIRS = new Set(["node_modules", ".hutch", "dist", "build", "mainview-dist"]);

/**
 * production source の拡張子。ワールドの `.tsx` と同じ扱いに揃え、
 * 将来の `.mts`・`.cts` も拾う（現状は `.ts`・`.tsx` のみ）。
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * production source を再帰列挙する。固定ファイル列挙ではなく、
 * 該当ディレクトリ配下をすべて拾い、将来の追加を見逃さない。
 *
 * @param absoluteDir - 列挙起点の実パス。
 * @param extensions - 対象の拡張子。
 * @returns ソース実パスの列挙。
 */
function listProductionSources(absoluteDir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(name)) continue;
      const absolute = resolve(dir, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (extensions.some((extension) => name.endsWith(extension))) {
        found.push(absolute);
      }
    }
  };
  visit(absoluteDir);
  return found.sort();
}

/**
 * 具象プラグインパッケージへの bare 参照か判定する。
 *
 * root・subpath・型 import・re-export・動的 import を含め、名称変更による
 * 迂回を防ぐため package 名の接頭辞で判定する。
 *
 * @param specifier - 検査する specifier。
 * @returns `bridge-plugin-*` への参照なら真。
 */
function isBridgePluginSpecifier(specifier: string): boolean {
  return specifier === "bridge-plugin" || specifier.startsWith("bridge-plugin-");
}

/**
 * 公開 entry の一覧。プラグイン間の参照・ワールドの利用はここに載る
 * entry 越しだけを許し、`/dist/`・`/src/` 直参照を禁じる。
 */
const PUBLIC_PLUGIN_ENTRIES = new Set([
  "bridge-plugin-text",
  "bridge-plugin-diagnostic",
  "bridge-plugin-text/contract",
  "bridge-plugin-text/gui",
  "bridge-plugin-text/gui-contract",
  "bridge-plugin-text/assets",
  "bridge-plugin-text/package.json",
  "bridge-plugin-diagnostic/gui",
  "bridge-plugin-diagnostic/gui-contract",
  "bridge-plugin-diagnostic/assets",
  "bridge-plugin-diagnostic/package.json",
]);

/**
 * 公開 entry 越しの参照か判定する。`/dist/`・`/src/` 直参照は
 * 公開面を迂回する内部持込みであり、ここで落とす。
 *
 * @param specifier - 検査する specifier。
 * @returns 公開 entry のいずれかに一致すれば真。
 */
function isPublicPluginEntry(specifier: string): boolean {
  return PUBLIC_PLUGIN_ENTRIES.has(specifier);
}

/**
 * 相対参照の解決先が具象プラグインパッケージ内か判定する。
 *
 * bare 名の書換えだけでは逃げられないよう、相対参照の解決先も確認する。
 *
 * @param fromFile - 参照元の実パス。
 * @param specifier - 検査する specifier。
 * @returns 解決先が `packages/bridge-plugin-*` 配下なら真。
 */
function resolvesToBridgePluginPackage(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFile), specifier);
  return resolved.includes("packages/bridge-plugin-");
}

/**
 * 相対参照の解決先がホストソース内か判定する。
 *
 * @param fromFile - 参照元の実パス。
 * @param specifier - 検査する specifier。
 * @returns 解決先が `apps/bridge-gui-main/src` 配下なら真。
 */
function resolvesToHostSource(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFile), specifier);
  return resolved.includes("apps/bridge-gui-main/src");
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

/** GUI の production source の起点。 */
function guiSrcDir(): string {
  return packagePath("src");
}

/** GUI の composition root の2件（具象参照の唯一の許容先）。 */
const COMPOSITION_REGISTRATION = "src/composition/bundled-plugins.ts";
const COMPOSITION_ASSETS = "src/composition/bundled-plugin-assets.ts";

test("GUIのproduction sourceで具象プラグインをimportしてよいのはcomposition rootの2件だけ", () => {
  // build script・テストは別の明示対象であり、ここでは production source
  // （`src/` 配下の再帰列挙）だけを検査する。
  const sources = listProductionSources(guiSrcDir(), [...SOURCE_EXTENSIONS]);
  expect(sources.length).toBeGreaterThan(0);
  const allowed = new Set([packagePath(COMPOSITION_REGISTRATION), packagePath(COMPOSITION_ASSETS)]);
  for (const absolute of sources) {
    const source = readSource(absolute);
    const specifiers = extractSpecifiers(source);
    // 旧配置（`src/plugin-ui/`）への参照を残さない。削除済み配置への
    // 参照は build 時に壊れるだけでなく、所有境界の後戻りである。
    // この検査が無いと旧配置の復活を見逃す。
    for (const specifier of specifiers) {
      expect(
        specifier.includes("plugin-ui/"),
        `旧配置の参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
    const concrete = specifiers.filter(
      (specifier) =>
        isBridgePluginSpecifier(specifier) || resolvesToBridgePluginPackage(absolute, specifier),
    );
    if (concrete.length === 0) continue;
    expect(
      allowed.has(absolute),
      `具象参照の許容外である: ${absolute} <- ${concrete.join(", ")}`,
    ).toBe(true);
  }
  // 許容パターンの存在自体を固定する（検査の空洞化防止である）。
  const registrationSpecifiers = extractSpecifiers(
    readSource(packagePath(COMPOSITION_REGISTRATION)),
  );
  expect(registrationSpecifiers.some((specifier) => specifier === "bridge-plugin-text/gui")).toBe(
    true,
  );
  expect(
    registrationSpecifiers.some((specifier) => specifier === "bridge-plugin-diagnostic/gui"),
  ).toBe(true);
  // 登録口は `./gui` だけを使い、他 entry への迂回を持たない。
  for (const specifier of registrationSpecifiers.filter((s) => isBridgePluginSpecifier(s))) {
    expect(
      specifier === "bridge-plugin-text/gui" || specifier === "bridge-plugin-diagnostic/gui",
      `登録口の参照先が ./gui ではない: ${specifier}`,
    ).toBe(true);
  }
  const assetsSpecifiers = extractSpecifiers(readSource(packagePath(COMPOSITION_ASSETS)));
  expect(assetsSpecifiers.some((specifier) => specifier === "bridge-plugin-text/assets")).toBe(
    true,
  );
  expect(
    assetsSpecifiers.some((specifier) => specifier === "bridge-plugin-diagnostic/assets"),
  ).toBe(true);
  for (const specifier of assetsSpecifiers.filter((s) => isBridgePluginSpecifier(s))) {
    expect(
      specifier === "bridge-plugin-text/assets" || specifier === "bridge-plugin-diagnostic/assets",
      `資産参照先が ./assets ではない: ${specifier}`,
    ).toBe(true);
  }
});

test("汎用ホストとSDKと共有契約とcoreは具象パッケージを参照しない", () => {
  const genericHostSources = listProductionSources(packagePath("src/main"), [...SOURCE_EXTENSIONS]);
  expect(genericHostSources.length).toBeGreaterThan(0);
  const sdkSources = listProductionSources(packagesPath("bridge-gui-plugin-sdk/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  expect(sdkSources.length).toBeGreaterThan(0);
  const contractSources = listProductionSources(packagesPath("bridge-gui-contract/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  expect(contractSources.length).toBeGreaterThan(0);
  const coreSources = listProductionSources(packagesPath("bridge-app-core/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  expect(coreSources.length).toBeGreaterThan(0);
  for (const absolute of [
    ...genericHostSources,
    ...sdkSources,
    ...contractSources,
    ...coreSources,
  ]) {
    const source = readSource(absolute);
    for (const specifier of extractSpecifiers(source)) {
      expect(
        isBridgePluginSpecifier(specifier),
        `具象パッケージの参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        resolvesToBridgePluginPackage(absolute, specifier),
        `具象パッケージへの相対参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
  }
});

test("汎用ホストとSDKは基盤の具象entryを参照せずcoreのみを使う", () => {
  const genericHostSources = listProductionSources(packagePath("src/main"), [...SOURCE_EXTENSIONS]);
  const sdkSources = listProductionSources(packagesPath("bridge-gui-plugin-sdk/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  for (const absolute of [...genericHostSources, ...sdkSources]) {
    const source = readSource(absolute);
    for (const specifier of extractSpecifiers(source)) {
      expect(
        isConcreteAppCoreEntry(specifier),
        `基盤の具象 entry の参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
    expect(importsConcreteAppCoreName(source), `具象名を基盤から引いている: ${absolute}`).toBe(
      false,
    );
  }
});

test("coreに具象公開と逆依存を残さない", () => {
  // root・core の export 先に具象を載せない。
  const coreEntrySources = [
    packagesPath("bridge-app-core/src/index.ts"),
    packagesPath("bridge-app-core/src/core.ts"),
  ];
  for (const absolute of coreEntrySources) {
    const source = readSource(absolute);
    for (const specifier of extractSpecifiers(source)) {
      expect(
        isBridgePluginSpecifier(specifier),
        `core の公開先に具象がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        isConcreteAppCoreEntry(specifier) && specifier !== "bridge-app-core/core",
        `core の公開先に具象 entry がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
    // 具象名の再 export が無いこと。コメント中の言及は対象外とし、
    // export 文だけを検査する（迂回の見逃し防止である）。
    expect(
      /export\s+[^;]*\b(?:textPlugin|diagnosticPlugin|TEXT_PLUGIN_ID|DIAGNOSTIC_PLUGIN_ID)\b/.test(
        source,
      ),
      `core の公開先に具象名の再 export がある: ${absolute}`,
    ).toBe(false);
  }
  // package dependencies に具象を載せない（逆依存の防止である）。
  // `devDependencies` 経由の持込みも build 順序の循環を招くため、
  // `peer`・`optional` と併せて走査する。この検査が無いと
  // test 用依存としての逆依存を見逃す。
  const packageJson = JSON.parse(readSource(packagesPath("bridge-app-core/package.json"))) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const [field, table] of Object.entries({
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
    peerDependencies: packageJson.peerDependencies,
    optionalDependencies: packageJson.optionalDependencies,
  } as const)) {
    for (const name of Object.keys(table ?? {})) {
      expect(isBridgePluginSpecifier(name), `core の ${field} に具象がある: ${name}`).toBe(false);
    }
  }
});

test("プラグインはホストソースとcompositionと他パッケージの内部ソースを参照しない", () => {
  for (const kind of ["text", "diagnostic"] as const) {
    const pluginDir = packagesPath(`bridge-plugin-${kind}`);
    const sources = listProductionSources(pluginDir, [...SOURCE_EXTENSIONS]);
    expect(sources.length).toBeGreaterThan(0);
    for (const absolute of sources) {
      // 子画面の view bundle は対象外ではない（同じ境界で検査する）。
      const source = readSource(absolute);
      for (const specifier of extractSpecifiers(source)) {
        expect(
          specifier.includes("apps/bridge-gui-main/src"),
          `ホストソースの参照がある: ${absolute} <- ${specifier}`,
        ).toBe(false);
        expect(
          resolvesToHostSource(absolute, specifier),
          `ホストソースへの相対参照がある: ${absolute} <- ${specifier}`,
        ).toBe(false);
        expect(
          specifier.includes("composition/"),
          `composition の参照がある: ${absolute} <- ${specifier}`,
        ).toBe(false);
        // 自パッケージ内の相対 import は許可する。外への相対参照は禁じる。
        if (specifier.startsWith(".")) {
          const resolved = resolve(dirname(absolute), specifier);
          expect(
            resolved.startsWith(pluginDir),
            `自パッケージ外への相対参照がある: ${absolute} <- ${specifier}`,
          ).toBe(true);
        }
        // 他パッケージの参照は公開 entry 越しだけを許す。
        // `/src/`・`/dist/`・`.ts` 直参照は公開面の迂回であり禁じる。
        // この検査が無いと build 済み宣言を素通りする内部持込みを見逃す。
        if (isBridgePluginSpecifier(specifier)) {
          expect(
            isPublicPluginEntry(specifier),
            `公開 entry 越しでない参照がある: ${absolute} <- ${specifier}`,
          ).toBe(true);
        }
      }
    }
  }
});

test("汎用ホストはcompositionを直接参照しない（起動entryを除く）", () => {
  // 明示配線の注入元である起動 entry `src/main/index.ts` だけが
  // `src/composition/` を import してよい。再帰列挙で将来の追加を見逃さない。
  const genericHostSources = listProductionSources(packagePath("src/main"), [...SOURCE_EXTENSIONS]);
  for (const absolute of genericHostSources) {
    if (absolute === packagePath("src/main/index.ts")) continue;
    const specifiers = extractSpecifiers(readSource(absolute));
    for (const specifier of specifiers) {
      // 末尾 `/` を除去してから判定する。`../composition`（trailing slash
      // なしのディレクトリ import）を取りこぼさないためである。
      // この正規化が無いと slash の有無による迂回を見逃す。
      const stripped = specifier.replace(/\/+$/, "");
      const hits =
        stripped === "../composition" ||
        stripped.endsWith("/composition") ||
        stripped.includes("src/composition");
      expect(hits, `composition の参照がある: ${absolute} <- ${specifier}`).toBe(false);
    }
  }
  // 許容パターンの存在自体を固定する（迂回の見逃し防止である）。
  const entrySpecifiers = extractSpecifiers(readSource(packagePath("src/main/index.ts")));
  expect(entrySpecifiers.some((specifier) => specifier.includes("composition/"))).toBe(true);
});

test("SDKは具象と表示とホストと実行系に依存しない", () => {
  const sdkSources = listProductionSources(packagesPath("bridge-gui-plugin-sdk/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  for (const absolute of sdkSources) {
    const specifiers = extractSpecifiers(readSource(absolute));
    for (const specifier of specifiers) {
      expect(
        isBridgePluginSpecifier(specifier),
        `SDK の具象参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        isConcreteAppCoreEntry(specifier),
        `SDK の基盤具象参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      // ホストソースパス（`../`）への参照を持たない。
      expect(
        specifier.startsWith("../") || specifier.startsWith("..\\"),
        `SDK のホストソースパス参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier.includes("apps/bridge-gui-main/src"),
        `SDK のホストソースパス参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      // Electrobun・Bun・Node 実体を持たない。
      expect(
        specifier === "electrobun" || specifier.startsWith("electrobun/"),
        `SDK の実行系参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier === "bun" || specifier.startsWith("bun:"),
        `SDK の実行系参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier.startsWith("node:"),
        `SDK の実行系参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
  }
});

test("共有契約にプラグイン固有のURL直書きを残さない", () => {
  // `views://plugin-host/*`（空ページ）は
  // 汎用であり許容する。具象種別の scope（例 `views://plugin-text/*`）だけを禁じる。
  // 再帰列挙で将来の追加を見逃さない。
  const forbidden = /views:\/\/plugin-(?!host\/)/;
  const contractSources = listProductionSources(packagesPath("bridge-gui-contract/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  for (const absolute of contractSources) {
    const source = readSource(absolute);
    expect(forbidden.test(source), `契約に具象URLが残っている: ${absolute}`).toBe(false);
  }
});

test("ワールドはtextの通信契約entryのみを利用する", () => {
  // 再帰列挙で将来の追加を見逃さない。root・GUI entry・Electrobun・
  // サーバー実装の引込みを禁じ、通信契約 entry のみを許す。bare 参照と
  // 相対参照の解決先の両方を見る。相対書換えによる迂回を見逃さないためである。
  const worldSources = listProductionSources(appsPath("diagnostic-world/src"), [
    ...SOURCE_EXTENSIONS,
  ]);
  expect(worldSources.length).toBeGreaterThan(0);
  for (const absolute of worldSources) {
    for (const specifier of extractSpecifiers(readSource(absolute))) {
      if (
        isBridgePluginSpecifier(specifier) ||
        resolvesToBridgePluginPackage(absolute, specifier)
      ) {
        expect(
          specifier,
          `ワールドの具象参照は通信契約 entry のみである: ${absolute} <- ${specifier}`,
        ).toBe("bridge-plugin-text/contract");
      }
      expect(
        specifier === "electrobun" || specifier.startsWith("electrobun/"),
        `ワールドの実行系参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
      expect(
        specifier === "bridge-server" || specifier.startsWith("bridge-server/"),
        `ワールドのサーバー実装参照がある: ${absolute} <- ${specifier}`,
      ).toBe(false);
    }
  }
  // 許容パターンの存在自体を固定する（検査の空洞化防止である）。
  const usesContract = worldSources.some((absolute) =>
    extractSpecifiers(readSource(absolute)).includes("bridge-plugin-text/contract"),
  );
  expect(usesContract).toBe(true);
});

test("SDK生成宣言にホストソースパスを残さない", () => {
  // dist が無ければ build 前提として落とす（黙って通さない・skip しない）。
  // この検査が無いと build 前の成功扱いで生成宣言の崩れを見逃す。
  // 型宣言（`.d.mts`）と実行体（`.mjs`）の両方を走査する。実行体側の
  // 解決済み参照にホスト配置が残る崩れを見逃さないためである。
  const dir = packagesPath("bridge-gui-plugin-sdk/dist");
  const entries = readdirSync(dir).filter(
    (name) => name.endsWith(".d.mts") || name.endsWith(".mjs"),
  );
  if (entries.length === 0) {
    throw new Error("SDK の生成宣言が無い。先に build すること。");
  }
  for (const name of entries) {
    const source = readSource(`${dir}/${name}`);
    expect(
      source.includes("apps/bridge-gui-main/src"),
      `生成宣言がホストを参照している: ${name}`,
    ).toBe(false);
    expect(source.includes("../src/main/"), `生成宣言がホストを参照している: ${name}`).toBe(false);
    expect(source.includes("../plugin-ui/"), `生成宣言が具象を参照している: ${name}`).toBe(false);
    for (const specifier of extractSpecifiers(source)) {
      expect(
        isBridgePluginSpecifier(specifier),
        `生成宣言が具象を参照している: ${name} <- ${specifier}`,
      ).toBe(false);
    }
  }
});

test("テスト補助の複写は3者で同一である", () => {
  // `fakes.ts` が core／text／diagnostic に同形複写されている。
  // 新規パッケージを作らず、3者が同一であることを機械的に検査する。
  // この検査が無いと複写の乖離（片方だけの修正）を見逃す。
  const core = readSource(packagesPath("bridge-app-core/tests/fakes.ts"));
  const text = readSource(packagesPath("bridge-plugin-text/tests/fakes.ts"));
  const diagnostic = readSource(packagesPath("bridge-plugin-diagnostic/tests/fakes.ts"));
  expect(text, "text の fakes が core と一致しない").toBe(core);
  expect(diagnostic, "diagnostic の fakes が core と一致しない").toBe(core);
});

test("production sourceにrequireによる迂回を残さない", () => {
  // `require("bridge-plugin-*")` は import 検査だけでは捕捉できない。
  // 現状 production source に `require()`・`createRequire` は無く、
  // 使うこと自体を禁じる。この検査が無いと動的持込みによる迂回を見逃す。
  // stage script（`scripts/`）の正規利用は対象外であり、ここでは
  // production source（`src/` 配下の再帰列挙）だけを検査する。
  const targets = [
    ...listProductionSources(guiSrcDir(), [...SOURCE_EXTENSIONS]),
    ...listProductionSources(packagesPath("bridge-gui-plugin-sdk/src"), [...SOURCE_EXTENSIONS]),
    ...listProductionSources(packagesPath("bridge-gui-contract/src"), [...SOURCE_EXTENSIONS]),
    ...listProductionSources(packagesPath("bridge-app-core/src"), [...SOURCE_EXTENSIONS]),
    ...listProductionSources(packagesPath("bridge-plugin-text/src"), [...SOURCE_EXTENSIONS]),
    ...listProductionSources(packagesPath("bridge-plugin-diagnostic/src"), [...SOURCE_EXTENSIONS]),
    ...listProductionSources(appsPath("diagnostic-world/src"), [...SOURCE_EXTENSIONS]),
  ];
  expect(targets.length).toBeGreaterThan(0);
  for (const absolute of targets) {
    const source = readSource(absolute);
    expect(usesRequire(source), `require の使用がある: ${absolute}`).toBe(false);
  }
});
