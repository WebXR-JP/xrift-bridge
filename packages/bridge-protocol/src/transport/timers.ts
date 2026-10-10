/**
 * 差し替え可能なタイマー。
 *
 * keepalive・Connection の終了監視など、時間を進める必要がある処理は
 * 直接 `setTimeout` を呼ばず、この層を経由する。テストでは時間を手で
 * 進める fake 実装を注入し、決定的に検証する。
 *
 * @packageDocumentation
 */

/**
 * タイマーの発行と解除の最小操作。
 *
 * 戻り値は不透明な取っ手であり、発行した実装の `clearTimeout` に
 * そのまま渡すことだけを約束する。取っ手の中身を読まないこと。
 */
export interface TimerScheduler {
  /**
   * 遅延後に処理を一度だけ呼ぶ。
   *
   * @param handler - 遅延後に呼ぶ処理。
   * @param delayMs - 遅延（ミリ秒）。0 以上であること。
   * @returns 解除に使う取っ手。
   */
  setTimeout(handler: () => void, delayMs: number): unknown;
  /**
   * 未発火のタイマーを解除する。
   *
   * @param handle - `setTimeout` が返した取っ手。
   */
  clearTimeout(handle: unknown): void;
}

/** 実行環境のタイマーを使う既定実装。 */
export const defaultTimerScheduler: TimerScheduler = {
  setTimeout(handler: () => void, delayMs: number): unknown {
    return setTimeout(handler, delayMs);
  },
  clearTimeout(handle: unknown): void {
    // ADR: `as` を使う理由は、取っ手の型を scheduler ごとに変えるため
    // `TimerScheduler` では不透明（`unknown`）にしているが、この実装が
    // 発行した値は環境の `setTimeout` の戻り値に限ることが、同一実装内で
    // 閉じるため成立する。外部が作った値を渡した場合は契約違反である。
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
