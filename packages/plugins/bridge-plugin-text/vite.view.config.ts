/**
 * テキスト子画面の完成資産のビルド設定（ブラウザ用単一バンドル）。
 *
 * Hutch の view バンドル対象ではなく、Vite で事前に束ねる。出力は
 * `dist/view/` の一組（`index.js`・`index.html`・`index.css`。dev/prod 共通で
 * 二重生成しない）に固定する。`index.js` は `electrobun/view` の
 * `Electroview`・RPC 実装と固有契約・共有契約の純粋部を inline し、bare の
 * `electrobun/view` import・app ソース・`.hutch` パスを残さない。
 * `index.html`・`index.css` は `src/view` の複写であり、絶対 URL を要求しない。
 *
 * `electrobun/*` の解決は自前の devkit（`.hutch/devkit`）だけを使う。
 * npm の bootstrap `electrobun`・app の `.hutch` は参照しない。解決表は
 * devkit 付属の `electrobunViteAliases`（外部 Vite 构建の公式口）から作り、
 * 手書きの複製は持たない。
 *
 * @packageDocumentation
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";
import { defineConfig } from "vite-plus";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

/** 自前の devkit の配置。`hutch electrobun prepare` が用意する。 */
const devkitDir = resolve(packageDir, ".hutch/devkit");

/** 完成資産の配置先。app の stage script がここから写す正本である。 */
const viewDistDir = resolve(packageDir, "dist/view");

/**
 * 子画面の殻（`index.html`・`index.css`）を束ね後に写す。
 *
 * Vite の入力は表示スクリプト（`src/view/index.ts`）だけであり、殻は束ね対象では
 * ない。殻の正本は `src/view` であり、出力は逐語複写とする（書換えはしない）。
 * 複写元が無ければ生成忘れであり、黙って通さず落とす。
 */
function copyViewShell(): Plugin {
  return {
    name: "bridge-plugin-text-copy-view-shell",
    closeBundle(): void {
      mkdirSync(viewDistDir, { recursive: true });
      for (const name of ["index.html", "index.css"] as const) {
        copyFileSync(resolve(packageDir, "src/view", name), resolve(viewDistDir, name));
      }
    },
  };
}

/**
 * 束ね器の区画注釈（`//#region <module>`）を落とす。
 *
 * 注釈は実行に無関係であり、区画名に build 機の相対配置（`.hutch/...`・
 * `src/*.ts`）を残す。完成資産に build 機の配置・TS 参照を残さないため、
 * 振る舞いを変えない範囲で注釈行だけを除く。
 */
function stripRegionAnnotations(): Plugin {
  return {
    name: "bridge-plugin-text-strip-region-annotations",
    renderChunk(code: string): string {
      return code.replace(/^\/\/#(?:end)?region.*$/gm, "");
    },
  };
}

export default defineConfig({
  // ADR: 相対 asset base とする。子画面は `views://plugin-text/` 配下で読まれ、
  // 殻の参照（`index.js`・`index.css`）は相対である。絶対 URL は要求しない。
  base: "./",
  resolve: {
    // ADR: `as` を使わず devkit 付属の表をそのまま渡す。理由は、表の
    // `{find: RegExp, replacement: string}` が Vite の別名表と構造で一致し、
    // 解決先の正本が devkit の export 写像であるためである。手書き複製は持たない。
    alias: electrobunViteAliases(devkitDir),
  },
  build: {
    outDir: "dist/view",
    emptyOutDir: true,
    // ADR: 縮小しない。dev/prod 共通の一組とし、読める出力を正本にする。
    // 寸法の最適化は本移行の判断に委ね、スパイクでは行わない。
    minify: false,
    rollupOptions: {
      input: resolve(packageDir, "src/view/index.ts"),
      output: {
        format: "es",
        entryFileNames: "index.js",
        chunkFileNames: "chunk-[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  plugins: [stripRegionAnnotations(), copyViewShell()],
});
