import type { ElectrobunConfig } from "electrobun";

/**
 * 管理画面（Angular）の事前生成物の配置。
 *
 * 生成の正本は UI パッケージ自身の `dist` であり、dev と prod を別ディレクトリに
 * 分ける（`apps/bridge-gui-ui/dist/dev/browser`・`dist/prod/browser`。混在の罠の
 * 排除）。`gui:run`・`gui:build` が選んだ側を `src/mainview-dist/dev`・`prod` へ
 * 写し、Hutch の `copy` で `views/mainview/` へ載せる。Hutch の `copy` 源は
 * package 内配置に限る（package 外の `../bridge-gui-ui/dist/...` 直接指定は
 * `UnsafeOutputPath` で却下される実測のため、写しを経由する）。
 * `copy` 表の源はそのまま載せる。相対は package 基準で解決される
 * （Hutch の解決であり、起動時の作業ディレクトリに依存しない）。
 *
 * コピー元は環境変数 `BRIDGE_GUI_UI_DIR` で選ぶ。未指定時は prod の写しを既定と
 * する。成果物が無ければ失敗させる（存在時のみコピーはしない。生成忘れの検出の
 * ために落とす）。
 */
const uiSource = process.env.BRIDGE_GUI_UI_DIR?.trim() || "src/mainview-dist/prod";

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
      // ADR: 管理画面の UI 実体は Angular CLI の事前生成物であり、Hutch の
      // view バンドル対象ではない。entrypoint は Hutch が要求する最小スタブ
      // （`src/mainview-stub.ts`）とし、実体は `copy` で `views/mainview/` に載せる。
      mainview: {
        entrypoint: "src/mainview-stub.ts",
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
      // ADR: 管理画面（Angular）の実体は事前生成物の写しである。生成ディレクトリ
      // ごと `views/mainview/` へ載せる（Hutch のディレクトリコピーの実測で
      // 成立を確認。固定名 `index.html`・`main.js`・`styles.css` の
      // `outputHashing: none` 生成を含む。将来 chunks／assets が増えた場合も
      // `gui:run`・`gui:build` の写し経由で同梱される）。
      [uiSource]: "views/mainview",
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
