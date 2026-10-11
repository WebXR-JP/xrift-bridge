/**
 * 1回の接続試行の認証状態（ペアリング）。
 *
 * `AbortSignal` の購読解除と、比較コードの保持を担う。接続状態・
 * ソケット・公開通知は持たず、状態の正本と通知は調停役（接続要求）が
 * 行う。試行側は「コード受信」「失敗通知」の手段だけを提供し、認可成立時
 * の決着（取消分離）は `succeed` が行う。公開 Promise は持たない。
 * 調停役が公開の約束を直接決着する。
 *
 * 認証まわりに時限を設けない。コード受信待ちの取消は `AbortSignal`、
 * 通信失敗はソケットの close 通知で扱う。
 */
import type { PairingPendingMessage } from "bridge-protocol";
import { WorldClientError } from "./errors.ts";
import type { PairingInfo } from "./client.ts";

/** 試行内部の失敗（取消）の通知先。 */
export interface PairingAttemptCallbacks {
  /**
   * 試行の失敗を調停役へ通知する。調停役は終了順序（ソケット切断・状態確定・
   * 公開通知）を行う。
   *
   * @param attempt - 失敗した試行。旧試行の遅延通知かは同一性で調停役が判定する。
   * @param error - 失敗の符号と説明。`CONNECT_CANCELLED` である。
   */
  onAttemptFailed(attempt: PairingAttempt, error: WorldClientError): void;
}

/** 試行生成時の設定。 */
export interface PairingAttemptOptions {
  /** 接続試行を取り消す合図。取消時は `CONNECT_CANCELLED` を通知する。 */
  readonly signal?: AbortSignal;
  /** 内部失敗の通知先。 */
  readonly callbacks: PairingAttemptCallbacks;
}

/**
 * 1回の接続試行。比較コードの受付・決着手段を所有する。
 *
 * 段階の判定（どの状態で何を受け付けるか）は調停役が行い、試行は
 * 保持・決着の手段だけを提供する。
 */
export class PairingAttempt {
  private readonly callbacks: PairingAttemptCallbacks;
  private abortSignal: AbortSignal | null = null;
  private abortHandler: (() => void) | null = null;
  private pairing: PairingInfo | null = null;
  private settled = false;

  constructor(options: PairingAttemptOptions) {
    this.callbacks = options.callbacks;
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
   * 比較コードを受け付けて保持する。
   *
   * 受付可否（`requesting_pairing` の1回のみ）は調停役が状態で判定済みで
   * あること。時限の切替えは行わない。
   *
   * @param message - ブリッジからの比較コード通知。
   * @returns 保存した表示用情報。
   */
  acceptPairingCode(message: PairingPendingMessage): PairingInfo {
    const info: PairingInfo = {
      requestId: message.requestId,
      code: message.code,
    };
    this.pairing = info;
    return info;
  }

  /**
   * 試行を成功で決着する。取消分離を伴う。
   */
  succeed(): void {
    if (this.settled) return;
    this.settled = true;
    this.detachAbort();
  }

  /**
   * 試行を失敗で決着する。取消分離・比較コード破棄を伴う。
   *
   * @returns 破棄時点で比較コードを表示中だったか。
   */
  fail(): boolean {
    const hadPairing = this.pairing !== null;
    if (this.settled) return hadPairing;
    this.settled = true;
    this.pairing = null;
    this.detachAbort();
    return hadPairing;
  }

  private detachAbort(): void {
    if (this.abortSignal !== null && this.abortHandler !== null) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
    this.abortSignal = null;
    this.abortHandler = null;
  }
}
