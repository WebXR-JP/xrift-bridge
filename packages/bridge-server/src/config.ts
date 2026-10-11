/**
 * ブリッジの有限・設定可能な暫定値。
 *
 * 値の正本は下の `DEFAULT_LIMITS` とする。計測用暫定値であり、
 * 合意値・性能保証ではない。計測時の実効設定は証拠に記録する。
 * 検証計画は `docs/verification/bridge-connection.md` を見る。すべての値は
 * `BridgeOptions.limits` で上書きできる。
 *
 * 比較コード方式の上限・レートの設計既定値は
 * `design/bridge-connection.md` の候補節を参照し、形状の正本は
 * `bridge-protocol`（`PAIRING_CODE_LENGTH` 等）に置く。
 *
 * 受付は有効/無効の2状態のトグルであり、時間での自動失効を持たない。
 * 保留中の要求も時間で失効せず、手動の承認/拒否か切断まで生存する。
 *
 * 件数クレジット・応答キュー・ストリーム上限をブリッジ層に持たない。
 * framing 本体上限（65,536）は transport（`FRAME_MAX_BYTES`）の固定であり、
 * yamux の stream 上限（各32）も transport（`MAX_INBOUND_STREAMS` 等）の固定である。
 * ここに残す `maxWebSocketMessageBytes` は WS メッセージ1件の上限（`ws` の
 * `maxPayload`）だけであり、framing 上限とは別物である。
 *
 * @packageDocumentation
 */

/** 流れ制御・制限の暫定値。すべて有限で設定可能である。 */
export interface BridgeLimits {
  /**
   * WS メッセージ1件の最大長（`ws` の `maxPayload` に渡す）。
   *
   * 認可前テキスト・認可後バイナリの双方に適用する。分割フレームは合算する。
   * framing 本体上限とは別であり、yamux の断片をそのまま送るため
   * framing 上限より大きめに取る。
   *
   * @defaultValue `1048576`。
   */
  readonly maxWebSocketMessageBytes: number;
  /**
   * 同時接続数の上限。
   *
   * @defaultValue `8`（B1 暫定）。
   */
  readonly maxConnections: number;
  /**
   * 未認可接続数（開始待ち＋承認待ち）の上限。`maxConnections` の内数であり、
   * 認可済み接続を追い出さない。`maxPendingPairings` 以上であること。
   *
   * @defaultValue `2`（設計既定）。
   */
  readonly maxUnauthorizedConnections: number;
  /**
   * 同時保留数（承認待ち）の上限。`maxUnauthorizedConnections` 以下であること。
   *
   * @defaultValue `2`（設計既定）。
   */
  readonly maxPendingPairings: number;
  /**
   * 受付レートの観測窓（ミリ秒）。`(now-window, now]` に入る試行を数える。
   *
   * 自動失効のタイマーには使わないため、Node タイマーの上限は適用しない。
   *
   * @defaultValue `60000`（設計既定）。
   */
  readonly pairingRateWindowMs: number;
  /**
   * `Origin` 別の受付レート上限。直近窓の試行数がこの値に達したら拒否する。
   * `maxPairingRequestsTotal` 以下であること。
   *
   * @defaultValue `5`（設計既定）。
   */
  readonly maxPairingRequestsPerOrigin: number;
  /**
   * 全 `Origin` 合計の受付レート上限。直近窓の試行数がこの値に達したら拒否する。
   *
   * @defaultValue `10`（設計既定）。
   */
  readonly maxPairingRequestsTotal: number;
  /**
   * 比較コード生成の試行上限回数。生存中の保留と重複しないコードをこの回数で
   * 得られなければ、その要求を失敗終了する（エントリは残さない）。
   *
   * @defaultValue `16`（設計既定）。
   */
  readonly maxPairingCodeGenerationAttempts: number;
  /**
   * 運用切断で応答しない相手を強制終了するまでの時間（ミリ秒）。
   *
   * @defaultValue `1000`（設計既定）。
   */
  readonly connectionCloseGraceMs: number;
}

/** 暫定値と設計既定値。計測用であり合意値ではない。 */
export const DEFAULT_LIMITS: BridgeLimits = {
  maxWebSocketMessageBytes: 1_048_576,
  maxConnections: 8,
  maxUnauthorizedConnections: 2,
  maxPendingPairings: 2,
  pairingRateWindowMs: 60_000,
  maxPairingRequestsPerOrigin: 5,
  maxPairingRequestsTotal: 10,
  maxPairingCodeGenerationAttempts: 16,
  connectionCloseGraceMs: 1_000,
};

/**
 * Node タイマーで安全に扱える上限（`setTimeout` の最大遅延）。
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * 実際に `setTimeout` へ渡す項目。Node タイマーの範囲にも収める。
 *
 * 受付レートの観測窓（`pairingRateWindowMs`）は窓計算にだけ使い、
 * タイマーとして仕掛けないため含めない。
 */
const TIMER_KEYS: ReadonlySet<keyof BridgeLimits> = new Set(["connectionCloseGraceMs"]);

/**
 * 暫定値を部分指定と突き合わせて完全な制限値にする。
 *
 * @param partial - 上書きする項目。未指定は `DEFAULT_LIMITS` を使う。
 * @returns 完全な制限値。
 * @throws `RangeError` — 正の安全な整数でない項目、タイマーが Node タイマーの
 * 範囲に収まらない場合、または上限の関係
 * （`maxPendingPairings <= maxUnauthorizedConnections <= maxConnections`、
 * `maxPairingRequestsPerOrigin <= maxPairingRequestsTotal`）を満たさない場合。
 */
export function resolveLimits(partial?: Partial<BridgeLimits>): BridgeLimits {
  const merged: BridgeLimits = { ...DEFAULT_LIMITS, ...partial };
  const entries = Object.entries(merged) as Array<[keyof BridgeLimits, number]>;
  for (const [key, value] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`limits.${key} は正の安全な整数であること。`);
    }
    if (TIMER_KEYS.has(key) && value > MAX_TIMER_MS) {
      throw new RangeError(`limits.${key} は Node タイマーで扱える範囲であること。`);
    }
  }
  if (merged.maxPendingPairings > merged.maxUnauthorizedConnections) {
    throw new RangeError(
      "limits.maxPendingPairings は maxUnauthorizedConnections 以下であること。",
    );
  }
  if (merged.maxUnauthorizedConnections > merged.maxConnections) {
    throw new RangeError("limits.maxUnauthorizedConnections は maxConnections 以下であること。");
  }
  if (merged.maxPairingRequestsPerOrigin > merged.maxPairingRequestsTotal) {
    throw new RangeError(
      "limits.maxPairingRequestsPerOrigin は maxPairingRequestsTotal 以下であること。",
    );
  }
  return merged;
}
