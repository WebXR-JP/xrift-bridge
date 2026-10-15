/**
 * 完成資産の staging の検証。
 *
 * 壊れた資産のまま包装へ進ませないための検査である。欠落・余剰・pin 不一致
 * を包装前（`planStage`）に検出すること、pin 抽出が書式違いに耐えることを
 * 確かめる。負の検査は text／diagnostic／udp の三種別で機能することを確かめ、
 * 片方の種別だけが守られる取違えを防ぐ。正規配置の成功系・staged の観測
 * 残存検査は実配置で確かめ、build 前で完成資産が無い場合は落とす
 * （黙って通さない。空検査での成功扱いを見逃さない）。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  BUNDLED_PLUGIN_ASSETS,
  getBundledPluginAsset,
} from "../src/composition/bundled-plugin-assets.ts";
import {
  EXPECTED_VIEW_FILES,
  STAGED_DIAGNOSTIC_DIR,
  STAGED_TEXT_DIR,
  STAGED_UDP_DIR,
  extractElectrobunPin,
  planAllStages,
  planStage,
  runStage,
  stagedDirFor,
} from "../scripts/stage-bundled-plugins.ts";

/** package 基準の相対パスを実パスに直す。 */
function packagePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** staging 対象の全種別。負の検査を三種別で回す材料である。 */
const STAGED_KINDS = ["text", "diagnostic", "udp"] as const;

/** 検証用の仮配置を作る。pin と完成資産の有無を切替える材料である。 */
function makeFixture(options: {
  pluginPin: string | null;
  appPin: string | null;
  viewFiles: readonly string[];
}): { pluginDir: string; appDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "stage-bundled-plugins-"));
  const pluginDir = join(root, "plugin");
  const appDir = join(root, "app");
  mkdirSync(join(pluginDir, "dist/view"), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  for (const name of options.viewFiles) {
    writeFileSync(join(pluginDir, "dist/view", name), `仮の${name}`);
  }
  const hutchConfig = (pin: string | null): string =>
    pin === null
      ? "export default {};\n"
      : `export default {\n  electrobun: {\n    version: "${pin}",\n  },\n};\n`;
  writeFileSync(join(pluginDir, "hutch.config.ts"), hutchConfig(options.pluginPin));
  writeFileSync(join(appDir, "hutch.config.ts"), hutchConfig(options.appPin));
  return {
    pluginDir,
    appDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Electrobun の pin を hutch.config.ts から抜く", () => {
  const pluginSource = readFileSync(packagePath("hutch.config.ts"), "utf8");
  expect(extractElectrobunPin(pluginSource)).toBe("2.0.2");
  expect(extractElectrobunPin("export default {};\n")).toBeNull();
  expect(extractElectrobunPin("export default {\n  electrobun: {},\n};\n")).toBeNull();
});

test("種別から staging 配置と package 名が決まる", () => {
  // 対象は同梱表から決まり、種別ごとの分岐を持たない。この検査が無いと
  // 新種別の追加時に staging script への分岐追加を見逃す。
  expect(stagedDirFor("text")).toBe(STAGED_TEXT_DIR);
  expect(stagedDirFor("diagnostic")).toBe(STAGED_DIAGNOSTIC_DIR);
  expect(stagedDirFor("udp")).toBe(STAGED_UDP_DIR);
});

test("同梱表の staging 配置は stage script の規則と一致する", () => {
  // `BUNDLED_PLUGIN_ASSETS[].stagedDir` と stage script 側の
  // `stagedDirFor(kind)` が一致することを確かめる。この検査が無いと
  // 片方だけのテンプレ変更（配置先のずれ）を見逃し、包装時に別配置を載せる。
  expect(BUNDLED_PLUGIN_ASSETS.map((entry) => entry.kind)).toEqual([...STAGED_KINDS]);
  for (const kind of STAGED_KINDS) {
    const entry = getBundledPluginAsset(BUNDLED_PLUGIN_ASSETS, kind);
    if (entry === undefined) throw new Error(`同梱表に無い: ${kind}`);
    expect(entry.stagedDir, `staging 配置がずれている: ${kind}`).toBe(stagedDirFor(kind));
  }
});

test("正規配置の staging 計画は三種別で完成資産3件と pin 一致を持つ", async () => {
  // build 前で完成資産が無ければ落とす（黙って通さない・skip しない）。
  // この検査が無いと build 前の空検査で staging 経路の崩れを見逃す。
  for (const kind of STAGED_KINDS) {
    if (
      !existsSync(packagePath(`../../packages/plugins/bridge-plugin-${kind}/dist/view/index.js`))
    ) {
      throw new Error(`完成資産が無い。先に plugin を build すること: ${kind}`);
    }
  }
  const plans = await planAllStages({ appDir: packagePath("") });
  expect(plans.map((plan) => plan.kind)).toEqual([...STAGED_KINDS]);
  for (const plan of plans) {
    expect(plan.files).toEqual([...EXPECTED_VIEW_FILES]);
    expect(plan.electrobunPin).toBe("2.0.2");
    expect(plan.stagedDir).toBe(packagePath(stagedDirFor(plan.kind)));
  }
  // 単一種別の計画も同梱表と一致する（個別指定の経路の確認である）。
  const textPlan = planStage("text", {
    pluginDir: packagePath("../../packages/plugins/bridge-plugin-text"),
    appDir: packagePath(""),
  });
  expect(textPlan.stagedDir).toBe(packagePath(STAGED_TEXT_DIR));
  const diagnosticPlan = planStage("diagnostic", {
    pluginDir: packagePath("../../packages/plugins/bridge-plugin-diagnostic"),
    appDir: packagePath(""),
  });
  expect(diagnosticPlan.stagedDir).toBe(packagePath(STAGED_DIAGNOSTIC_DIR));
});

for (const kind of STAGED_KINDS) {
  test(`完成資産の欠落時は包装前に失敗する（${kind}）`, () => {
    const fixture = makeFixture({ pluginPin: "2.0.2", appPin: "2.0.2", viewFiles: ["index.js"] });
    try {
      expect(() =>
        planStage(kind, { pluginDir: fixture.pluginDir, appDir: fixture.appDir }),
      ).toThrowError(/欠けている/);
    } finally {
      fixture.cleanup();
    }
  });

  test(`完成資産の配置自体が無いときは包装前に失敗する（${kind}）`, () => {
    const fixture = makeFixture({ pluginPin: "2.0.2", appPin: "2.0.2", viewFiles: [] });
    try {
      rmSync(join(fixture.pluginDir, "dist"), { recursive: true, force: true });
      expect(() =>
        planStage(kind, { pluginDir: fixture.pluginDir, appDir: fixture.appDir }),
      ).toThrowError(/完成資産が無い/);
    } finally {
      fixture.cleanup();
    }
  });

  test(`完成資産の余剰時は包装前に失敗する（${kind}）`, () => {
    const fixture = makeFixture({
      pluginPin: "2.0.2",
      appPin: "2.0.2",
      viewFiles: [...EXPECTED_VIEW_FILES, "余剰.js"],
    });
    try {
      expect(() =>
        planStage(kind, { pluginDir: fixture.pluginDir, appDir: fixture.appDir }),
      ).toThrowError(/余剰/);
    } finally {
      fixture.cleanup();
    }
  });

  test(`Electrobun の pin 不一致時は包装前に失敗する（${kind}）`, () => {
    const fixture = makeFixture({
      pluginPin: "9.9.9",
      appPin: "2.0.2",
      viewFiles: [...EXPECTED_VIEW_FILES],
    });
    try {
      expect(() =>
        planStage(kind, { pluginDir: fixture.pluginDir, appDir: fixture.appDir }),
      ).toThrowError(/不一致/);
    } finally {
      fixture.cleanup();
    }
  });

  test(`staging は写し先を作り直して3件を写す（${kind}）`, () => {
    const fixture = makeFixture({
      pluginPin: "2.0.2",
      appPin: "2.0.2",
      viewFiles: [...EXPECTED_VIEW_FILES],
    });
    try {
      const plan = planStage(kind, { pluginDir: fixture.pluginDir, appDir: fixture.appDir });
      // 前回分が残っていても作り直す（古い資産の混入防止である）。
      mkdirSync(plan.stagedDir, { recursive: true });
      writeFileSync(join(plan.stagedDir, "古い.js"), "古い");
      const staged = runStage(plan);
      expect(staged.map((file) => file.name)).toEqual([...EXPECTED_VIEW_FILES]);
      expect(existsSync(join(plan.stagedDir, "古い.js"))).toBe(false);
      for (const file of staged) {
        expect(file.size).toBeGreaterThan(0);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      fixture.cleanup();
    }
  });
}

test("staged の画面資産に一時観測の標識を残さない", () => {
  // 本移行で削除する一時観測（`[bridge-probe]`）が staged に残ると、
  // 削除のし忘れのまま包装へ進む。この検査が無いと probe script の
  // 除去漏れ（再 build での復活を含む）を見逃す。
  // build 前で完成資産が無ければ落とす（黙って通さない・skip しない）。
  for (const kind of STAGED_KINDS) {
    if (!existsSync(packagePath(`src/plugin-view-dist/${kind}/index.js`))) {
      throw new Error(`staged 資産が無い。先に stage すること: ${kind}`);
    }
  }
  for (const kind of STAGED_KINDS) {
    for (const name of EXPECTED_VIEW_FILES) {
      const staged = readFileSync(packagePath(`src/plugin-view-dist/${kind}/${name}`), "utf8");
      expect(
        staged.includes("bridge-probe"),
        `staged に一時観測が残っている: ${kind}/${name}`,
      ).toBe(false);
    }
  }
});
