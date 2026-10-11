import type { ElectrobunConfig } from "electrobun";

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
    },
    // UI バンドルは Hutch の build.views＋HTML/CSS コピーで足りる。Vite は増やさない。
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
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
