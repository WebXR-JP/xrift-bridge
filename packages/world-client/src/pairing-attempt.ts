/**
 * 1回の接続試行の認証状態（ペアリング）。
 *
 * 開始タイマー・承認 watchdog・`AbortSignal`・比較コードの保持を担う。
 * 接続状態・ソケット・公開通知は持たず、状態の正本と通知は調停役
 * （接続要求）が行う。試行側は「コード受信」「失敗通知」の手段だけを
 * 提供し、認可成立時の決着（タイマー解除・取消分離）は `succeed` が行う。
 * 公開 Promise は持たない。調停役が公開の約束を直接決着する。
 *
 * タイマーは差し替え可能にし、試験では手で進める実装を注入する。
 */
import type { PairingPendingMessage } from "bridge-protocol";
import type { TimerScheduler } from "bridge-protocol/transport";
import { defaultTimerScheduler } from "bridge-protocol/transport";
import { WorldClientError } from "./errors.ts";
import type { PairingInfo } from "./client.ts";

/**
 * `setTimeout` に安全に渡せる上限（ミリ秒）。
 *
 * Node・ブラウザともに 2^31−1 を超える遅延はオーバーフローし、即時発火や
 * 警告の原因になる。承認待ちの watchdog は期限再判定付きの分割で扱い、
 * 接続開始タイマーの入力はこの範囲に収める。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 承認応答待ちに上乗せする猶予（ミリ秒）。
 *
 * サーバ側の期限切れと断定しないよう、コードの残り時間にこの猶予を足した
 * 時点で打ち切る。0.2 の `requestTimeoutMs` 由来の加算は撤去し、業務の
 * 要求待機を持たない 0.3 では固定値とする。
 */
const APPROVAL_GRACE_MS = 10_000;

/**
 * 接続開始タイマーの入力を検証する。有限の正の整数かつタイマー安全範囲であること。
 *
 * @param timeoutMs - 検証対象の候補値。
 */
export function assertConnectTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("timeoutMs は1以上2147483647以下の整数（ミリ秒）であること。");
  }
}

/** 試行内部の失敗（開始タイマー・承認 watchdog・取消）の通知先。 */
export interface PairingAttemptCallbacks {
  /**
   * 試行の失敗を調停役へ通知する。調停役は終了順序（ソケット切断・状態確定・
   * 公開通知）を行う。
   *
   * @param attempt - 失敗した試行。旧試行の遅延通知かは同一性で調停役が判定する。
   * @param error - 失敗の符号と説明。`CONNECT_TIMEOUT`・
   * `APPROVAL_RESPONSE_TIMEOUT`・`CONNECT_CANCELLED` のいずれか。
   */
  onAttemptFailed(attempt: PairingAttempt, error: WorldClientError): void;
}

/** 試行生成時の設定。 */
export interface PairingAttemptOptions {
  /** 接続開始から比較コード受信までの待ち時間（ミリ秒）。事前検証済みであること。 */
  readonly timeoutMs: number;
  /** 接続試行を取り消す合図。取消時は `CONNECT_CANCELLED` を通知する。 */
  readonly signal?: AbortSignal;
  /** タイマーの実装。省略時は環境のタイマーを使う。 */
  readonly scheduler?: TimerScheduler;
  /** 時刻の取得口。承認 watchdog の期限判定に使う。試験用の差し替え口。 */
  readonly now?: () => number;
  /** 内部失敗の通知先。 */
  readonly callbacks: PairingAttemptCallbacks;
}

/**
 * 1回の接続試行。比較コードの受付・承認待ち・決着手段を所有する。
 *
 * 段階の判定（どの状態で何を受け付けるか）は調停役が行い、試行は
 * 保持・時限・決着の手段だけを提供する。
 */
export class PairingAttempt {
  private readonly scheduler: TimerScheduler;
  private readonly now: () => number;
  private readonly callbacks: PairingAttemptCallbacks;
  private timer: unknown = null;
  private abortSignal: AbortSignal | null = null;
  private abortHandler: (() => void) | null = null;
  private pairing: PairingInfo | null = null;
  private settled = false;

  constructor(options: PairingAttemptOptions) {
    this.scheduler = options.scheduler ?? defaultTimerScheduler;
    this.now = options.now ?? Date.now;
    this.callbacks = options.callbacks;
    // ADR: 未決着の試行タイマーは既定で ref を維持し、`unref` しない。
    // 終了・成功時は `succeed`・`fail` のいずれかで必ず解除する。
    this.timer = this.scheduler.setTimeout(() => {
      this.callbacks.onAttemptFailed(
        this,
        new WorldClientError("CONNECT_TIMEOUT", "比較コードが時間内に届かない。"),
      );
    }, options.timeoutMs);
    if (options.signal !== undefined) {
      this.abortSignal = options.signal;
      this.abortHandler = (): void => {
        this.callbacks.onAttemptFailed(
          this,
          new WorldClientError("CONNECT_CANCELLED", "接続試行が取り消された。"),
        );
      };
      options.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  /** 表示中の比較コード。未受信なら `null`。 */
  getPairing(): PairingInfo | null {
    return this.pairing;
  }

  /**
   * 比較コードを受け付けて保持し、承認 watchdog へ切り替える。
   *
   * 受付可否（`requesting_pairing` の1回のみ）は調停役が状態で判定済みで
   * あること。
   *
   * @param message - ブリッジからの比較コード通知。
   * @returns 保存した表示用情報。
   */
  acceptPairingCode(message: PairingPendingMessage): PairingInfo {
    const info: PairingInfo = {
      requestId: message.requestId,
      code: message.code,
      expiresAt: message.expiresAt,
      expiresInMs: message.expiresInMs,
    };
    this.pairing = info;
    // ADR: `timeoutMs` は接続開始からコード受信までであり、人間の承認待ちを
    // 打ち切らない。コード受信で解除し、承認応答待ちの watchdog へ切り替える。
    // ADR: 承認応答の watchdog は `expiresInMs + APPROVAL_GRACE_MS` とし、
    // ブリッジ側の期限切れと断定しない符号で打ち切る。0.2 の要求待ち時間の
    // 加算は撤去し、固定の猶予とする。長時間は期限再判定付きの分割タイマー
    // で扱い、独自の短い上限で承認待ちを切り詰めない。
    this.startApprovalWatchdog(this.now() + message.expiresInMs + APPROVAL_GRACE_MS);
    return info;
  }

  /**
   * 試行を成功で決着する。タイマー解除・取消分離を伴う。
   */
  succeed(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.detachAbort();
  }

  /**
   * 試行を失敗で決着する。タイマー解除・取消分離・比較コード破棄を伴う。
   *
   * @returns 破棄時点で比較コードを表示中だったか。
   */
  fail(): boolean {
    const hadPairing = this.pairing !== null;
    if (this.settled) return hadPairing;
    this.settled = true;
    this.pairing = null;
    this.clearTimer();
    this.detachAbort();
    return hadPairing;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 承認待ち watchdog を期限再判定付きの分割タイマーで仕掛ける。
   *
   * `expiresInMs + APPROVAL_GRACE_MS` がタイマー安全範囲を超える場合、
   * 単発の遅延はオーバーフローして早期発火するため、期限時刻まで残量ごとに
   * 分割して待ち直す。独自の短い上限で承認待ちを切り詰めない。
   * 終了・成功時は `succeed`・`fail` が必ず解除する。
   * 決着済み（解除済み）の試行は再武装しない。
   * 旧試行の通知が新試行へ作用しないこと自体は調停役の同一性確認が担う。
   *
   * @param deadlineMs - 承認応答の期限時刻（`now` 基準）。
   */
  private startApprovalWatchdog(deadlineMs: number): void {
    this.clearTimer();
    const schedule = (delayMs: number): void => {
      this.timer = this.scheduler.setTimeout(() => {
        // ADR: 決着済み（解除済み）の試行は再武装しない。解除済みタイマーの
        // 呼び出しが実行されても、ハンドルなしで即 return する。
        if (this.timer === null) return;
        const remaining = deadlineMs - this.now();
        if (remaining <= 0) {
          this.callbacks.onAttemptFailed(
            this,
            new WorldClientError("APPROVAL_RESPONSE_TIMEOUT", "承認応答が時間内に届かない。"),
          );
          return;
        }
        schedule(Math.min(remaining, MAX_TIMER_DELAY_MS));
      }, delayMs);
    };
    const remaining = deadlineMs - this.now();
    if (remaining <= 0) {
      this.callbacks.onAttemptFailed(
        this,
        new WorldClientError("APPROVAL_RESPONSE_TIMEOUT", "承認応答が時間内に届かない。"),
      );
      return;
    }
    schedule(Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  private detachAbort(): void {
    if (this.abortSignal !== null && this.abortHandler !== null) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
    this.abortSignal = null;
    this.abortHandler = null;
  }
}
