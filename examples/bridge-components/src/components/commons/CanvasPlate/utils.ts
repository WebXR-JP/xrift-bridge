/**
 * 文字板の純粋な描画補助。React・R3F に依存しない。
 *
 * @packageDocumentation
 */

/**
 * 行を測幅で収める。長い行は測りながら切り詰める。
 *
 * @param line - 表示する1行。
 * @param maxWidth - 収める幅（ピクセル）。
 * @param measure - 文字列の描画幅（ピクセル）を返す測定関数。
 * @returns 収まる1行。収まる場合は入力をそのまま返す。
 */
export function fitLine(line: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(line) <= maxWidth) return line;
  // ADR: 切り詰め位置は二分探索で求める。文字数と描画幅は比例しないため、
  // 先頭からの切り詰めでは収まる位置を一意に決められない。
  let low = 0;
  let high = line.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${line.slice(0, mid)}…`;
    if (measure(candidate) <= maxWidth) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return `${line.slice(0, Math.max(0, low - 1))}…`;
}
