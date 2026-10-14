/**
 * 同梱プラグイン資産の同期検査。
 *
 * 静的 manifest（`bundled-plugin-assets.ts`）・runtime 登録・
 * `electrobun.config.ts`・各パッケージの `./assets` 宣言・companion 契約の
 * 相対 entrypoint 宣言を相互に突き合わせ、解決済み view パス・view 名・
 * 配置先・コピー表のずれを検出する。同じ生成関数を2回呼んだ一致では済ませず、
 * 生成元が異なる観測点（登録表・config 実体・資産宣言・契約定数）で確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRelativeAssetPath } from "bridge-gui-plugin-sdk/assets";
import { buildPluginNavigationRules } from "bridge-gui-contract/plugin-instance";
import {
  BUNDLED_PLUGIN_ASSETS,
  buildBundledPluginCopy,
  buildBundledPluginViews,
  getBundledPluginAsset,
  resolveBundledViewPath,
} from "../src/composition/bundled-plugin-assets.ts";
import { registerBundledPlugins } from "../src/composition/bundled-plugins.ts";
import { GuiBackend } from "../src/main/backend.ts";
import { DIAGNOSTIC_PLUGIN_ASSET } from "bridge-plugin-diagnostic/assets";
import { DIAGNOSTIC_VIEW_ENTRY } from "bridge-plugin-diagnostic/gui-contract";
import { TEXT_PLUGIN_ASSET } from "bridge-plugin-text/assets";
import { TEXT_VIEW_ENTRY } from "bridge-plugin-text/gui-contract";
import electrobunConfig from "../electrobun.config.ts";

const backends: GuiBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

/** package 基準の相対パスを実パスに直す。 */
function packagePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** companion 契約が宣言する相対 entrypoint。manifest と突き合わせる材料である。 */
const DECLARED_ENTRIES: Record<string, { view: string }> = {
  text: { view: TEXT_VIEW_ENTRY },
  diagnostic: { view: DIAGNOSTIC_VIEW_ENTRY },
};

/** 各パッケージの純粋な資産宣言。manifest の導出元である。 */
const PLUGIN_ASSETS = [TEXT_PLUGIN_ASSET, DIAGNOSTIC_PLUGIN_ASSET] as const;

test("runtime 登録集合は静的 manifest 集合と一致する", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  // 登録順も含めて一致させる（管理表示の種別表の順序の正本である）。
  expect(backend.companionRegistry.list().map((companion) => companion.kind)).toEqual(
    BUNDLED_PLUGIN_ASSETS.map((entry) => entry.kind),
  );
});

test("登録済みの解決済み view パスは manifest と一致する", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    expect(backend.companionRegistry.get(entry.kind)?.viewPath).toBe(entry.viewPath);
  }
  // snapshot 配布の規則も登録由来であり、直書きの残余とずれない。
  const viewPaths = backend.companionRegistry.list().map((companion) => companion.viewPath);
  expect(backend.getSnapshot().pluginNavigationRules).toEqual(
    buildPluginNavigationRules(viewPaths),
  );
});

test("同梱表は各パッケージの純粋な資産宣言から導出する", () => {
  // 資産宣言の対応付けが manifest にそのまま載ることを確かめる。
  // プラグイン内部の TS・HTML・CSS ソースパスを持たないことが
  // この検査の要点であり、旧来欄の復活を見逃さない。
  expect(BUNDLED_PLUGIN_ASSETS.map((entry) => entry.kind)).toEqual(
    PLUGIN_ASSETS.map((asset) => asset.kind),
  );
  for (const asset of PLUGIN_ASSETS) {
    const entry = getBundledPluginAsset(BUNDLED_PLUGIN_ASSETS, asset.kind);
    if (entry === undefined) throw new Error(`同梱表に無い: ${asset.kind}`);
    expect(entry.viewName).toBe(asset.viewName);
    expect(entry.viewDir).toBe(asset.viewDir);
    expect(entry.viewEntry).toBe(asset.viewEntry);
    expect(entry.viewPath).toBe(asset.viewPath);
    // staging 配置と汎用 stub はホスト側の規則であり、種別ごとの分岐を持たない。
    expect(entry.stagedDir).toBe(`src/plugin-view-dist/${asset.kind}`);
    expect(entry.stubSource).toBe("src/mainview-stub.ts");
    // 旧来欄（プラグイン内部のソースパス）は持たない。
    expect("sourceDir" in entry).toBe(false);
    expect("scriptSource" in entry).toBe(false);
    expect("htmlSource" in entry).toBe(false);
    expect("cssSource" in entry).toBe(false);
    expect("scriptEntry" in entry).toBe(false);
    expect("styleEntry" in entry).toBe(false);
  }
  // 同梱表の源にプラグイン内部のソースパス文字列を残さない。
  const manifestSource = readFileSync(
    packagePath("src/composition/bundled-plugin-assets.ts"),
    "utf8",
  );
  expect(manifestSource.includes("plugin-ui/")).toBe(false);
  expect(manifestSource.includes("src/view/")).toBe(false);
});

test("companion 契約の相対 entrypoint 宣言は manifest と一致する", () => {
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    const declared = DECLARED_ENTRIES[entry.kind];
    if (declared === undefined) throw new Error(`宣言が無い: ${entry.kind}`);
    expect(declared.view).toBe(entry.viewEntry);
    // 純粋解決も同じ解決済みパスに届く（契約定数→manifest の経路である）。
    expect(resolveBundledViewPath(BUNDLED_PLUGIN_ASSETS, entry.kind, declared.view)).toBe(
      entry.viewPath,
    );
  }
});

test("相対 entrypoint は資産ルート外へ出ない", () => {
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    expect(isRelativeAssetPath(entry.viewEntry)).toBe(true);
    // URL・断片・query・wildcard を entrypoint に受けない。
    expect(entry.viewEntry).not.toContain("://");
    expect(entry.viewEntry).not.toContain("#");
    expect(entry.viewEntry).not.toContain("?");
    expect(entry.viewEntry).not.toContain("*");
    expect(entry.viewPath).toBe(`views://${entry.viewName}/${entry.viewEntry}`);
  }
  // 未登録種別の解決は拒否し、黙って配置を作らない。
  expect(getBundledPluginAsset(BUNDLED_PLUGIN_ASSETS, "ghost")).toBeUndefined();
  expect(() => resolveBundledViewPath(BUNDLED_PLUGIN_ASSETS, "ghost", "index.html")).toThrowError(
    RangeError,
  );
  expect(() => resolveBundledViewPath(BUNDLED_PLUGIN_ASSETS, "text", "other.html")).toThrowError(
    RangeError,
  );
});

test("全 view は汎用 stub を entrypoint とし config と一致する", () => {
  // ADR: `as` を使う理由は、共有の config 型が `views`・`copy` を任意・開放形で
  // 表すためである。根拠は、この config リテラルが両表を必ず定義することである。
  const views = electrobunConfig.build.views as Record<string, { entrypoint: string }>;
  const generated = buildBundledPluginViews(BUNDLED_PLUGIN_ASSETS);
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    // 汎用 stub を entrypoint とし、完成資産は `copy` が載せる。
    expect(generated[entry.viewName]).toEqual({ entrypoint: entry.stubSource });
    expect(views[entry.viewName]).toEqual({ entrypoint: entry.stubSource });
    expect(existsSync(packagePath(entry.stubSource))).toBe(true);
  }
  // 汎用 stub は管理画面と共有する（stub の分岐を作らない）。
  expect(views["mainview"]).toEqual({ entrypoint: "src/mainview-stub.ts" });
});

test("staged ディレクトリの copy 表は config と一致する", () => {
  // ADR: `as` を使う理由は上記と同様であり、共有の config 型が `copy` を
  // 任意・開放形で表すためである。根拠は、この config リテラルが表を必ず
  // 定義することである。
  const copy = electrobunConfig.build.copy as Record<string, string>;
  const generated = buildBundledPluginCopy(BUNDLED_PLUGIN_ASSETS);
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    // staged ディレクトリごと配置先へ載せる（mainview の写しと同じ載せ方）。
    expect(generated[entry.stagedDir]).toBe(entry.viewDir);
    expect(copy[entry.stagedDir]).toBe(entry.viewDir);
  }
});

test("view 名と配置先は重複せずホスト資産と衝突しない", () => {
  // ADR: `as` を使う理由は上記と同様であり、共有の config 型が両表を
  // 任意・開放形で表すためである。根拠は、この config リテラルが両表を
  // 必ず定義することである。
  const views = electrobunConfig.build.views as Record<string, { entrypoint: string }>;
  const copy = electrobunConfig.build.copy as Record<string, string>;
  const kinds = BUNDLED_PLUGIN_ASSETS.map((entry) => entry.kind);
  const viewNames = BUNDLED_PLUGIN_ASSETS.map((entry) => entry.viewName);
  const viewPaths = BUNDLED_PLUGIN_ASSETS.map((entry) => entry.viewPath);
  const targets = BUNDLED_PLUGIN_ASSETS.map((entry) => entry.viewDir);
  // manifest 内部の重複は無い。
  expect(new Set(kinds).size).toBe(kinds.length);
  expect(new Set(viewNames).size).toBe(viewNames.length);
  expect(new Set(viewPaths).size).toBe(viewPaths.length);
  expect(new Set(targets).size).toBe(targets.length);
  // ホスト資産（mainview・plugin-host）と衝突しない。
  const hostViewNames = ["mainview"];
  for (const viewName of viewNames) {
    expect(hostViewNames).not.toContain(viewName);
  }
  const hostTargets = ["views/plugin-host/blank.html"];
  for (const target of targets) {
    expect(hostTargets).not.toContain(target);
    expect(target.startsWith("views/mainview")).toBe(false);
  }
  // config 実体にもホスト資産が残っている（別扱いの維持の確認である）。
  // 段0検証用の子画面は同梱しない。
  expect(views["mainview"]).toBeDefined();
  expect(views["plugin-spike"]).toBeUndefined();
  expect(copy["src/plugin-spike/index.html"]).toBeUndefined();
  expect(copy["src/plugin-spike/index.css"]).toBeUndefined();
  expect(copy["src/plugin-host/blank.html"]).toBe("views/plugin-host/blank.html");
  // 旧来の1件載せは残さない（二重載せの防止である）。
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    expect(copy[`${entry.stagedDir}/index.html`]).toBeUndefined();
  }
});

test("staged 配置先は他種別の配置先・ホスト資産を包含しない", () => {
  // staged 方式の取違え（配置先の包含関係）を検出する。二重載せは子画面の
  // 二重解決を招くため、切替えの完全性をここで固定する。
  const targets = BUNDLED_PLUGIN_ASSETS.map((entry) => entry.viewDir);
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    for (const target of targets) {
      if (target === entry.viewDir) continue;
      expect(target.startsWith(`${entry.viewDir}/`)).toBe(false);
      expect(entry.viewDir.startsWith(`${target}/`)).toBe(false);
    }
    expect(entry.viewDir.startsWith("views/mainview")).toBe(false);
  }
});
