/**
 * 比較コード方式の保留管理・受付モード・受付レート。
 *
 * ブリッジ（信頼側 PC）が比較コードを発行し、ワールド画面と PC の両方に
 * 表示して人間が照合する。コード一致は UI に表示された要求との対応確認で
 * あり、ワールドの真正性の証明ではない（「OTP 認証」ではない）。
 * 詳しい設計判断は `design/bridge-connection.md` の候補節を見る。
 *
 * 期限の実判定は単調時計で行い、`expiresAt`（壁時計）は表示用に留める。
 * 壁時計の変更や遅延タイマーで期限が延びないよう、すべての入口
 * （`create`・`get`・`list`・`approve`・`reject`・`remove`・`sweep`・`size`と
 * 受付の `open`・`get`・`isOpen`・`snapshot`）で期限を再判定する。タイマーは掃除の
 * きっかけに過ぎない。受付クローズは世代で不可逆に失効させ、開き直しても
 * 旧世代は復活しない。
 *
 * 比較コードの扱い: この記録器自体はコードを保持するが、構造化ログ・URL・
 * 永続保存に出す経路は作らない。呼び出し側（サーバ・CLI）もコードを
 * ログ・URL・永続保存に出さず、両画面への表示と照合にだけ使うこと。
 * 製品 API や CLI に固定コード機能は設けず、乱数は試験用の注入に限る。
 *
 * @packageDocumentation
 */
import { randomInt, randomUUID } from "node:crypto";
import {
  PAIRING_CODE_LENGTH,
  isPairingCode,
  type PairingCode,
  type PairingRequestId,
} from "bridge-protocol";
import type { BridgeLimits } from "./config.ts";
import { systemClock, type Clock } from "./clock.ts";

/**
 * 比較コードを生成する。ASCII 数字 `PAIRING_CODE_LENGTH` 文字で先頭ゼロを保持する。
 *
 * @returns 暗号学的乱数による比較コード。
 */
export function generatePairingCode(): PairingCode {
  // `randomInt` の上限は排他的であり、`10 ** PAIRING_CODE_LENGTH` 自体は出ない。
  const candidate = String(randomInt(10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, "0");
  // ADR: 生成直後の書式は不変条件として検査する。`isPairingCode` は型ガードの
  // ため、ここを通れば `PairingCode` への絞り込みが静的に効く。
  if (!isPairingCode(candidate)) {
    throw new Error("比較コードの生成結果が書式を満たさない。");
  }
  return candidate;
}

/**
 * 受付の開閉状態。
 */
export type AcceptanceState = "open" | "closed";

/**
 * 受付の世代つきスナップショット。`create` が単調期限・表示期限・世代を
 * 一括で取得するための原子的な読み取りである。
 */
export interface AcceptanceSnapshot {
  /** `open()` のたびに加算される世代。閉じても戻らない。 */
  readonly generation: number;
  /** 受付終了（単調時計）。期限の正本。 */
  readonly monotonicDeadline: number;
  /** 受付終了（壁時計ミリ秒・表示用）。 */
  readonly wallDeadline: number;
}

/**
 * 受付の公開状態。終了時刻は表示用、残時間は単調時計で算出する。
 */
export interface AcceptanceStatus {
  /** 受付が開いていれば `open`、閉じていれば `closed`。 */
  readonly state: AcceptanceState;
  /** 受付終了時刻（壁時計ミリ秒・表示用）。閉じていれば `null`。 */
  readonly endsAt: number | null;
  /** 受付の残時間（ミリ秒・単調時計で算出）。開いていれば正の整数（切り上げ）、閉じていれば `0`。 */
  readonly remainingMs: number;
}

/**
 * 受付操作の条件。
 */
export interface AcceptanceControllerOptions {
  /** 検証済みの制限値（`resolveLimits` 済み）。`acceptanceDurationMs` を使う。 */
  readonly limits: BridgeLimits;
  /** 時刻の取得口。省略時は既定時計を使う。 */
  readonly clock?: Clock;
}

/**
 * ペアリング要求の受付モード。
 *
 * 起動時は閉であり、ローカル操作で開くと `acceptanceDurationMs` で自動クローズ
 * する。開いている間の再操作は期限を更新せず現状を返す。`open()` のたびに
 * 新しい受付世代を開始する。
 *
 * 手動 `close()`・自動タイマー・入口で検出した期限切れのいずれでも、当該世代の
 * 保留は不可逆に失効する（論理的な終了は `close()` が戻るまでに成立させる。
 * 物理切断・WebSocket 操作はこのモジュールでは行わず、サーバ側の drain が担う）。
 * 開閉でレート履歴と要求 ID 採番は初期化しない。終了対象の保留を生存させる
 * 意味ではない。
 */
export class AcceptanceController {
  private readonly limits: BridgeLimits;
  private readonly clock: Clock;
  private openFlag = false;
  private deadlineMono: number | null = null;
  private endWall: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly closeListeners = new Set<() => void>();

  /**
   * @param options - 制限値と時刻の取得口。
   */
  constructor(options: AcceptanceControllerOptions) {
    this.limits = options.limits;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * 受付を開く。既に開いていれば期限を更新せず現状を返す。
   *
   * 閉じていた場合は新しい世代を開始する（世代 ID を加算する）。
   *
   * @returns 開いた後（または既に開いていた場合）の状態。
   */
  open(): AcceptanceStatus {
    this.refresh();
    if (this.openFlag) {
      // 再操作で延長しない。
      return this.status();
    }
    const monotonicNow = this.clock.monotonic();
    const wallNow = this.clock.now();
    this.generation += 1;
    this.openFlag = true;
    this.deadlineMono = monotonicNow + this.limits.acceptanceDurationMs;
    this.endWall = wallNow + this.limits.acceptanceDurationMs;
    this.armTimer();
    return this.status();
  }

  /**
   * 受付を閉じる。当該世代の保留は不可逆に失効する。
   *
   * 論理的な終了はこの呼び出しが戻るまでに成立させる（登録済みの
   * `onClose` 通知を同期的に送出する）。物理切断は待たないし行わない。
   * レート履歴と要求 ID 採番は初期化しない。
   *
   * @returns 閉じた後の状態。
   */
  close(): AcceptanceStatus {
    this.disarm();
    if (this.openFlag) {
      this.openFlag = false;
      this.deadlineMono = null;
      this.endWall = null;
      this.notifyClosed();
    } else {
      this.deadlineMono = null;
      this.endWall = null;
    }
    return this.status();
  }

  /**
   * 受付クローズの通知を受け取る。WebSocket 操作を持たせないこと。
   *
   * 通知は手動 `close()`・自動タイマー・入口で検出した期限切れのいずれでも
   * 同期的に送出する。失効の成立のみを保証し、物理切断の drain はサーバが担う。
   *
   * @param listener - 閉遷移時に同期的に呼ぶ処理。例外を投げないこと。
   * @returns 登録解除関数。
   */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /**
   * 現在の受付世代。`open()` のたびに加算され、閉じても戻らない。
   *
   * 遅延タイマーに依らず単調時計で再判定してから返す。
   *
   * @returns 受付世代（未開なら `0`）。
   */
  getGeneration(): number {
    this.refresh();
    return this.generation;
  }

  /**
   * 単調期限・表示期限・世代を一つのスナップショットとして取得する。
   *
   * 遅延タイマーに依らず単調時計で再判定してから読み取る。閉じていれば
   * `null` を返し、`null` 期限のフォールバック（発行＋既定秒など）は行わない。
   *
   * @returns 開いていれば世代つき期限、閉じていれば `null`。
   */
  snapshot(): AcceptanceSnapshot | null {
    this.refresh();
    if (!this.openFlag || this.deadlineMono === null || this.endWall === null) {
      return null;
    }
    return {
      generation: this.generation,
      monotonicDeadline: this.deadlineMono,
      wallDeadline: this.endWall,
    };
  }

  /**
   * 現在の受付状態。遅延タイマーに依らず単調時計で再判定する。
   *
   * @returns 現在の状態。
   */
  get(): AcceptanceStatus {
    this.refresh();
    return this.status();
  }

  /**
   * 受付が開いているか。遅延タイマーに依らず単調時計で再判定する。
   *
   * @returns 開いていれば真。
   */
  isOpen(): boolean {
    this.refresh();
    return this.openFlag;
  }

  /**
   * 保留期限の算出に使う受付終了（単調時計）。閉じていれば `null`。
   *
   * @returns 受付終了の単調時刻、または `null`。
   */
  getMonotonicDeadline(): number | null {
    this.refresh();
    return this.openFlag ? this.deadlineMono : null;
  }

  /**
   * 保留期限の表示に使う受付終了（壁時計）。閉じていれば `null`。
   *
   * @returns 受付終了の壁時計、または `null`。
   */
  getWallDeadline(): number | null {
    this.refresh();
    return this.openFlag ? this.endWall : null;
  }

  /**
   * 自動クローズのタイマーを仕掛ける。期限の正本は単調時計の再判定であり、
   * タイマーは掃除のきっかけに過ぎない。
   */
  private armTimer(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, this.limits.acceptanceDurationMs);
    // ADR: 長い受付時間が試験や待機の終了を妨げないよう、タイマーで
    // イベントループを保持しない。期限の正本は `refresh` の再判定である。
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 期限を再判定する。遅延タイマーや時計変更で延長されない。
   *
   * 開から閉への遷移を検出したら `onClose` 通知を同期的に送出する。
   */
  private refresh(): void {
    if (!this.openFlag || this.deadlineMono === null) {
      return;
    }
    if (this.clock.monotonic() >= this.deadlineMono) {
      this.disarm();
      this.openFlag = false;
      this.deadlineMono = null;
      this.endWall = null;
      this.notifyClosed();
    }
  }

  /**
   * 閉遷移の通知を同期的に送出する。失効の成立のみを保証し、
   * WebSocket 操作は行わない。
   */
  private notifyClosed(): void {
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }

  private status(): AcceptanceStatus {
    if (!this.openFlag || this.deadlineMono === null || this.endWall === null) {
      return { state: "closed", endsAt: null, remainingMs: 0 };
    }
    return {
      state: "open",
      endsAt: this.endWall,
      remainingMs: toDisplayMs(this.deadlineMono - this.clock.monotonic()),
    };
  }
}

/**
 * 表示・wire 用の残時間を正の整数ミリ秒に丸める。
 *
 * 単調時計（`performance.now()` など）は小数を返す場合があり、差分も小数に
 * なる。wire の `pairing_pending.expiresInMs` は正の安全な整数が契約のため、
 * 切り上げて整数化する。切り捨てでは 1ms 未満の残りが 0 になる。
 * 実失効判定（`now >= deadline`）には使わず、表示用のみである。
 *
 * @param rawMs - 単調時計の差分（ミリ秒）。
 * @returns `Math.ceil` した 1 以上の整数。
 */
function toDisplayMs(rawMs: number): number {
  return Math.max(1, Math.ceil(rawMs));
}

/**
 * 受付レートの判定結果。
 */
export type RateLimitVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** `Origin` 別の上限超過か全体の上限超過か。 */
      readonly reason: "ORIGIN_RATE_LIMITED" | "TOTAL_RATE_LIMITED";
    };

/**
 * 受付レートの条件。
 */
export interface PairingRateLimiterOptions {
  /** 検証済みの制限値（`resolveLimits` 済み）。窓と上限に使う。 */
  readonly limits: BridgeLimits;
  /** 時刻の取得口。省略時は既定時計を使う。 */
  readonly clock?: Clock;
}

/**
 * ペアリング受付のレート制限。
 *
 * `Origin` 別の上限と全体の上限を、直近 `pairingRateWindowMs`
 *（`(now-window, now]`）で独立に判定する。判定と記録は一体であり、許可した
 * 試行だけを履歴に残す。拒否した試行は履歴に追加しない（拒否の連打で履歴が
 * 無限に育たない）。受付の開閉でリセットしない。
 *
 * 計数単位は、接続前検証を通り受付中に届いた upgrade 試行であり、サーバ側が
 * その前提で呼ぶこと。窓の判定には単調時計を使う。
 */
export class PairingRateLimiter {
  private readonly limits: BridgeLimits;
  private readonly clock: Clock;
  private attempts: Array<{ readonly origin: string; readonly at: number }> = [];

  /**
   * @param options - 制限値と時刻の取得口。
   */
  constructor(options: PairingRateLimiterOptions) {
    this.limits = options.limits;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * 試行を判定し、許可した場合だけ記録する。
   *
   * @param origin - 試行元の `Origin`。
   * @returns 許可時は `{ allowed: true }`、超過時は理由付きの拒否。
   */
  checkAndRecord(origin: string): RateLimitVerdict {
    const counts = this.pruneAndCount(origin);
    if (counts.originCount >= this.limits.maxPairingRequestsPerOrigin) {
      return { allowed: false, reason: "ORIGIN_RATE_LIMITED" };
    }
    if (counts.totalCount >= this.limits.maxPairingRequestsTotal) {
      return { allowed: false, reason: "TOTAL_RATE_LIMITED" };
    }
    this.attempts.push({ origin, at: this.clock.monotonic() });
    return { allowed: true };
  }

  /**
   * 指定 `Origin` の直近窓の試行数。記録はしない。
   *
   * @param origin - 数える `Origin`。
   * @returns 窓に入る試行数。
   */
  countFor(origin: string): number {
    return this.pruneAndCount(origin).originCount;
  }

  /**
   * 全 `Origin` の直近窓の試行数。記録はしない。
   *
   * @returns 窓に入る試行数。
   */
  countTotal(): number {
    return this.pruneAndCount(undefined).totalCount;
  }

  /**
   * 窓外の履歴を捨て、窓内（`(now-window, now]`）を数える。
   *
   * 未来の記録（時計を戻した場合）は数えないが残し、窓外になるまで保持する。
   */
  private pruneAndCount(origin: string | undefined): {
    readonly originCount: number;
    readonly totalCount: number;
  } {
    const now = this.clock.monotonic();
    const windowStart = now - this.limits.pairingRateWindowMs;
    let originCount = 0;
    let totalCount = 0;
    const kept: Array<{ readonly origin: string; readonly at: number }> = [];
    for (const attempt of this.attempts) {
      if (attempt.at <= windowStart) {
        continue;
      }
      kept.push(attempt);
      if (attempt.at <= now) {
        totalCount += 1;
        if (origin !== undefined && attempt.origin === origin) {
          originCount += 1;
        }
      }
    }
    this.attempts = kept;
    return { originCount, totalCount };
  }
}

/**
 * 保留中のペアリング要求の公開内容。
 *
 * 比較コードを含む。呼び出し側はログ・URL・永続保存に出さず、両画面への
 * 表示と照合にだけ使うこと。
 */
export interface PendingPairing {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** 要求元の接続識別子。 */
  readonly connectionId: string;
  /** 要求元の `Origin`。 */
  readonly origin: string;
  /** ASCII 数字 `PAIRING_CODE_LENGTH` 文字の比較コード。 */
  readonly code: PairingCode;
  /** 発行時刻（壁時計ミリ秒・表示用）。 */
  readonly issuedAt: number;
  /** 承認期限（壁時計ミリ秒・表示用）。 */
  readonly expiresAt: number;
  /** 承認期限（単調時計）。`now >= deadline` は失効。 */
  readonly monotonicDeadline: number;
  /** 承認までの残時間（ミリ秒・読取時点の単調時計で算出。正の整数に切り上げ）。 */
  readonly remainingMs: number;
}

/**
 * 保留の作成結果。失敗理由を区別できる。
 */
export type PairingCreateResult =
  | {
      readonly status: "CREATED";
      /** 再利用しないペアリング要求の識別子。 */
      readonly requestId: PairingRequestId;
      /** 両画面に表示する比較コード。 */
      readonly code: PairingCode;
      /** 承認期限（壁時計ミリ秒・表示用）。 */
      readonly expiresAt: number;
      /** 承認までの残時間（ミリ秒。正の整数に切り上げ）。 */
      readonly expiresInMs: number;
    }
  | {
      readonly status: "ALREADY_PENDING";
      /** 既存の保留の要求識別子（期限の延長はしない）。 */
      readonly requestId: PairingRequestId;
    }
  | {
      /** 受付が閉じている・保留枠が満杯・コード生成に失敗した。 */
      readonly status: "ACCEPTANCE_CLOSED" | "PENDING_FULL" | "CODE_GENERATION_FAILED";
    };

/**
 * 承認結果。失敗理由を区別して監査できる。
 */
export type PairingApproveResult =
  | {
      readonly status: "APPROVED";
      /** 承認した要求の接続識別子。 */
      readonly connectionId: string;
      /** 承認した要求の `Origin`。 */
      readonly origin: string;
    }
  | {
      readonly status:
        | "NOT_PENDING"
        | "ACCEPTANCE_CLOSED"
        | "PAIRING_EXPIRED"
        | "INVALID_CODE"
        | "CODE_MISMATCH"
        | "CONNECTION_GONE"
        | "CONNECTION_CHECK_ERROR";
    };

/**
 * 拒否結果。
 */
export type PairingRejectResult =
  | { readonly status: "REJECTED" }
  | { readonly status: "NOT_PENDING" };

/**
 * 保留管理の条件。
 */
export interface PairingStoreOptions {
  /** 検証済みの制限値（`resolveLimits` 済み）。 */
  readonly limits: BridgeLimits;
  /** 時刻の取得口。省略時は既定時計を使う。 */
  readonly clock?: Clock;
  /** 受付モード。サーバ・CLI と共有すること。 */
  readonly acceptance: AcceptanceController;
  /**
   * 接続の生存確認。省略時は常に生存扱い。
   *
   * サーバ側は接続管理とつなぎ、切断済みの接続への承認を `CONNECTION_GONE`
   * で拒否すること。例外を投げた場合は承認せず対象を `CONNECTION_CHECK_ERROR`
   * として終了し、他要求に影響させない。
   */
  readonly isConnectionAlive?: (connectionId: string) => boolean;
  /**
   * 比較コードの生成関数。製品では暗号学的乱数を使うこと。
   *
   * 試験用の差し替え口であり、製品 API や CLI に固定コード機能は設けない。
   * 書式不正や衝突する値は再生成の試行として数える。
   */
  readonly generateCode?: () => string;
}

interface PairingEntry {
  readonly requestId: PairingRequestId;
  readonly connectionId: string;
  readonly origin: string;
  readonly code: PairingCode;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly monotonicDeadline: number;
  /** 作成時の受付世代。世代が変わるか受付が閉じると失効する。 */
  readonly generation: number;
}

/**
 * ペアリング要求の保留管理。
 *
 * 要求 ID は起動インスタンス ID＋単調カウンタで払い出し、削除後も再利用
 * しない（開閉で採番は初期化しない）。比較コードは暗号学的乱数で生成し、
 * 全 `Origin` の生存保留と重複検査して再生成し、上限回数で得られなければ
 * エントリを残さず失敗する。承認は一度だけ成功し、すべての確認を同期的に
 * 行う（途中で `await` しない）。
 *
 * 各エントリは作成時の受付世代を記録する。受付が閉じる（手動・自動・期限切れ
 * 検出）と当該世代の保留は不可逆に失効・除去され、開き直しても復活しない。
 * 論理的な終了は受付の `onClose` 通知で同期的に成立させる。WebSocket 操作は
 * 持たせない（物理切断の drain はサーバが担う）。
 */
export class PairingStore {
  private readonly limits: BridgeLimits;
  private readonly clock: Clock;
  private readonly acceptance: AcceptanceController;
  private readonly isConnectionAlive: (connectionId: string) => boolean;
  private readonly generateCode: () => string;
  private readonly entries = new Map<PairingRequestId, PairingEntry>();
  private readonly instanceId: string;
  private nextSequence = 0;

  /**
   * @param options - 制限値・時計・受付・生存確認・コード生成。
   */
  constructor(options: PairingStoreOptions) {
    this.limits = options.limits;
    this.clock = options.clock ?? systemClock;
    this.acceptance = options.acceptance;
    this.isConnectionAlive = options.isConnectionAlive ?? (() => true);
    this.generateCode = options.generateCode ?? generatePairingCode;
    // ADR: 要求 ID は起動ごとに異なる乱数と単調カウンタの組にする。
    // カウンタで同一起動内の再利用を防ぎ、乱数で起動間の衝突を防ぐ。
    // `randomUUID` は要求 ID の書式（`[A-Za-z0-9._-]`）に収まる。
    this.instanceId = randomUUID();
    // 受付クローズの論理的終了を同期的に成立させる。WebSocket 操作は行わない。
    this.acceptance.onClose(() => {
      this.entries.clear();
    });
  }

  /**
   * 保留を作成する。
   *
   * 同一接続の生存保留があれば新規作成せず `ALREADY_PENDING` を返し、期限の
   * 延長はしない。受付が閉じている・保留枠が満杯・コード生成に失敗した場合は
   * エントリを残さず失敗する。
   *
   * 単調期限・表示期限・世代は一つのスナップショットとして取得し、登録時にも
   * 同じ世代が有効なことを確認する。閉状態の `null` 期限を発行＋既定秒へ
   * フォールバックしない。実失効判定は単調時計を正本とする。
   *
   * @param connectionId - 要求元の接続識別子。
   * @param origin - 要求元の `Origin`。
   * @returns 作成結果。
   */
  create(connectionId: string, origin: string): PairingCreateResult {
    const first = this.acceptance.snapshot();
    this.purgeWith(first, this.clock.monotonic());
    if (first === null) {
      return { status: "ACCEPTANCE_CLOSED" };
    }
    for (const entry of this.entries.values()) {
      if (entry.connectionId === connectionId) {
        return { status: "ALREADY_PENDING", requestId: entry.requestId };
      }
    }
    if (this.entries.size >= this.limits.maxPendingPairings) {
      return { status: "PENDING_FULL" };
    }
    const liveCodes = new Set<PairingCode>();
    for (const entry of this.entries.values()) {
      liveCodes.add(entry.code);
    }
    let code: PairingCode | null = null;
    for (let attempt = 0; attempt < this.limits.maxPairingCodeGenerationAttempts; attempt += 1) {
      const candidate = this.generateCode();
      // 書式不正も衝突と同様に再生成の試行として数える。
      if (!isPairingCode(candidate) || liveCodes.has(candidate)) {
        continue;
      }
      code = candidate;
      break;
    }
    if (code === null) {
      return { status: "CODE_GENERATION_FAILED" };
    }
    // コード生成中に受付が閉じる・世代が変わる場合があるため、発行時刻と
    // 受付スナップショットを取り直して同じ世代の有効性を確認する。
    const issuedMono = this.clock.monotonic();
    const issuedWall = this.clock.now();
    const second = this.acceptance.snapshot();
    if (second === null || second.generation !== first.generation) {
      return { status: "ACCEPTANCE_CLOSED" };
    }
    const monotonicDeadline = Math.min(
      issuedMono + this.limits.pairingApprovalTimeoutMs,
      second.monotonicDeadline,
    );
    if (monotonicDeadline <= issuedMono) {
      // 受付終了が実質的に到来している。期限切れの保留は作らない。
      return { status: "ACCEPTANCE_CLOSED" };
    }
    const expiresAt = Math.min(
      issuedWall + this.limits.pairingApprovalTimeoutMs,
      second.wallDeadline,
    );
    this.nextSequence += 1;
    const requestId: PairingRequestId = `pairing-${this.instanceId}-${this.nextSequence}`;
    this.entries.set(requestId, {
      requestId,
      connectionId,
      origin,
      code,
      issuedAt: issuedWall,
      expiresAt,
      monotonicDeadline,
      generation: second.generation,
    });
    return {
      status: "CREATED",
      requestId,
      code,
      expiresAt,
      expiresInMs: toDisplayMs(monotonicDeadline - issuedMono),
    };
  }

  /**
   * 保留を承認する。受付の開放・期限内・ID 一致・コード一致・接続生存の
   * すべてを確認して一度だけ成功する（原子性。途中で `await` しない）。
   *
   * 閉じた世代の要求は `NOT_PENDING` とし、開き直しても復活しない。生存判定が
   * 例外を投げた場合は承認せず、対象要求を内部エラーとして終了する
   * （`CONNECTION_CHECK_ERROR`。生存不明を `CONNECTION_GONE` と断定しない）。
   *
   * @param requestId - 承認する要求の識別子。
   * @param code - 照合する比較コード。
   * @returns 承認結果。
   */
  approve(requestId: string, code: string): PairingApproveResult {
    // ADR: 一括掃除を先に行うと対象の期限切れが `NOT_PENDING` に化けるため、
    // 対象エントリの失効はここで明示的に判定する。閉世代の対象は `NOT_PENDING`
    // とし、開き直しても復活させない。
    const entry = this.entries.get(requestId);
    const snapshot = this.acceptance.snapshot();
    const now = this.clock.monotonic();
    if (entry === undefined) {
      this.purgeWith(snapshot, now);
      return { status: "NOT_PENDING" };
    }
    if (snapshot === null || entry.generation !== snapshot.generation) {
      // 受付クローズで失効した世代は不可逆に除去する。
      this.entries.delete(entry.requestId);
      this.purgeWith(snapshot, now);
      return { status: "NOT_PENDING" };
    }
    if (now >= entry.monotonicDeadline) {
      this.entries.delete(entry.requestId);
      return { status: "PAIRING_EXPIRED" };
    }
    if (!isPairingCode(code)) {
      return { status: "INVALID_CODE" };
    }
    if (entry.code !== code) {
      return { status: "CODE_MISMATCH" };
    }
    let alive: boolean;
    try {
      alive = this.isConnectionAlive(entry.connectionId);
    } catch {
      // 生存不明を切断済みと断定せず、対象だけを内部エラーとして終了する。
      this.entries.delete(entry.requestId);
      return { status: "CONNECTION_CHECK_ERROR" };
    }
    if (!alive) {
      // 死んだ接続に紐付く保留は再利用できないため終わらせる。
      this.entries.delete(entry.requestId);
      return { status: "CONNECTION_GONE" };
    }
    this.entries.delete(entry.requestId);
    return { status: "APPROVED", connectionId: entry.connectionId, origin: entry.origin };
  }

  /**
   * 保留を拒否する。期限切れ・失効世代・未知の要求は `NOT_PENDING` とする。
   *
   * @param requestId - 拒否する要求の識別子。
   * @returns 拒否結果。
   */
  reject(requestId: string): PairingRejectResult {
    this.sweep();
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return { status: "NOT_PENDING" };
    }
    this.entries.delete(entry.requestId);
    return { status: "REJECTED" };
  }

  /**
   * 保留を取り除く（接続切断時などの内部掃除用）。期限切れも含めて取り除く。
   *
   * 失効世代の掃除を先に行うため、既に失効した要求は `false` を返す。
   *
   * @param requestId - 取り除く要求の識別子。
   * @returns 取り除いた場合に真。
   */
  remove(requestId: string): boolean {
    this.sweep();
    return this.entries.delete(requestId);
  }

  /**
   * 保留を取得する。期限切れ・失効世代は取り除き `undefined` を返す。
   *
   * @param requestId - 取得する要求の識別子。
   * @returns 生存中の保留、または `undefined`。
   */
  get(requestId: string): PendingPairing | undefined {
    this.sweep();
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return undefined;
    }
    return this.toPublic(entry);
  }

  /**
   * 生存中の保留の一覧。期限切れ・失効世代は取り除く。
   *
   * @returns 生存中の保留。
   */
  list(): PendingPairing[] {
    this.sweep();
    return [...this.entries.values()].map((entry) => this.toPublic(entry));
  }

  /**
   * 生存中の保留数。期限切れ・失効世代は取り除いてから数える。
   *
   * @returns 生存中の保留数。
   */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  /**
   * 期限切れ・失効世代の保留を掃除する。
   *
   * 受付が閉じていれば全エントリを除去し、開いていれば現世代以外の
   * エントリと期限切れを除去する。開き直しても旧世代は復活しない。
   *
   * @returns 取り除いた件数。
   */
  sweep(): number {
    return this.purgeWith(this.acceptance.snapshot(), this.clock.monotonic());
  }

  /**
   * スナップショットに基づき失効世代・期限切れを除去する。
   *
   * @param snapshot - 受付の原子スナップショット。閉じていれば `null`。
   * @param now - 除去判定に使う単調時刻。
   * @returns 取り除いた件数。
   */
  private purgeWith(snapshot: AcceptanceSnapshot | null, now: number): number {
    let removed = 0;
    for (const [requestId, entry] of this.entries) {
      if (snapshot === null || entry.generation !== snapshot.generation) {
        this.entries.delete(requestId);
        removed += 1;
        continue;
      }
      if (now >= entry.monotonicDeadline) {
        this.entries.delete(requestId);
        removed += 1;
      }
    }
    return removed;
  }

  private toPublic(entry: PairingEntry): PendingPairing {
    return {
      requestId: entry.requestId,
      connectionId: entry.connectionId,
      origin: entry.origin,
      code: entry.code,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
      monotonicDeadline: entry.monotonicDeadline,
      remainingMs: toDisplayMs(entry.monotonicDeadline - this.clock.monotonic()),
    };
  }
}
