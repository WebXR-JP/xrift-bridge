/**
 * 固定テキスト契約の単体試験。
 *
 * 契約モジュール（型・検証関数・定数）の振る舞いと、ブラウザ安全の条件
 * （サーバー依存の import がないこと・subpath の公開）を確かめる。
 * 契約の検証は実行時の検証であり、型注釈では代替しない。
 *
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  TEXT_MAX_CODE_POINTS,
  TEXT_RESPONSE_TIMEOUT_MS,
  countCodePoints,
  isAckForRequest,
  isCorrelationId,
  isTextShowRequest,
  isTextShownAck,
  validateTextForSend,
} from "../src/contract.ts";

test("正常な表示要求と本文を検証できる", () => {
  // 正常な受信検証が通ることを確かめる。
  expect(isTextShowRequest({ op: "show", id: "表示-1", text: "こんにちは" })).toBe(true);
  expect(validateTextForSend("こんにちは")).toEqual({ ok: true, text: "こんにちは" });
});

test("空の本文は送信前に拒否される", () => {
  // 空文字は送信も受信も受け付けないことを確かめる。
  expect(validateTextForSend("")).toEqual({ ok: false, reason: "empty" });
  expect(isTextShowRequest({ op: "show", id: "表示-1", text: "" })).toBe(false);
});

test("上限ちょうどの本文は通り超過は拒否される", () => {
  // 上限（512 Unicode コードポイント）の境界を確かめる。
  expect(TEXT_MAX_CODE_POINTS).toBe(512);
  const 上限ちょうど = "あ".repeat(TEXT_MAX_CODE_POINTS);
  expect(validateTextForSend(上限ちょうど)).toEqual({ ok: true, text: 上限ちょうど });
  expect(isTextShowRequest({ op: "show", id: "表示-1", text: 上限ちょうど })).toBe(true);
  const 上限超過 = "あ".repeat(TEXT_MAX_CODE_POINTS + 1);
  expect(validateTextForSend(上限超過)).toEqual({ ok: false, reason: "too-long" });
  expect(isTextShowRequest({ op: "show", id: "表示-1", text: 上限超過 })).toBe(false);
});

test("型不一致の本文は拒否される", () => {
  // 文字列以外は送信も受信も受け付けないことを確かめる。
  const 本文以外: unknown[] = [1, null, undefined, [], {}, true];
  for (const 本文 of 本文以外) {
    expect(validateTextForSend(本文).ok).toBe(false);
    expect(isTextShowRequest({ op: "show", id: "表示-1", text: 本文 })).toBe(false);
  }
  expect(validateTextForSend(1)).toEqual({ ok: false, reason: "not-string" });
});

test("改行を含む本文は許可される", () => {
  // 改行が上限計算と検証のどちらでも許されることを確かめる。
  expect(validateTextForSend("一行目\n二行目\r\n三行目")).toEqual({
    ok: true,
    text: "一行目\n二行目\r\n三行目",
  });
  expect(isTextShowRequest({ op: "show", id: "表示-1", text: "一行目\n二行目" })).toBe(true);
});

test("上限はUnicodeコードポイント数で数える", () => {
  // サロゲートペアを UTF-16 単位ではなくコードポイントで数えることを確かめる。
  expect(countCodePoints("😀")).toBe(1);
  const 絵文字上限 = "😀".repeat(TEXT_MAX_CODE_POINTS);
  expect(validateTextForSend(絵文字上限).ok).toBe(true);
  expect(validateTextForSend(`${絵文字上限}あ`).ok).toBe(false);
});

test("識別子照合は一致した反映確認だけを通す", () => {
  // 遅延・重複確認を次の要求に対応させない判定を確かめる。
  expect(isAckForRequest("表示-1", { op: "shown", id: "表示-1" })).toBe(true);
  expect(isAckForRequest("表示-1", { op: "shown", id: "表示-2" })).toBe(false);
  expect(isAckForRequest("表示-1", { op: "shown" })).toBe(false);
  expect(isAckForRequest("表示-1", { op: "show", id: "表示-1", text: "本文" })).toBe(false);
});

test("反映確認の受信検証は形状違いを拒否する", () => {
  // 反映確認（本文なし）の正常・不正形状を確かめる。
  expect(isTextShownAck({ op: "shown", id: "表示-1" })).toBe(true);
  const 不正値: unknown[] = [
    { op: "shown" },
    { op: "shown", id: "" },
    { op: "shown", id: "表示-1", 余分: true },
    { op: "shown", id: "表示-1", text: "本文返送はしない" },
    { op: "show", id: "表示-1" },
    { op: "pong", id: "表示-1" },
    null,
    [],
    "文字列",
  ];
  for (const payload of 不正値) {
    expect(isTextShownAck(payload)).toBe(false);
  }
});

test("表示要求の受信検証は不正形状を拒否する", () => {
  // 識別子・操作名・余分キーの不正を確かめる。
  const 不正値: unknown[] = [
    { op: "show", id: "", text: "本文" },
    { op: "show", text: "本文" },
    { op: "show", id: "表示-1" },
    { op: "show", id: "表示-1", text: "本文", 余分: true },
    { op: "shown", id: "表示-1" },
    { op: "echo", id: "表示-1", value: "本文" },
    null,
    [],
    "文字列",
  ];
  for (const payload of 不正値) {
    expect(isTextShowRequest(payload)).toBe(false);
  }
});

test("相関識別子は非空文字列である", () => {
  // 識別子の判定条件を確かめる。
  expect(isCorrelationId("表示-1")).toBe(true);
  expect(isCorrelationId("")).toBe(false);
  expect(isCorrelationId(1)).toBe(false);
  expect(isCorrelationId(null)).toBe(false);
});

test("応答期限は10秒である", () => {
  // 契約の数値定数を確かめる。
  expect(TEXT_RESPONSE_TIMEOUT_MS).toBe(10_000);
});

test("契約ソースはサーバー依存をimportしない", () => {
  // ブラウザ安全の条件をソース検査で確かめる。
  // 契約は型と純粋関数のみで構成し、`bridge-server` 等を引き込まない。
  const ソース = readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8");
  expect(ソース).not.toMatch(/bridge-server/);
  expect(ソース).not.toMatch(/bridge-protocol/);
  expect(ソース).not.toMatch(/^\s*import\s/m);
});

test("契約subpathが公開され成果物がサーバー依存を持たない", () => {
  // `exports` の subpath 宣言と、ビルド成果物の中身を確かめる。
  // 成果物の検査は root import で `bridge-server` を引き込まない根拠になる。
  const 台帳 = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly exports?: Record<string, string>;
  };
  // ADR: `as` は JSON 境界の読替えであり、後続の存在検査で不正を検出する。
  // `JSON.parse` の `any` をそのまま広げないための主張である。
  const 成果物相対径 = 台帳.exports?.["./contract"];
  expect(typeof 成果物相対径).toBe("string");
  if (typeof 成果物相対径 !== "string") throw new Error("契約 subpath の公開がない。");
  const 成果物 = new URL(`../${成果物相対径}`, import.meta.url);
  expect(existsSync(成果物)).toBe(true);
  const 中身 = readFileSync(成果物, "utf8");
  expect(中身).not.toMatch(/bridge-server/);
  expect(中身).not.toMatch(/bridge-protocol/);
});
