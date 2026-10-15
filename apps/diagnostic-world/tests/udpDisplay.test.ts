/**
 * UDP表示板の文言の検証。統計・送信元・長さ・先頭hexの扱いを確かめる。
 *
 * DOM は使わない。表示行を証拠・ログ用の語と混ぜないことも確かめる。
 * 試験データは固定値とし、実利用の payload は残さない。
 */
import { expect, test } from "vite-plus/test";
import { formatUdpLines, formatUdpStats, udpStatusLabel } from "../src/udp/display.ts";
import { UDP_PREVIEW_BYTES, type UdpSnapshot } from "../src/udp/receiver.ts";

/** 固定の受信済み写しを作る。 */
function received(): UdpSnapshot {
  return {
    status: "received",
    receivedCount: 3,
    receivedBytes: 128,
    invalidCount: 1,
    source: { address: "127.0.0.1", port: 5123 },
    byteLength: 4,
    previewHex: "0102abff",
  };
}

test("受信状態の文言を返す", () => {
  expect(udpStatusLabel(null)).toBe("未受信");
  expect(udpStatusLabel("waiting")).toBe("待機中");
  expect(udpStatusLabel("received")).toBe("受信済み");
  expect(udpStatusLabel("ended")).toBe("中断");
});

test("生成前は未受信だけを表示する", () => {
  expect(formatUdpLines(null)).toEqual(["UDP 未受信"]);
});

test("待機中は受信なしを表示する", () => {
  expect(
    formatUdpLines({
      status: "waiting",
      receivedCount: 0,
      receivedBytes: 0,
      invalidCount: 0,
      source: null,
      byteLength: null,
      previewHex: null,
    }),
  ).toEqual(["UDP 待機中（受信なし）"]);
});

test("待機中でも不正があれば統計を載せる", () => {
  const lines = formatUdpLines({
    status: "waiting",
    receivedCount: 0,
    receivedBytes: 0,
    invalidCount: 2,
    source: null,
    byteLength: null,
    previewHex: null,
  });
  expect(lines[0]).toContain("待機中");
  expect(lines.join("\n")).toContain("不正 2件");
});

test("受信済みは統計・送信元・長さ・先頭hexを載せる", () => {
  const lines = formatUdpLines(received());
  expect(lines[0]).toContain("受信済み");
  expect(lines.join("\n")).toContain("受信 3件 128B");
  expect(lines.join("\n")).toContain("不正 1件");
  expect(lines).toContain("送信元 127.0.0.1:5123");
  expect(lines).toContain("直近 4B 0102abff");
});

test("先頭プレビューは32バイト分まで載せる", () => {
  const preview = "7e".repeat(UDP_PREVIEW_BYTES);
  const lines = formatUdpLines({
    ...received(),
    byteLength: UDP_PREVIEW_BYTES + 8,
    previewHex: preview,
  });
  expect(lines).toContain(`直近 ${UDP_PREVIEW_BYTES + 8}B ${preview}`);
});

test("空データグラムは空と明示する", () => {
  const lines = formatUdpLines({
    ...received(),
    receivedBytes: 0,
    byteLength: 0,
    previewHex: "",
  });
  expect(lines).toContain("直近 0B（空）");
});

test("中断時は直近表示を残す旨を示す", () => {
  const lines = formatUdpLines({ ...received(), status: "ended" });
  expect(lines[0]).toContain("中断");
  expect(lines).toContain("送信元 127.0.0.1:5123");
  expect(lines).toContain("直近 4B 0102abff");
});

test("中断前に未受信なら統計だけで直近は載せない", () => {
  const lines = formatUdpLines({
    status: "ended",
    receivedCount: 0,
    receivedBytes: 0,
    invalidCount: 1,
    source: null,
    byteLength: null,
    previewHex: null,
  });
  expect(lines[0]).toContain("中断");
  expect(lines.join("\n")).toContain("不正 1件");
  expect(lines.join("\n")).not.toContain("送信元");
});

test("統計行は件数とバイトと不正を載せる", () => {
  expect(formatUdpStats(received())).toBe("受信 3件 128B / 不正 1件");
});

test("表示行に証拠・ログ用の語を混ぜない", () => {
  const lines = formatUdpLines(received());
  const text = lines.join("\n");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("payload");
  expect(text).not.toContain("password");
});
