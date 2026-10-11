import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // main（プラグイン基盤）と text-contract（ブラウザ安全な契約）の 2 entry。
    // 出力は package.json の exports に対応する。
    entry: ["src/index.ts", "src/text-contract.ts"],
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
