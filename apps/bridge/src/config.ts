/**
 * ブリッジの有限・設定可能な暫定値。
 *
 * 値の正本は下の `DEFAULT_LIMITS` とする。B1 到達性確認のための計測用暫定値
 * であり、合意値・性能保証ではない。計測時の実効設定は証拠に記録する。
 * 検証計画は `docs/verification/bridge.md` を見る。すべての値は
 * `BridgeOptions.limits` で上書きできる。
 *
 * 比較コード方式の期限・上限・レートの設計既定値は
 * `design/bridge.md` の候補節を参照し、形状の正本は
 * `bridge-protocol`（`PAIRING_CODE_LENGTH` 等）に置く。
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
   * 同時接続数の上限。
   *
   * @defaultValue `8`（B1 暫定）。
   */
  readonly maxConnections: number;
  /**
   * 接続から開始メッセージ（`pairing_start`）までの制限時間（ミリ秒）。
   *
   * @defaultValue `10000`（設計既定）。
   */
  readonly pairingStartTimeoutMs: number;
  /**
   * 比較コード発行から承認までの制限時間（ミリ秒）。保留の絶対期限は
   * 「発行＋この値」と「受付終了」の早い方である。
   *
   * 受付時間（`acceptanceDurationMs`）との大小は制限しない。
   *
   * @defaultValue `120000`（設計既定）。
   */
  readonly pairingApprovalTimeoutMs: number;
  /**
   * 受付を開いてから自動クローズするまでの時間（ミリ秒）。
   * 開いている間の再操作は期限を更新しない。
   *
   * @defaultValue `120000`（設計既定）。
   */
  readonly acceptanceDurationMs: number;
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

/** B1 の暫定値と設計既定値。計測用であり合意値ではない。 */
export const DEFAULT_LIMITS: BridgeLimits = {
  maxMessageBytes: 65_536,
  maxReliableQueueMessages: 256,
  maxReliableQueueBytes: 1_048_576,
  maxStreamsPerConnection: 32,
  initialCreditWindow: 32,
  maxConnections: 8,
  pairingStartTimeoutMs: 10_000,
  pairingApprovalTimeoutMs: 120_000,
  acceptanceDurationMs: 120_000,
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

/** タイマーとして扱う項目。Node タイマーの範囲にも収める。 */
const TIMER_KEYS: ReadonlySet<keyof BridgeLimits> = new Set([
  "pairingStartTimeoutMs",
  "pairingApprovalTimeoutMs",
  "acceptanceDurationMs",
  "pairingRateWindowMs",
  "connectionCloseGraceMs",
]);

/**
 * 暫定値を部分指定と突き合わせて完全な制限値にする。
 *
 * @param partial - 上書きする項目。未指定は `DEFAULT_LIMITS` を使う。
 * @returns 完全な制限値。
 * @throws `RangeError` — 正の安全な整数でない項目、タイマーが Node タイマーの
 * 範囲に収まらない場合、または上限の関係
 * （`maxPendingPairings <= maxUnauthorizedConnections <= maxConnections`、
 * `maxPairingRequestsPerOrigin <= maxPairingRequestsTotal`、
 * `initialCreditWindow <= maxReliableQueueMessages`）を満たさない場合。
 * @remarks
 * 承認待ち時間（`pairingApprovalTimeoutMs`）と受付時間
 * （`acceptanceDurationMs`）の大小は制限しない。
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
  if (merged.initialCreditWindow > merged.maxReliableQueueMessages) {
    // 初期付与が件数容量を超えると、受信前に付与した権利が容量に収まらない。
    throw new RangeError("limits.initialCreditWindow は maxReliableQueueMessages 以下であること。");
  }
  return merged;
}
