import { expect, test } from "vite-plus/test";
import {
  encodeFrameJson,
  FrameDecoder,
  FrameRejectedError,
  SPIKE_FRAME_MAX_BYTES,
} from "../src/framing.ts";

test("値を符号化して少しずつ足すと元の値が戻る", () => {
  const bytes = encodeFrameJson({ あいさつ: "やむっくす", n: 7 });
  const decoder = new FrameDecoder();
  const out: unknown[] = [];
  // 1B 刻みで足し、メッセージ境界のどこで切れても復元できることを確かめる。
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    out.push(...decoder.push(bytes.subarray(offset, offset + 1)));
  }
  expect(out).toEqual([{ あいさつ: "やむっくす", n: 7 }]);
});

test("複数 frame を一度に足すと順に取り出せる", () => {
  const first = encodeFrameJson({ n: 1 });
  const second = encodeFrameJson({ n: 2 });
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first, 0);
  joined.set(second, first.byteLength);
  expect(new FrameDecoder().push(joined)).toEqual([{ n: 1 }, { n: 2 }]);
});

test("本体上限を超える符号化は投入前に拒否する", () => {
  const tooBig = "x".repeat(SPIKE_FRAME_MAX_BYTES + 1);
  expect(() => encodeFrameJson({ tooBig })).toThrow(FrameRejectedError);
});

test("受信長が上限を超えたら本体を確保せず拒否する", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, SPIKE_FRAME_MAX_BYTES + 1, false);
  expect(() => new FrameDecoder().push(header)).toThrow(FrameRejectedError);
});
