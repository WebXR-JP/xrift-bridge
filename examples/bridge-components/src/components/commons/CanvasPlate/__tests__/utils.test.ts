/**
 * 文字板の測幅切り詰めの検証。測定関数を文字数比例の偽物に差し替える。
 */
import { expect, test } from "vite-plus/test";
import { fitLine } from "../utils.ts";

/** 1文字あたり10ピクセルの偽の測定関数。 */
const measure = (text: string): number => text.length * 10;

test("収まる行はそのまま返す", () => {
  expect(fitLine("short", 1000, measure)).toBe("short");
});

test("収まらない行は省略記号つきで切り詰める", () => {
  // 4文字（40px）は収まり、5文字（50px）は収まらない幅で確かめる。
  expect(fitLine("abcdefghij", 45, measure)).toBe("abc…");
});

test("1文字も収まらない幅では省略記号だけを返す", () => {
  expect(fitLine("abc", 5, measure)).toBe("…");
});
