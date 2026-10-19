import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // 管理画面の表示 DTO・限定操作・純粋な微少ランタイム・開発接続口の契約・
    // 製品向けローカル業務操作の共有契約の 4 entry。
    // 出力は package.json の exports に対応する。
    entry: [
      "src/management.ts",
      "src/plugin-instance.ts",
      "src/dev-console.ts",
      "src/local-ops.ts",
    ],
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
    },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
});
