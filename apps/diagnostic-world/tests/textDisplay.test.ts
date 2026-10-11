/**
 * テキスト表示板の文言の検証。本文の扱いと折返し・省略方針を確かめる。
 *
 * DOM は使わない。本文は表示専用であり、ここでの整形結果を証拠・ログ用の語と
 * 混ぜないことも確かめる。
 */
import { expect, test } from "vite-plus/test";
import {
  TEXT_DISPLAY_MAX_ROWS,
  TEXT_DISPLAY_WRAP_COLUMNS,
  formatTextLines,
  textStatusLabel,
  wrapTextBody,
} from "../src/text/display.ts";

test("受信状態の文言を返す", () => {
  expect(textStatusLabel(null)).toBe("未受信");
  expect(textStatusLabel("waiting")).toBe("待機中");
  expect(textStatusLabel("received")).toBe("受信済み");
  expect(textStatusLabel("ended")).toBe("中断");
});

test("生成前は未受信だけを表示する", () => {
  expect(formatTextLines(null)).toEqual(["テキスト 未受信"]);
});

test("待機中は受信なしを表示する", () => {
  expect(formatTextLines({ status: "waiting", text: null, id: null })).toEqual([
    "テキスト 待機中（受信なし）",
  ]);
});

test("受信済みの本文をそのまま載せる", () => {
  const lines = formatTextLines({ status: "received", text: "こんにちは", id: "a1" });
  expect(lines[0]).toContain("受信済み");
  expect(lines).toContain("こんにちは");
  // 相関識別子は表示行に載せない。
  expect(lines.join("\n")).not.toContain("a1");
});

test("改行で分割して表示する", () => {
  const lines = formatTextLines({ status: "received", text: "一行目\n二行目", id: "a1" });
  expect(lines).toContain("一行目");
  expect(lines).toContain("二行目");
});

test(`長い行を${TEXT_DISPLAY_WRAP_COLUMNS}字ごとに折り返す`, () => {
  const body = "あ".repeat(TEXT_DISPLAY_WRAP_COLUMNS + 4);
  const rows = wrapTextBody(body);
  expect(rows).toHaveLength(2);
  expect(Array.from(rows[0]).length).toBe(TEXT_DISPLAY_WRAP_COLUMNS);
  expect(Array.from(rows[1]).length).toBe(4);
});

test(`最大${TEXT_DISPLAY_MAX_ROWS}行を超える分は省略記号で省略する`, () => {
  const body = Array.from({ length: TEXT_DISPLAY_MAX_ROWS + 3 }, (_, index) => `行${index}`).join(
    "\n",
  );
  const lines = formatTextLines({ status: "received", text: body, id: "a1" });
  // 先頭行は見出しのため、全体は上限＋1行になる。
  expect(lines.length).toBe(TEXT_DISPLAY_MAX_ROWS + 1);
  expect(lines[lines.length - 1]?.endsWith("…")).toBe(true);
});

test("中断時は直近表示を残す旨を示す", () => {
  const lines = formatTextLines({ status: "ended", text: "残す本文", id: "a1" });
  expect(lines[0]).toContain("中断");
  expect(lines).toContain("残す本文");
});

test("中断前に未受信なら本文なしで中断だけを示す", () => {
  expect(formatTextLines({ status: "ended", text: null, id: null })).toEqual([
    "テキスト 中断（直近表示を残す）",
  ]);
});

test("本文を解釈せずそのまま載せる", () => {
  // HTML・Markdown として解釈せず、プレーンテキストのまま載せる。
  const lines = formatTextLines({ status: "received", text: "<b>太字</b> # 見出し", id: "a1" });
  expect(lines).toContain("<b>太字</b> # 見出し");
});

test("表示行に証拠・ログ用の語を混ぜない", () => {
  const lines = formatTextLines({ status: "received", text: "本文", id: "a1" });
  const text = lines.join("\n");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("payload");
  expect(text).not.toContain("password");
});

test("絵文字を分割せずに折り返す", () => {
  const body = `😀`.repeat(TEXT_DISPLAY_WRAP_COLUMNS);
  const rows = wrapTextBody(`${body}あ`);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toBe(body);
  expect(rows[1]).toBe("あ");
});
