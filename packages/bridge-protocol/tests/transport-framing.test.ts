import { expect, test } from "vite-plus/test";
import {
  FRAME_MAX_BYTES,
  FrameDecoder,
  FrameRejectedError,
  encodeFrameJson,
} from "../src/transport/framing.ts";

test("分割受信してもとの値が戻る", () => {
  const bytes = encodeFrameJson({ あいさつ: "やむっくす", n: 7 });
  const decoder = new FrameDecoder();
  const out: unknown[] = [];
  // 1B 刻みで足し、frame 境界のどこで切れても復元できることを確かめる。
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    out.push(...decoder.push(bytes.subarray(offset, offset + 1)));
  }
  expect(out).toEqual([{ あいさつ: "やむっくす", n: 7 }]);
  decoder.finish();
});

test("複数フレームの連結を順に取り出せる", () => {
  const first = encodeFrameJson({ n: 1 });
  const second = encodeFrameJson({ n: 2 });
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first, 0);
  joined.set(second, first.byteLength);
  expect(new FrameDecoder().push(joined)).toEqual([{ n: 1 }, { n: 2 }]);
});

test("未完成の部分フレームは保持し後続で完成する", () => {
  const bytes = encodeFrameJson({ n: 9 });
  const decoder = new FrameDecoder();
  const half = Math.floor(bytes.byteLength / 2);
  // 前半だけでは完成しない。
  expect(decoder.push(bytes.subarray(0, half))).toEqual([]);
  // 後半で 1 件が完成する。
  expect(decoder.push(bytes.subarray(half))).toEqual([{ n: 9 }]);
  decoder.finish();
});

test("断片境界がマルチバイト文字の途中でも復元できる", () => {
  const bytes = encodeFrameJson({ text: "あいうえお" });
  const decoder = new FrameDecoder();
  const out: unknown[] = [];
  // 3B 刻みは UTF-8 の 3B 文字とずれる刻みであり、文字途中での切断を含む。
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    out.push(...decoder.push(bytes.subarray(offset, Math.min(offset + 3, bytes.byteLength))));
  }
  expect(out).toEqual([{ text: "あいうえお" }]);
});

test("本体上限の境界で 65536 を受理し 65537 を拒否する", () => {
  expect(FRAME_MAX_BYTES).toBe(65_536);
  // JSON 頭 `{"s":"`（6B）と末尾 `"}`（2B）の 8B を差し引く。
  const fitting = "x".repeat(FRAME_MAX_BYTES - 8);
  const fittingBytes = encodeFrameJson({ s: fitting });
  expect(fittingBytes.byteLength).toBe(4 + FRAME_MAX_BYTES);
  expect(new FrameDecoder().push(fittingBytes)).toEqual([{ s: fitting }]);
  // 1B 超過は投入前に拒否する。
  const tooBig = "x".repeat(FRAME_MAX_BYTES - 8 + 1);
  expect(() => encodeFrameJson({ s: tooBig })).toThrow(FrameRejectedError);
});

test("受信長が上限を超えたら本体なしで長さ読取時点で拒否する", () => {
  const header = new Uint8Array(4);
  // ADR: `DataView` には写像範囲を明示する（符号化側と同じ理由）。
  new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(
    0,
    FRAME_MAX_BYTES + 1,
    false,
  );
  // 本体を一切渡さず前置きだけで拒否できる（巨大領域の確保が不要な証拠）。
  expect(() => new FrameDecoder().push(header)).toThrow(FrameRejectedError);
});

test("宣言長が上限超なら後続が短くても長さ違反を先に検出する", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(
    0,
    FRAME_MAX_BYTES + 100,
    false,
  );
  const chunk = new Uint8Array(4 + 10);
  chunk.set(header, 0);
  chunk.set(new TextEncoder().encode("0123456789"), 4);
  expect(() => new FrameDecoder().push(chunk)).toThrow(FrameRejectedError);
});

test("途中 FIN を検出する", () => {
  const bytes = encodeFrameJson({ n: 1 });
  const decoder = new FrameDecoder();
  decoder.push(bytes.subarray(0, 2));
  // 前置き 2B だけ残したまま終われば拒否する。
  expect(() => decoder.finish()).toThrow(FrameRejectedError);
  // 何も残さなければ正常終了する。
  const clean = new FrameDecoder();
  clean.push(bytes);
  clean.finish();
  new FrameDecoder().finish();
});

test("0-byte 本体を拒否する", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(0, 0, false);
  expect(() => new FrameDecoder().push(header)).toThrow(FrameRejectedError);
});

test("UTF-8 不正・JSON 不正を拒否する", () => {
  // 本体が UTF-8 として壊れている（単独継続バイト）。
  const broken = new Uint8Array(4 + 3);
  new DataView(broken.buffer, broken.byteOffset, broken.byteLength).setUint32(0, 3, false);
  broken.set([0xff, 0xfe, 0x80], 4);
  expect(() => new FrameDecoder().push(broken)).toThrow(FrameRejectedError);
  // UTF-8 としては正しいが JSON として壊れている。
  const text = new TextEncoder().encode("{壊れた");
  const notJson = new Uint8Array(4 + text.byteLength);
  new DataView(notJson.buffer, notJson.byteOffset, notJson.byteLength).setUint32(
    0,
    text.byteLength,
    false,
  );
  notJson.set(text, 4);
  expect(() => new FrameDecoder().push(notJson)).toThrow(FrameRejectedError);
});

test("JSON 化できない値は投入前に拒否する", () => {
  expect(() => encodeFrameJson(undefined)).toThrow(FrameRejectedError);
  expect(() => encodeFrameJson(() => {})).toThrow(FrameRejectedError);
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  expect(() => encodeFrameJson(circular)).toThrow(FrameRejectedError);
});
