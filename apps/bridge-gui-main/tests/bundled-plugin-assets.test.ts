/**
 * 同梱プラグイン資産の同期検査。
 *
 * 静的 manifest（`bundled-plugin-assets.ts`）・runtime 登録・
 * `electrobun.config.ts`・実ファイル・companion 契約の相対 entrypoint 宣言を
 * 相互に突き合わせ、解決済み view パス・view 名・配置先・コピー表のずれを
 * 検出する。同じ生成関数を2回呼んだ一致では済ませず、生成元が異なる
 * 観測点（登録表・config 実体・実ファイル・契約定数）で確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
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
import {
  DIAGNOSTIC_SCRIPT_ENTRY,
  DIAGNOSTIC_STYLE_ENTRY,
  DIAGNOSTIC_VIEW_ENTRY,
} from "../src/plugin-ui/diagnostic/contract.ts";
import {
  TEXT_SCRIPT_ENTRY,
  TEXT_STYLE_ENTRY,
  TEXT_VIEW_ENTRY,
} from "../src/plugin-ui/text/contract.ts";
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

/** companion 契約が宣言する相対 entrypoint 群。manifest と突き合わせる材料である。 */
const DECLARED_ENTRIES: Record<string, { view: string; script: string; style: string }> = {
  text: { view: TEXT_VIEW_ENTRY, script: TEXT_SCRIPT_ENTRY, style: TEXT_STYLE_ENTRY },
  diagnostic: {
    view: DIAGNOSTIC_VIEW_ENTRY,
    script: DIAGNOSTIC_SCRIPT_ENTRY,
    style: DIAGNOSTIC_STYLE_ENTRY,
  },
};

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

test("companion 契約の相対 entrypoint 宣言は manifest と一致する", () => {
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    const declared = DECLARED_ENTRIES[entry.kind];
    if (declared === undefined) throw new Error(`宣言が無い: ${entry.kind}`);
    expect(declared.view).toBe(entry.viewEntry);
    expect(declared.script).toBe(entry.scriptEntry);
    expect(declared.style).toBe(entry.styleEntry);
    // 純粋解決も同じ解決済みパスに届く（契約定数→manifest の経路である）。
    expect(resolveBundledViewPath(BUNDLED_PLUGIN_ASSETS, entry.kind, declared.view)).toBe(
      entry.viewPath,
    );
  }
});

test("相対 entrypoint は資産ルート外へ出ない", () => {
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    for (const relative of [entry.viewEntry, entry.scriptEntry, entry.styleEntry]) {
      expect(isRelativeAssetPath(relative)).toBe(true);
      // URL・断片・query・wildcard を entrypoint に受けない。
      expect(relative).not.toContain("://");
      expect(relative).not.toContain("#");
      expect(relative).not.toContain("?");
      expect(relative).not.toContain("*");
    }
    // 複写元・配置先は package 基準の相対であり、資産ルート起点と対応する。
    expect(entry.scriptSource).toBe(`${entry.sourceDir}/${entry.scriptEntry}`);
    expect(entry.htmlSource).toBe(`${entry.sourceDir}/${entry.viewEntry}`);
    expect(entry.cssSource).toBe(`${entry.sourceDir}/${entry.styleEntry}`);
    expect(entry.htmlTarget).toBe(`${entry.viewDir}/${entry.viewEntry}`);
    expect(entry.cssTarget).toBe(`${entry.viewDir}/${entry.styleEntry}`);
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

test("各 script entrypoint は config の build.views に載る", () => {
  // ADR: `as` を使う理由は、共有の config 型が `views`・`copy` を任意・開放形で
  // 表すためである。根拠は、この config リテラルが両表を必ず定義することである。
  const views = electrobunConfig.build.views as Record<string, { entrypoint: string }>;
  const generated = buildBundledPluginViews(BUNDLED_PLUGIN_ASSETS);
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    // 純粋関数の出力と config 実体の両方で確かめる（同じ呼び出しの二重確認にしない）。
    expect(generated[entry.viewName]).toEqual({ entrypoint: entry.scriptSource });
    expect(views[entry.viewName]).toEqual({ entrypoint: entry.scriptSource });
    // 実ファイルが無ければ生成忘れであり、落とす（存在時のみコピーはしない）。
    expect(existsSync(packagePath(entry.scriptSource))).toBe(true);
  }
});

test("HTML・CSS のコピー元と先は config と一致し実ファイルがある", () => {
  // ADR: `as` を使う理由は上記と同様であり、共有の config 型が `copy` を
  // 任意・開放形で表すためである。根拠は、この config リテラルが表を必ず
  // 定義することである。
  const copy = electrobunConfig.build.copy as Record<string, string>;
  const generated = buildBundledPluginCopy(BUNDLED_PLUGIN_ASSETS);
  for (const entry of BUNDLED_PLUGIN_ASSETS) {
    expect(generated[entry.htmlSource]).toBe(entry.htmlTarget);
    expect(generated[entry.cssSource]).toBe(entry.cssTarget);
    expect(copy[entry.htmlSource]).toBe(entry.htmlTarget);
    expect(copy[entry.cssSource]).toBe(entry.cssTarget);
    expect(existsSync(packagePath(entry.htmlSource))).toBe(true);
    expect(existsSync(packagePath(entry.cssSource))).toBe(true);
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
  const targets = BUNDLED_PLUGIN_ASSETS.flatMap((entry) => [entry.htmlTarget, entry.cssTarget]);
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
});
