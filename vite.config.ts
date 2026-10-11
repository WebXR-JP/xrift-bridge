import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
  test: {
    // vitest の defaultExclude に Hutch の生成物ディレクトリを加えたもの。
    // .hutch/devkit 配下には Electrobun SDK の __tests__（bun:test 前提）が
    // 含まれ、workspace 直下の `vp test` の探索に混ざるため除外する。
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      "**/.hutch/**",
      "**/.cottontail-tmp/**",
    ],
  },
});
