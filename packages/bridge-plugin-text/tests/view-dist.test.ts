/**
 * テキスト子画面の完成資産（`dist/view`）の受入検査。
 *
 * 包装前に崩れた完成資産（RPC 未 inline・外部 import 残り・絶対 URL・
 * build 機配置の漏れ・殻のずれ・一時観測の残存）を検出する。`src` と
 * `dist/view` の対応・bundle の自己完結を確かめ、壊れた資産のまま
 * staging へ進ませない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** package 基準の相対パスを実パスに直す。 */
function packagePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

/** 完成資産を読む。無ければ build 前提として落とす（黙って通さない）。 */
function readDist(relative: string): string {
  const absolute = packagePath(relative);
  if (!existsSync(absolute)) {
    throw new Error(`完成資産が無い。先に build すること: ${relative}`);
  }
  return readFileSync(absolute, "utf8");
}

test("完成資産の3件がそろっている", () => {
  for (const relative of ["dist/view/index.js", "dist/view/index.html", "dist/view/index.css"]) {
    expect(existsSync(packagePath(relative)), `完成資産が無い: ${relative}`).toBe(true);
  }
});

test("殻の出力は正本の逐語複写である", () => {
  for (const name of ["index.html", "index.css"] as const) {
    expect(readDist(`dist/view/${name}`)).toBe(
      readFileSync(packagePath(`src/view/${name}`), "utf8"),
    );
  }
});

test("bundle は Electroview と RPC 実装を inline している", () => {
  const bundle = readDist("dist/view/index.js");
  // Electroview の実行時（host 接続先の読取り）が bundle 内にある。
  expect(bundle.includes("__electrobunWebviewId")).toBe(true);
  expect(bundle.includes("__electrobunHostSocketPort")).toBe(true);
  // 子画面の固有契約（初回取得・状態 push の名前）が bundle 内にある。
  expect(bundle.includes("getTextState")).toBe(true);
  expect(bundle.includes("textStateChanged")).toBe(true);
});

test("bundle に外部 import・app 配置・build 機配置を残さない", () => {
  const bundle = readDist("dist/view/index.js");
  // bare の `electrobun/view` import が残ると子画面が動かない。
  expect(bundle.includes("electrobun/view")).toBe(false);
  expect(bundle.includes('from "electrobun')).toBe(false);
  expect(bundle.includes("from 'electrobun")).toBe(false);
  // app ソース・devkit 配置・TS 参照が残ると完成資産の自己完結が崩れる。
  expect(bundle.includes("apps/bridge-gui-main")).toBe(false);
  expect(bundle.includes(".hutch")).toBe(false);
  expect(bundle.includes("plugin-ui/")).toBe(false);
  expect(bundle.includes(".ts")).toBe(false);
});

test("殻の参照は相対であり絶対 URL を要求しない", () => {
  const html = readDist("dist/view/index.html");
  expect(html.includes('src="index.js"')).toBe(true);
  expect(html.includes('href="index.css"')).toBe(true);
  expect(html.includes('src="/')).toBe(false);
  expect(html.includes('href="/')).toBe(false);
});

test("完成資産に一時観測の標識を残さない", () => {
  // 本移行で削除する一時観測（`[bridge-probe]`）が dist に残ると、
  // 削除のし忘れのまま staging・包装へ進む。この検査が無いと
  // probe script の除去漏れを見逃す。
  for (const relative of ["dist/view/index.js", "dist/view/index.html"]) {
    expect(readDist(relative).includes("bridge-probe"), `${relative} に一時観測が残っている`).toBe(
      false,
    );
  }
  // `src/view` の正本にも残さない（再 build で復活する除去漏れを防ぐ）。
  for (const relative of ["src/view/index.ts", "src/view/index.html"]) {
    const absolute = packagePath(relative);
    expect(
      readFileSync(absolute, "utf8").includes("bridge-probe"),
      `${relative} に一時観測が残っている`,
    ).toBe(false);
  }
});
