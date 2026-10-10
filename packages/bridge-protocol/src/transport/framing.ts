/**
 * yamux stream 上の framing（固定4バイト長＋UTF-8 JSON 本体）。
 *
 * 受信時は長さを読んだ時点で検査し、本体分の領域を先に確保しない。
 * 巨大な断片が一度に届いても、検査前の複写は上限で抑えられる範囲に限る。
 *
 * @packageDocumentation
 */

/** 長さ前置きのバイト数（unsigned big-endian）。 */
const LENGTH_PREFIX_BYTES = 4;

/** 本体上限（UTF-8 バイト数）。超過は送信・受信とも拒否する。 */
export const FRAME_MAX_BYTES = 65_536;

/** 長さ超過・壊れた framing を表す。受信異常として扱い呼び出し側で切断等を選ぶ。 */
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
 * @param maxBytes - 本体上限（UTF-8 バイト数）。既定は `FRAME_MAX_BYTES`。
 * @returns 長さ前置き付きのバイト列。
 * @throws `FrameRejectedError` — JSON 化できない場合、本体が上限を超える場合。投入前に拒否する。
 */
export function encodeFrameJson(value: unknown, maxBytes: number = FRAME_MAX_BYTES): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new FrameRejectedError(
      `JSON 化できない値を符号化しようとした: ${(cause as Error).message}`,
    );
  }
  // ADR: `JSON.stringify` は `undefined`・関数等で例外ではなく `undefined` を
  // 返すため、戻り値でも判定する。`"undefined"` 文字列化の素通しを防ぐ。
  if (text === undefined) {
    throw new FrameRejectedError("JSON 化できない値を符号化しようとした");
  }
  const body = new TextEncoder().encode(text);
  if (body.byteLength > maxBytes) {
    throw new FrameRejectedError(`本体 ${body.byteLength}B が上限 ${maxBytes}B を超えた`);
  }
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + body.byteLength);
  // ADR: `out.buffer` はプール由来で `byteOffset` が 0 とは限らないため、
  // `DataView` には写像範囲を明示する。先頭への直書きのずれを防ぐ。
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, body.byteLength, false);
  out.set(body, LENGTH_PREFIX_BYTES);
  return out;
}

/**
 * 受信バイト列から framing を復元する増分デコーダ。
 *
 * yamux stream の `message` 断片を `push` し、完成した JSON 値を取り出す。
 * 未完成分だけを保持し、保持量は 1 frame 分（上限＋前置き）を超えない。
 */
export class FrameDecoder {
  private buffered = new Uint8Array(0);
  private readonly maxBytes: number;

  /**
   * @param maxBytes - 本体上限（UTF-8 バイト数）。既定は `FRAME_MAX_BYTES`。
   */
  constructor(maxBytes: number = FRAME_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /**
   * 受信断片を追加し、完成した値を順に返す。
   *
   * 前回残余と今回断片の論理連結を位置で走査し、複写は本体確定時と残余保持
   * 時に限る。どちらも上限＋前置き以内の大きさであり、断片の大きさに依らず
   * 巨大領域を先に確保しない。UTF-8 としての復元は本体が揃ってから行うため、
   * 断片境界がマルチバイト文字の途中でも復元できる。
   *
   * @param chunk - stream から届いた断片。
   * @returns 今回完成した JSON 値の一覧。
   * @throws `FrameRejectedError` — 長さ超過・0-byte 本体・UTF-8 不正・JSON 不正の場合。
   */
  push(chunk: Uint8Array): unknown[] {
    const held = this.buffered;
    const heldLength = held.byteLength;
    const chunkLength = chunk.byteLength;
    let heldOffset = 0;
    let chunkOffset = 0;
    const completed: unknown[] = [];

    const remaining = (): number => heldLength - heldOffset + (chunkLength - chunkOffset);
    const byteAt = (index: number): number => {
      const heldLeft = heldLength - heldOffset;
      if (index < heldLeft) return held[heldOffset + index]!;
      return chunk[chunkOffset + (index - heldLeft)]!;
    };

    while (remaining() >= LENGTH_PREFIX_BYTES) {
      const length =
        byteAt(0)! * 0x100_0000 + byteAt(1)! * 0x1_0000 + byteAt(2)! * 0x100 + byteAt(3)!;
      if (length > this.maxBytes) {
        throw new FrameRejectedError(`受信長 ${length}B が上限 ${this.maxBytes}B を超えた`);
      }
      // ADR: 空本体は `JSON.parse("")` の失敗に委ねず明示で拒否する。
      // 空 frame の黙殺・誤受理を防ぐ。
      if (length === 0) {
        throw new FrameRejectedError("本体 0B の frame を受け取った");
      }
      if (remaining() < LENGTH_PREFIX_BYTES + length) break;
      // 本体だけを上限内の大きさで複写する。
      const body = new Uint8Array(length);
      const heldAvailable = heldLength - heldOffset;
      // 本体は論理位置 4 から始まる。held 側の寄与は前置きを除いた残りである。
      const fromHeld = Math.min(length, Math.max(0, heldAvailable - LENGTH_PREFIX_BYTES));
      if (fromHeld > 0) {
        body.set(
          held.subarray(
            heldOffset + LENGTH_PREFIX_BYTES,
            heldOffset + LENGTH_PREFIX_BYTES + fromHeld,
          ),
          0,
        );
      }
      if (fromHeld < length) {
        // held に収まらなかった前置き分だけ chunk 側の本体開始は後ろにずれる。
        const headerFromChunk = Math.max(0, LENGTH_PREFIX_BYTES - heldAvailable);
        body.set(
          chunk.subarray(
            chunkOffset + headerFromChunk,
            chunkOffset + headerFromChunk + (length - fromHeld),
          ),
          fromHeld,
        );
      }
      completed.push(decodeBody(body));
      const consumed = LENGTH_PREFIX_BYTES + length;
      const heldConsumed = Math.min(consumed, heldAvailable);
      heldOffset += heldConsumed;
      chunkOffset += consumed - heldConsumed;
    }

    // 未完成分だけを複写して保持する。完成 frame を消費した残りは
    // 未完成の 1 frame 未満であり、上限＋前置きを超えない。
    // ADR: `subarray` のまま保持すると巨大な元緩衝を掴み続けるため、
    // 複写して掴みを離す。
    const leftover = remaining();
    if (leftover === 0) {
      this.buffered = new Uint8Array(0);
    } else {
      const next = new Uint8Array(leftover);
      const heldLeft = heldLength - heldOffset;
      if (heldLeft > 0) next.set(held.subarray(heldOffset), 0);
      next.set(chunk.subarray(chunkOffset), heldLeft);
      this.buffered = next;
    }
    return completed;
  }

  /**
   * 輸送の終了を通知する。未完成の断片が残っていれば拒否する。
   *
   * @throws `FrameRejectedError` — 未完成の frame が残る場合（途中 FIN）。
   */
  finish(): void {
    if (this.buffered.byteLength > 0) {
      throw new FrameRejectedError(
        `未完成の frame ${this.buffered.byteLength}B が残ったまま輸送が終わった`,
      );
    }
  }
}

/**
 * 本体バイト列を JSON 値へ復元する。
 *
 * @param body - 揃った本体バイト列。
 * @returns 復元した JSON 値。
 * @throws `FrameRejectedError` — UTF-8 不正・JSON 不正の場合。
 */
function decodeBody(body: Uint8Array): unknown {
  let text: string;
  try {
    // ADR: 既定の置換復元では壊れた UTF-8 が別値に化けるため、
    // 厳密復元で検出する。
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new FrameRejectedError("本体が UTF-8 として壊れている");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FrameRejectedError("本体が JSON として壊れている");
  }
}
