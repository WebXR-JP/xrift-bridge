/**
 * UDP子画面の完成資産（`dist/view`）の受入検査。
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
  // 子画面の固有契約（中継要求・通知と要求名・イベント名）が bundle 内にある。
  expect(bundle.includes("relay")).toBe(true);
  expect(bundle.includes("emitted")).toBe(true);
  expect(bundle.includes("getState")).toBe(true);
  expect(bundle.includes("stateChanged")).toBe(true);
  // 旧中継契約の要求名・通知名は残さない（旧新二系統を残さない）。
  expect(bundle.includes("getUdpState")).toBe(false);
  expect(bundle.includes("startUdp")).toBe(false);
  expect(bundle.includes("stopUdp")).toBe(false);
  expect(bundle.includes("udpStateChanged")).toBe(false);
});

/**
 * 撤去済みの共有口の集合。3 プラグインで同一集合を検査する（同形複写）。
 *
 * 正本は `design/bridge-app.md`「子画面の中継契約と寿命」の撤去リストであり、
 * 共通中継は `CompanionChannelRpc` の `relay` 要求＋`emitted` 通知だけである。
 * 素の `revision`・`send` は検査しない。改訂番号は新しい不透明 DTO の項目として
 * 残り、新しい不透明な要求名（`sendText` 等）や DOM 識別子に `send` が含まれる
 * ため、素の部分一致では誤検知する。`toSnapshot` は共有契約のものを指し、
 * プラグイン側の同名の局所関数は対象外である（子 bundle には含まれない）。
 * `selectNewer` 自体は管理 snapshot 用に残るため、個体別の
 * `selectNewerInstanceSnapshot` だけを検査する。`PLUGIN_INITIAL_FETCH` は旧共有
 * の接頭辞であり、プラグイン固有の新しい不透明名（`TEXT_INITIAL_FETCH_*` 等）
 * とは別物である。
 */
const REMOVED_SHARED_SYMBOLS = [
  "observation",
  "fingerprint",
  "polling",
  "projectView",
  "toSnapshot",
  "readSnapshot",
  "pushMessageName",
  "buildRequestHandlers",
  "markReady",
  "viewReady",
  "InstanceBaseView",
  "selectNewerInstanceSnapshot",
  "PLUGIN_INITIAL_FETCH",
] as const;

test("bundle は撤去済みの共有口を使わない", () => {
  const bundle = readDist("dist/view/index.js");
  for (const symbol of REMOVED_SHARED_SYMBOLS) {
    expect(bundle.includes(symbol), `撤去済みの共有口が残っている: ${symbol}`).toBe(false);
  }
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
  // 本体側の Node 依存（`node:dgram`）を子画面に持ち込まない。
  expect(bundle.includes("node:dgram")).toBe(false);
  expect(bundle.includes("EADDRINUSE")).toBe(false);
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
