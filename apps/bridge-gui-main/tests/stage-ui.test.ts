/**
 * 管理画面（Angular）の事前生成物の staging の検証。
 *
 * 壊れた生成物のまま包装へ進ませないための検査である。生成物の欠落・
 * `index.html` の不在を包装前（`stageUi`）に検出すること、前回 staging の
 * 残骸を残さないこと、正規配置が app 基準で決まることを確かめる。
 * 負の検査は dev／prod の両 channel で機能することを確かめ、
 * 片方の channel だけが守られる取違えを防ぐ。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isUiChannel, resolveUiPaths, stageUi, type UiChannel } from "../scripts/stage-ui.ts";

/** package 基準の相対パスを実パスに直す。 */
function packagePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** staging 対象の全 channel。負の検査を両 channel で回す材料である。 */
const STAGED_CHANNELS = ["dev", "prod"] as const satisfies readonly UiChannel[];

/** 検証用の仮の生成物を作る。`index.html` の有無を切替える材料である。 */
function makeFixture(options: { withIndexHtml: boolean }): {
  source: string;
  destination: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "stage-ui-"));
  const source = join(root, "browser");
  const destination = join(root, "mainview-dist", "dev");
  mkdirSync(join(source, "assets"), { recursive: true });
  if (options.withIndexHtml) {
    writeFileSync(join(source, "index.html"), "<html></html>");
  }
  writeFileSync(join(source, "main.js"), "仮のmain.js");
  writeFileSync(join(source, "assets", "logo.svg"), "<svg></svg>");
  return {
    source,
    destination,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("引数の channel 判定は dev と prod だけを通す", () => {
  // 未知・空の channel が包装へ進むと誤った写し先を作る。この検査が無いと
  // 引数書換えの崩れ（typo の黙認など）を見逃す。
  expect(isUiChannel("dev")).toBe(true);
  expect(isUiChannel("prod")).toBe(true);
  expect(isUiChannel("stable")).toBe(false);
  expect(isUiChannel("")).toBe(false);
});

test("正規配置は app 基準で生成物と写し先が決まる", () => {
  // 解決が cwd 依存だと runner の起動場所で写し先がずれる。この検査が無いと
  // 相対 path への書換え（cwd 依存の復活）を見逃す。
  for (const channel of STAGED_CHANNELS) {
    const paths = resolveUiPaths(channel, packagePath(""));
    expect(paths.source).toBe(packagePath(`../bridge-gui-ui/dist/${channel}/browser`));
    expect(paths.destination).toBe(packagePath(`src/mainview-dist/${channel}`));
  }
});

for (const channel of STAGED_CHANNELS) {
  test(`staging は生成物を丸ごと写し、前回分を残さない（${channel}）`, () => {
    const fixture = makeFixture({ withIndexHtml: true });
    try {
      // 前回分が残っていても作り直す（古い生成物の混入防止である）。
      mkdirSync(fixture.destination, { recursive: true });
      writeFileSync(join(fixture.destination, "古い.js"), "古い");
      const result = stageUi(channel, {
        source: fixture.source,
        destination: fixture.destination,
      });
      expect(result.fileCount).toBe(3);
      expect(result.totalBytes).toBeGreaterThan(0);
      expect(existsSync(join(fixture.destination, "古い.js"))).toBe(false);
      expect(existsSync(join(fixture.destination, "index.html"))).toBe(true);
      expect(existsSync(join(fixture.destination, "main.js"))).toBe(true);
      expect(existsSync(join(fixture.destination, "assets", "logo.svg"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test(`生成物の配置自体が無いときは包装前に失敗する（${channel}）`, () => {
    const fixture = makeFixture({ withIndexHtml: true });
    try {
      rmSync(fixture.source, { recursive: true, force: true });
      expect(() =>
        stageUi(channel, { source: fixture.source, destination: fixture.destination }),
      ).toThrowError(/生成物が無い/);
    } finally {
      fixture.cleanup();
    }
  });

  test(`生成物に index.html が無いときは包装前に失敗する（${channel}）`, () => {
    const fixture = makeFixture({ withIndexHtml: false });
    try {
      expect(() =>
        stageUi(channel, { source: fixture.source, destination: fixture.destination }),
      ).toThrowError(/index\.html/);
      expect(existsSync(fixture.destination)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
}
