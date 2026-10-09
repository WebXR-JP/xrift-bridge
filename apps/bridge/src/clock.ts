/**
 * 壁時計と単調時計の境界。
 *
 * 期限の実判定には単調時計を使い、壁時計は表示用の絶対時刻に留める。
 * 壁時計の変更（NTP 補正・手動変更）で期限が延びないようにし、試験では
 * 両方を差し替えできる。
 *
 * @packageDocumentation
 */

/**
 * 時刻の取得口。
 *
 * 期限判定は `monotonic`、表示用の絶対時刻は `now` を使う。
 * 実装者は `monotonic` が単調非減少であることを保証すること。
 */
export interface Clock {
  /**
   * 壁時計（UNIX ミリ秒）。表示用の絶対時刻。
   *
   * @returns 現在の壁時計。
   */
  now(): number;
  /**
   * 単調時計（ミリ秒）。期限判定用で原点は問わない。
   *
   * @returns 単調非減少の時刻。
   */
  monotonic(): number;
}

/**
 * 既定の時計。`Date.now` と `performance.now()` を使う。
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  // ADR: `performance.now()` は単調で壁時計の補正を受けない。
  // 未定義の実行系に備えた fallback は置かず、呼び出し側で注入させる。
  monotonic: () => globalThis.performance.now(),
};
