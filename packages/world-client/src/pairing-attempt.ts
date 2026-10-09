/**
 * 1回の接続試行の認証状態（ペアリング）。
 *
 * 接続 Promise の決着・開始タイマー・承認 watchdog・`AbortSignal`・比較コード
 * の保持を担う。接続状態・ソケット・公開通知は持たず、状態の正本と通知は
 * 調停役（クライアント）が行う。試行側は「コード受信」「認可成立候補」
 * 「失敗」を返す/通知するだけであり、`authorized`・`closed` の独自状態は
 * 持たない。試行の生存は調停役の保持（同一性）で区別し、旧試行の遅延通知・
 * 旧タイマーを新試行へ作用させない。
 */
import type { AuthOkMessage, PairingPendingMessage } from "bridge-protocol";
import { WorldClientError } from "./errors.ts";
import type { ConnectResult, PairingInfo } from "./client.ts";

/**
 * `setTimeout` に安全に渡せる上限（ミリ秒）。
 *
 * Node・ブラウザともに 2^31−1 を超える遅延はオーバーフローし、即時発火や
 * 警告の原因になる。承認待ちの watchdog は期限再判定付きの分割で扱い、
 * 接続開始タイマーの入力はこの範囲に収める。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
   * 公開通知）を行う。通知時点で試行自体の決着は調停役側の終了処理が行う。
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
  /** 要求応答の待ち時間（ミリ秒）。承認 watchdog の期限に加算する。 */
  readonly requestTimeoutMs: number;
  /** 接続試行を取り消す合図。取消時は `CONNECT_CANCELLED` を通知する。 */
  readonly signal?: AbortSignal;
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
  /** `connect` に返す Promise。決着は `succeed`・`fail` が行う。 */
  readonly promise: Promise<ConnectResult>;
  private readonly settle: {
    readonly resolve: (value: ConnectResult) => void;
    readonly reject: (error: WorldClientError) => void;
  };
  private readonly requestTimeoutMs: number;
  private readonly callbacks: PairingAttemptCallbacks;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abortSignal: AbortSignal | null = null;
  private abortHandler: (() => void) | null = null;
  private pairing: PairingInfo | null = null;

  constructor(options: PairingAttemptOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.callbacks = options.callbacks;
    // executor は同期実行されるため、決着フックは構築完了時に必ず置き換わる。
    // 初期値は到達しない予備である。
    let resolveHook: (value: ConnectResult) => void = () => undefined;
    let rejectHook: (error: WorldClientError) => void = () => undefined;
    this.promise = new Promise<ConnectResult>((resolve, reject) => {
      resolveHook = resolve;
      rejectHook = reject;
    });
    // ADR: 決着時はタイマー解除・取消分離を必ず伴わせる。二重決着の呼び出しは
    // Promise の冪等性と null 安全な清掃で無害であり、通知より先に確定する側が
    // 試行の保持破棄と順序を担う。
    this.settle = {
      resolve: (value: ConnectResult) => {
        this.clearTimer();
        this.detachAbort();
        resolveHook(value);
      },
      reject: (error: WorldClientError) => {
        this.clearTimer();
        this.detachAbort();
        rejectHook(error);
      },
    };
    // ADR: 未決着 `connect` のタイマーは既定で ref を維持し、`unref` しない。
    // 終了・成功時は `succeed`・`fail` のいずれかで必ず解除する。
    this.timer = setTimeout(() => {
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
   * あること。保存は状態・通知より先に行い、購読が遅れても `getPairing()`
   * で見えるようにする。
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
    // ADR: 承認応答の watchdog は `expiresInMs + requestTimeoutMs` とし、
    // ブリッジ側の期限切れと断定しない符号で打ち切る。長時間は期限再判定付きの
    // 分割タイマーで扱い、独自の短い上限で承認待ちを切り詰めない。
    this.startApprovalWatchdog(Date.now() + message.expiresInMs + this.requestTimeoutMs);
    return info;
  }

  /**
   * 認可成立候補を取り出す。要求 ID の一致確認は調停役が行う。
   *
   * @param message - ブリッジからの認証応答。
   * @returns 決着とセッション生成に使う要求識別子・セッション識別子・初期 window。
   */
  acceptAuthOk(message: AuthOkMessage): {
    readonly requestId: PairingInfo["requestId"];
    readonly sessionId: AuthOkMessage["sessionId"];
    readonly window: AuthOkMessage["window"];
  } {
    return { requestId: message.requestId, sessionId: message.sessionId, window: message.window };
  }

  /**
   * 試行を成功で決着する。タイマー解除・取消分離を決着に伴わせる。
   *
   * @param result - 認可成立の内容。
   */
  succeed(result: ConnectResult): void {
    this.settle.resolve(result);
  }

  /**
   * 試行を失敗で決着する。タイマー解除・取消分離・比較コード破棄を伴う。
   *
   * @param error - `connect` の拒否理由。
   * @returns 破棄時点で比較コードを表示中だったか。`pairing: null` 通知の要否に使う。
   */
  fail(error: WorldClientError): boolean {
    const hadPairing = this.pairing !== null;
    this.pairing = null;
    this.settle.reject(error);
    return hadPairing;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 承認待ち watchdog を期限再判定付きの分割タイマーで仕掛ける。
   *
   * `expiresInMs + requestTimeoutMs` がタイマー安全範囲を超える場合、単発の
   * `setTimeout` はオーバーフローして早期発火するため、期限時刻まで残量ごとに
   * 分割して待ち直す。独自の短い上限で承認待ちを切り詰めない。
   * 未決着 `connect` のタイマーは既定で ref を維持し、`unref` しない。
   * 終了・成功時は `succeed`・`fail` が必ず解除する。
   * `clearTimeout` は既キュー済みコールバックを取り消せないため、発火時の
   * 再武装前に解除済み（`this.timer === null`）を確認する。決着時の
   * `clearTimer` と合わせ、死んだ試行がタイマーを残さない。
   * 旧試行の通知が新試行へ作用しないこと自体は調停役の同一性確認が担う。
   *
   * @param deadlineMs - 承認応答の期限時刻（`Date.now()` 基準）。
   */
  private startApprovalWatchdog(deadlineMs: number): void {
    this.clearTimer();
    const schedule = (delayMs: number): void => {
      // ADR: ref を維持するため `unref` を呼ばない。終了・成功時の解除は `succeed`・`fail` が行う。
      this.timer = setTimeout(() => {
        // ADR: 決着済み（解除済み）の試行は再武装しない。解除済みタイマーの
        // コールバックが既キューで実行されても、ハンドルなしで即 return する。
        // 発火中の自分のハンドルを保持している通常発火時は非 null である。
        if (this.timer === null) return;
        const remaining = deadlineMs - Date.now();
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
    const remaining = deadlineMs - Date.now();
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
