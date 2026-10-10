/**
 * yamux の公開 `ping()` を使う死活監視。
 *
 * 内蔵 keepalive（`enableKeepAlive`）には障害検知を委ねず、ここで自前の
 * 監視ループを動かす。mux 開始から一定後に最初の Ping を送り、以後は
 * 応答ごとに次を送る。同時 Ping は1件であり、進行中は次を発行しない。
 * 不応答・拒否は呼び出し側（Connection 終端）へ通知する。
 * Ping 成功は往復経路と相手の yamux 処理が動いたことのみを示す。
 *
 * @packageDocumentation
 */

import { defaultTimerScheduler, type TimerScheduler } from "./timers.ts";

/** mux 開始から最初の Ping までの遅延（ミリ秒）。 */
export const KEEPALIVE_FIRST_DELAY_MS = 30_000;

/** 正常応答から次の Ping までの間隔（ミリ秒）。 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** Ping 発行から応答を待つ期限（ミリ秒）。超過で失敗とする。 */
export const KEEPALIVE_PING_TIMEOUT_MS = 60_000;

/** 死活監視の生成条件。 */
export interface KeepaliveOptions {
  /**
   * 往復を測る処理。通常は muxer の `ping()` を渡す。
   *
   * @returns 往復時間（ミリ秒）。値の利用はしない。
   */
  readonly ping: () => Promise<number>;
  /** タイマーの実装。省略時は環境のタイマーを使う。 */
  readonly scheduler?: TimerScheduler;
  /** 最初の Ping までの遅延（ミリ秒）。既定は `KEEPALIVE_FIRST_DELAY_MS`。 */
  readonly firstDelayMs?: number;
  /** 正常応答から次の Ping までの間隔（ミリ秒）。既定は `KEEPALIVE_INTERVAL_MS`。 */
  readonly intervalMs?: number;
  /** Ping 発行からの応答期限（ミリ秒）。既定は `KEEPALIVE_PING_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
  /** 不応答・拒否の通知先。Connection 終端につなぐ。例外は隔離する。 */
  readonly onFailure: (error: Error) => void;
}

/** 未知値を `Error` に寄せる。 */
function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/**
 * yamux の公開 `ping()` を使う死活監視。
 *
 * `start()` で最初の Ping を予約し、`stop()` で全タイマーを解除する。
 * 失敗時は一度だけ停止して `onFailure` へ通知する。停止後の遅延した
 * Ping 決着は無視する。
 */
export class Keepalive {
  private readonly ping: () => Promise<number>;
  private readonly scheduler: TimerScheduler;
  private readonly firstDelayMs: number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly onFailure: (error: Error) => void;

  /** 監視中か。失敗・停止で偽になる。 */
  private started = false;
  /** Ping 発行中か。同時1件の判定に使う。 */
  private pingInFlight = false;
  /** Ping 世代。期限・停止で進め、遅延決着を取り違えない。 */
  private generation = 0;
  /** 次回 Ping の予約。Ping 発行中は存在しない。 */
  private delayHandle: unknown = undefined;
  /** 発行中 Ping の応答期限。待機 Ping がなければ存在しない。 */
  private timeoutHandle: unknown = undefined;

  /**
   * @param options - 往復処理・タイマー・間隔・失敗通知。
   */
  constructor(options: KeepaliveOptions) {
    this.ping = options.ping;
    this.scheduler = options.scheduler ?? defaultTimerScheduler;
    this.firstDelayMs = options.firstDelayMs ?? KEEPALIVE_FIRST_DELAY_MS;
    this.intervalMs = options.intervalMs ?? KEEPALIVE_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? KEEPALIVE_PING_TIMEOUT_MS;
    this.onFailure = options.onFailure;
  }

  /** 監視中か。 */
  get running(): boolean {
    return this.started;
  }

  /** 監視を始める。二重呼び出しは無視する。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleDelay(this.firstDelayMs);
  }

  /**
   * 監視を止める。全タイマーを解除する。
   *
   * 発行中の Ping があっても次は送らず、遅延した決着は無視する。
   * 二重呼び出しは無視する。
   */
  stop(): void {
    if (!this.started && this.delayHandle === undefined && this.timeoutHandle === undefined) return;
    this.started = false;
    this.pingInFlight = false;
    // ADR: 世代を進めて発行中の Ping を陳腐化する。停止後に届く成功・拒否は
    // 無視し、失敗通知の二重発火を防ぐ。
    this.generation += 1;
    this.clearDelay();
    this.clearPingTimeout();
  }

  /** 次回 Ping を予約する。 */
  private scheduleDelay(delayMs: number): void {
    this.clearDelay();
    this.delayHandle = this.scheduler.setTimeout(() => {
      this.delayHandle = undefined;
      this.onDelayFired();
    }, delayMs);
  }

  /** 次回 Ping の予約を取り消す。 */
  private clearDelay(): void {
    if (this.delayHandle !== undefined) {
      this.scheduler.clearTimeout(this.delayHandle);
      this.delayHandle = undefined;
    }
  }

  /** 発行中 Ping の応答期限を取り消す。 */
  private clearPingTimeout(): void {
    if (this.timeoutHandle !== undefined) {
      this.scheduler.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  /** 次回 Ping の時刻になったら1件だけ発行する。 */
  private onDelayFired(): void {
    if (!this.started) return;
    // ADR: 同時 Ping は1件であり、進行中は次を発行しない。予約は発行後の
    // 決着で組むため通常は到達しないが、見張りとして次回に譲る。
    if (this.pingInFlight) {
      this.scheduleDelay(this.intervalMs);
      return;
    }
    this.pingInFlight = true;
    this.generation += 1;
    const generation = this.generation;
    this.timeoutHandle = this.scheduler.setTimeout(() => {
      this.timeoutHandle = undefined;
      this.onPingTimedOut(generation);
    }, this.timeoutMs);
    this.ping().then(
      () => {
        this.onPingSucceeded(generation);
      },
      (cause: unknown) => {
        this.onPingRejected(generation, cause);
      },
    );
  }

  /** Ping 成功で次回を予約する。陳腐化した決着は無視する。 */
  private onPingSucceeded(generation: number): void {
    if (!this.started || generation !== this.generation) return;
    this.pingInFlight = false;
    this.clearPingTimeout();
    this.scheduleDelay(this.intervalMs);
  }

  /** Ping 拒否で失敗とする。陳腐化した決着は無視する。 */
  private onPingRejected(generation: number, cause: unknown): void {
    if (!this.started || generation !== this.generation) return;
    this.pingInFlight = false;
    this.clearPingTimeout();
    this.fail(toError(cause, "keepalive の Ping が拒否された。"));
  }

  /** 応答期限の超過で失敗とする。遅延した成功は無視する。 */
  private onPingTimedOut(generation: number): void {
    if (!this.started || generation !== this.generation) return;
    // ADR: 世代を進めて発行中の Ping を陳腐化する。期限後に届く成功は
    // 次回の発行につなげず無視する。
    this.generation += 1;
    this.pingInFlight = false;
    this.fail(new Error(`keepalive の応答が ${this.timeoutMs}ms 以内に返らない。`));
  }

  /** 失敗として止め、通知する。購読者の例外は隔離する。 */
  private fail(error: Error): void {
    this.started = false;
    this.clearDelay();
    this.clearPingTimeout();
    try {
      this.onFailure(error);
    } catch {
      // 終端経路の例外で監視を壊さない。
    }
  }
}
