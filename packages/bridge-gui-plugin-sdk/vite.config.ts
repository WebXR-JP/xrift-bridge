import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // 公開 SDK 契約の 5 entry。出力は package.json の exports に対応する。
    entry: [
      "src/index.ts",
      "src/management.ts",
      "src/companion.ts",
      "src/registration.ts",
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
});
