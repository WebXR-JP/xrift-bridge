import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun";

/**
 * mainview-ng（Angular スパイク）の事前生成物の有無。
 *
 * 生成物が無い既定（vanilla）経路では `copy` に載せず、Hutch の必須複写を
 * 欠落させない（`CopySourceMissing` の回帰防止）。生成は opt-in
 * （`gui:run:ng` 等で `ng:build:*` を先行）である。Bun が build 時にこの
 * config を評価するため、判定は config 基準の絶対配置で行い作業ディレクトリに
 * 依存しない。3件が揃う場合だけ載せる（同一 `ng:build:*` の生成単位）。
 */
const ngDistDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "src",
  "mainview-ng",
  "dist",
  "browser",
);
const hasNgDist = (["index.html", "main.js", "styles.css"] as const).every((name) =>
  existsSync(join(ngDistDir, name)),
);

/** ng 生成物がある場合だけ `views/mainview-ng/` へ載せる複写表。 */
const ngCopy: Record<string, string> = hasNgDist
  ? {
      "src/mainview-ng/dist/browser/index.html": "views/mainview-ng/index.html",
      "src/mainview-ng/dist/browser/main.js": "views/mainview-ng/main.js",
      "src/mainview-ng/dist/browser/styles.css": "views/mainview-ng/styles.css",
    }
  : {};

export default {
  app: {
    name: "XRift Bridge",
    identifier: "net.xrift.bridge-gui",
    version: "0.0.1",
  },
  build: {
    // Bun main＋単一 native Webview の構成で試す。Cottontail 0.7.1 では
    // Webview→main の RPC request が届かない不成立があり、Bun main へ切り替える。
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
      // ADR: mainview-ng の UI 実体は Angular CLI の事前生成物であり、
      // Hutch の view バンドル対象ではない。entrypoint は Hutch が要求する
      // 最小スタブ（`src/mainview-ng/stub.ts`）とし、実体は `copy` で載せる。
      // 生成は opt-in（`gui:run:ng` 等で `ng:build:*` を先行）であり、
      // 再帰 build（型検査のみ）・Vite には混ぜない。
      "mainview-ng": {
        entrypoint: "src/mainview-ng/stub.ts",
      },
      "plugin-spike": {
        entrypoint: "src/plugin-spike/index.ts",
      },
      "plugin-text": {
        entrypoint: "src/plugin-ui/text/index.ts",
      },
      "plugin-diagnostic": {
        entrypoint: "src/plugin-ui/diagnostic/index.ts",
      },
    },
    // UI バンドルは Hutch の build.views＋HTML/CSS コピーで足りる。Vite は増やさない。
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      // ADR: mainview-ng（Angular スパイク）の実体は事前生成物である。
      // `ng:build:*`（`outputHashing: none` の固定名）で作った `dist/browser/` を載せる。
      // 生成物が無い既定経路では載せない（`hasNgDist` の判定。有無は上記）。
      ...ngCopy,
      "src/plugin-spike/index.html": "views/plugin-spike/index.html",
      "src/plugin-spike/index.css": "views/plugin-spike/index.css",
      "src/plugin-host/blank.html": "views/plugin-host/blank.html",
      "src/plugin-ui/text/index.html": "views/plugin-text/index.html",
      "src/plugin-ui/text/index.css": "views/plugin-text/index.css",
      "src/plugin-ui/diagnostic/index.html": "views/plugin-diagnostic/index.html",
      "src/plugin-ui/diagnostic/index.css": "views/plugin-diagnostic/index.css",
    },
    // CEF・トレイ・更新配信は追加しない。
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
  runtime: {
    // ウィンドウを閉じたらプロセスを終了する。段2で bridge-server の
    // 後始末を main プロセスに集約するまでの暫定の終了規約である。
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
