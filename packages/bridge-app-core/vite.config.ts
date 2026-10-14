import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // main（プラグイン基盤）と core（具象プラグインを含まない汎用 entry）の
    // 2 entry。公開内容は同じである。出力は package.json の exports に対応する。
    entry: ["src/index.ts", "src/core.ts"],
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
