/**
 * yamux stream 上の framing（固定4バイト長＋JSON本体）。
 *
 * 設計の方向（protocol 0.3）どおり、受信時は長さを読んだ時点で検査し、
 * 巨大領域を先に確保しない。本体の上限は試作の採用値であり、製品実装時に
 * 見直す前提である。
 *
 * @packageDocumentation
 */

const LENGTH_PREFIX_BYTES = 4;

/** 試作で採用した本体上限（256KiB）。超過は受信・送信とも拒否する。 */
export const SPIKE_FRAME_MAX_BYTES = 256 * 1024;

/** 長さ超過・壊れた framing を表す。対象 Session の異常終了の根拠にする。 */
export class FrameRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameRejectedError";
  }
}

/**
 * JSON 値を framing して送信用バイト列にする。
 *
 * @param value - JSON 化できる値。
 * @param maxBytes - 本体上限。既定は試作の採用値。
 * @returns 長さ前置き付きのバイト列。
 * @throws `FrameRejectedError` — 本体が上限を超える場合。投入前に拒否する。
 */
export function encodeFrameJson(
  value: unknown,
  maxBytes: number = SPIKE_FRAME_MAX_BYTES,
): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > maxBytes) {
    throw new FrameRejectedError(`本体 ${body.byteLength}B が上限 ${maxBytes}B を超えた`);
  }
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, false);
  out.set(body, LENGTH_PREFIX_BYTES);
  return out;
}

/**
 * 受信バイト列から framing を復元する増分デコーダ。
 *
 * yamux stream の `message` 断片を `push` し、完成した JSON 値を取り出す。
 */
export class FrameDecoder {
  private buffered = new Uint8Array(0);
  private readonly maxBytes: number;

  /**
   * @param maxBytes - 本体上限。既定は試作の採用値。
   */
  constructor(maxBytes: number = SPIKE_FRAME_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /**
   * 受信断片を追加し、完成した値を順に返す。
   *
   * @param chunk - stream から届いた断片。
   * @returns 今回完成した JSON 値の一覧。
   * @throws `FrameRejectedError` — 長さが上限を超える場合。不正な JSON の場合。
   * @throws `SyntaxError` — 本体が JSON として壊れている場合。
   */
  push(chunk: Uint8Array): unknown[] {
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered, 0);
    joined.set(chunk, this.buffered.byteLength);
    this.buffered = joined;
    const completed: unknown[] = [];
    while (this.buffered.byteLength >= LENGTH_PREFIX_BYTES) {
      const length = new DataView(this.buffered.buffer, this.buffered.byteOffset).getUint32(
        0,
        false,
      );
      if (length > this.maxBytes) {
        throw new FrameRejectedError(`受信長 ${length}B が上限 ${this.maxBytes}B を超えた`);
      }
      if (this.buffered.byteLength < LENGTH_PREFIX_BYTES + length) return completed;
      const body = this.buffered.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
      completed.push(JSON.parse(new TextDecoder().decode(body)));
      this.buffered = this.buffered.subarray(LENGTH_PREFIX_BYTES + length);
    }
    return completed;
  }
}
