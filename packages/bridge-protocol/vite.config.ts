import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // main（型・検証）と transport（共通輸送）の 2 entry。
    // 出力は package.json の exports に対応する。
    entry: ["src/index.ts", "src/transport/index.ts"],
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
