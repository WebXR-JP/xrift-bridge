/**
 * テキスト表示板の文言組み立ての検証。
 */
import { expect, test } from "vite-plus/test";
import { formatTextLines, textStatusLabel, wrapTextBody } from "../utils.ts";

test("折り返し幅で論理行に割る", () => {
  // 25 文字を 24 字幅で割ると 24 字 + 1 字になる。
  expect(wrapTextBody("abcdefghijklmnopqrstuvwxy")).toEqual(["abcdefghijklmnopqrstuvwx", "y"]);
  expect(wrapTextBody("a\r\nb")).toEqual(["a", "b"]);
  expect(wrapTextBody("a\n\nb")).toEqual(["a", "", "b"]);
});

test("受信状態の表示文言を返す", () => {
  expect(textStatusLabel(null)).toBe("未受信");
  expect(textStatusLabel("waiting")).toBe("待機中");
  expect(textStatusLabel("received")).toBe("受信済み");
  expect(textStatusLabel("ended")).toBe("中断");
});

test("受信手順の生成前と待機中はそれと分かる表示にする", () => {
  expect(formatTextLines(null)).toEqual(["テキスト 未受信"]);
  expect(formatTextLines({ status: "waiting", text: null, id: null })).toEqual([
    "テキスト 待機中（受信なし）",
  ]);
});

test("受信済みは状態行と本文行を返す", () => {
  expect(formatTextLines({ status: "received", text: "a\nb", id: "1" })).toEqual([
    "テキスト 受信済み",
    "a",
    "b",
  ]);
});

test("上限を超える行は最終行の末尾を省略記号に置き換える", () => {
  const text = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
  const lines = formatTextLines({ status: "received", text, id: "1" });
  expect(lines).toHaveLength(1 + 8);
  expect(lines[lines.length - 1]?.endsWith("…")).toBe(true);
});
