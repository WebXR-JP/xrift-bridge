/**
 * ブリッジの有限・設定可能な暫定値。
 *
 * 値の正本は下の `DEFAULT_LIMITS` とする。B1 到達性確認のための計測用暫定値
 * であり、合意値・性能保証ではない。計測時の実効設定は証拠に記録する。
 * 検証計画は `docs/verification/bridge.md` を見る。すべての値は
 * `BridgeOptions.limits` で上書きできる。
 *
 * @packageDocumentation
 */

/** 流れ制御・制限の暫定値。すべて有限で設定可能である。 */
export interface BridgeLimits {
  /**
   * 1メッセージの最大長。UTF-8 にシリアライズした JSON メッセージのバイト数。
   * 受信上限は `ws` の `maxPayload`（分割フレーム合算）に委ね、超過時は
   * close 1009 で通知する。
   *
   * @defaultValue `65536`（B1 暫定）。
   */
  readonly maxMessageBytes: number;
  /**
   * 接続単位の reliable 件数容量。未消費の付与残と保持中（未送信・送信中）の
   * 応答の合計がこの件数に収まるよう、累積付与で制御する。
   *
   * @defaultValue `256`（B1 暫定）。
   */
  readonly maxReliableQueueMessages: number;
  /**
   * 接続ごとの reliable 未応答キューの上限バイト数。UTF-8 バイトで計上する。
   *
   * @defaultValue `1048576`（B1 暫定）。
   */
  readonly maxReliableQueueBytes: number;
  /**
   * 接続ごとのストリーム数上限。
   *
   * @defaultValue `32`（B1 暫定）。
   */
  readonly maxStreamsPerConnection: number;
  /**
   * 認証直後に付与する reliable 送信クレジット（累積件数）。
   * `maxReliableQueueMessages` 以下であること。
   *
   * @defaultValue `32`（B1 暫定）。
   */
  readonly initialCreditWindow: number;
  /**
   * 認証待ちの制限時間（ミリ秒）。
   *
   * @defaultValue `10000`（B1 暫定）。
   */
  readonly authTimeoutMs: number;
  /**
   * 接続ごとの認証試行の上限回数。
   *
   * @defaultValue `3`（B1 暫定）。
   */
  readonly maxAuthAttempts: number;
  /**
   * 同時接続数の上限。
   *
   * @defaultValue `8`（B1 暫定）。
   */
  readonly maxConnections: number;
}

/** B1 の暫定値。計測用であり合意値ではない。 */
export const DEFAULT_LIMITS: BridgeLimits = {
  maxMessageBytes: 65_536,
  maxReliableQueueMessages: 256,
  maxReliableQueueBytes: 1_048_576,
  maxStreamsPerConnection: 32,
  initialCreditWindow: 32,
  authTimeoutMs: 10_000,
  maxAuthAttempts: 3,
  maxConnections: 8,
};

/** ペアリング秘密値の有効期間（ミリ秒）。設計で 120 秒に確定している。 */
export const PAIRING_TTL_MS = 120_000;

/** ペアリング秘密値の乱数長（バイト）。128 ビット以上が設計要件である。 */
export const PAIRING_SECRET_BYTES = 16;

/**
 * 暫定値を部分指定と突き合わせて完全な制限値にする。
 *
 * @param partial - 上書きする項目。未指定は `DEFAULT_LIMITS` を使う。
 * @returns 完全な制限値。
 * @throws `RangeError` — 有限の正数でない項目がある場合。
 */
export function resolveLimits(partial?: Partial<BridgeLimits>): BridgeLimits {
  const merged: BridgeLimits = { ...DEFAULT_LIMITS, ...partial };
  const entries = Object.entries(merged) as Array<[keyof BridgeLimits, number]>;
  for (const [key, value] of entries) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`limits.${key} は正の整数であること。`);
    }
  }
  if (merged.initialCreditWindow > merged.maxReliableQueueMessages) {
    // 初期付与が件数容量を超えると、受信前に付与した権利が容量に収まらない。
    throw new RangeError("limits.initialCreditWindow は maxReliableQueueMessages 以下であること。");
  }
  return merged;
}
