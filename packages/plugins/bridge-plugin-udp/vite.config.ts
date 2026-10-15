import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // 本体・通信契約・子画面固有契約・GUI 登録口・純粋な資産宣言の 5 entry。
    // 出力は package.json の exports に対応する。
    // 子画面は `vite.view.config.ts` で別に束ねる（`dist/view`）。
    entry: [
      "src/index.ts",
      "src/contract.ts",
      "src/gui-contract.ts",
      "src/gui.ts",
      "src/assets.ts",
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
  test: {
    // Hutch の生成物（.hutch/devkit 配下の __tests__）を拾わない。
    // 子画面の検証は tests/ のみである（app と同じ理由の複製）。
    include: ["tests/**/*.test.ts"],
  },
});
