/**
 * 比較コード方式の保留管理・受付トグル・受付レート。
 *
 * ブリッジ（信頼側 PC）が比較コードを発行し、ワールド画面と PC の両方に
 * 表示して人間が照合する。コード一致は UI に表示された要求との対応確認で
 * あり、ワールドの真正性の証明ではない（「OTP 認証」ではない）。
 * 詳しい設計判断は `design/bridge-connection.md` の候補節を見る。
 *
 * 受付は有効/無効の2状態のトグルであり、時間での自動失効を持たない。
 * 保留中の要求も時間で失効せず、手動の承認/拒否か切断、または受付の無効化
 * まで生存する。無効化で終わった要求は、再有効化しても復活しない。
 *
 * 比較コードの扱い: この記録器自体はコードを保持するが、構造化ログ・URL・
 * 永続保存に出す経路は作らない。呼び出し側（サーバ・CLI）もコードを
 * ログ・URL・永続保存に出さず、両画面への表示と人間による目視照合にだけ
 * 使い、承認の照合・資格情報には使わないこと。
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
 * 受付の公開状態。有効/無効の2状態だけを持ち、残時間・終了時刻は持たない。
 */
export interface AcceptanceInfo {
  /** 受付が有効であれば真。 */
  readonly enabled: boolean;
}

/**
 * ペアリング要求の受付トグル。
 *
 * 起動時は無効であり、ローカル操作で有効/無効を切り替える。タイマーを持たず、
 * 時間経過では状態も保留も変わらない。再操作は冪等であり、状態が変わらない
 * 場合は世代も通知も動かさない。有効化のたびに新しい受付世代を開始する
 * （世代 ID を加算する）。
 *
 * 無効化では当該世代の保留を不可逆に失効させる（論理的な終了は `disable()` が
 * 戻るまでに成立させる。物理切断・WebSocket 操作はこのモジュールでは行わず、
 * サーバ側の drain が担う）。開閉でレート履歴と要求 ID 採番は初期化しない。
 * 終了対象の保留を生存させる意味ではない。
 */
export class AcceptanceController {
  private enabledFlag = false;
  private generation = 0;
  private readonly closeListeners = new Set<() => void>();

  /**
   * 受付を有効にする。既に有効であれば何も変えず現状を返す。
   *
   * 無効から有効への遷移時のみ新しい世代を開始する（世代 ID を加算する）。
   *
   * @returns 有効化後（または既に有効だった場合）の状態。
   */
  enable(): AcceptanceInfo {
    if (this.enabledFlag) {
      return { enabled: true };
    }
    this.generation += 1;
    this.enabledFlag = true;
    return { enabled: true };
  }

  /**
   * 受付を無効にする。当該世代の保留は不可逆に失効する。
   *
   * 論理的な終了はこの呼び出しが戻るまでに成立させる（登録済みの
   * `onClose` 通知を同期的に送出する）。物理切断は待たないし行わない。
   * 既に無効であれば通知を送らず現状を返す。レート履歴と要求 ID 採番は
   * 初期化しない。
   *
   * @returns 無効化後の状態。
   */
  disable(): AcceptanceInfo {
    if (this.enabledFlag) {
      this.enabledFlag = false;
      this.notifyClosed();
    }
    return { enabled: false };
  }

  /**
   * 受付無効化の通知を受け取る。WebSocket 操作を持たせないこと。
   *
   * 通知は有効から無効への遷移時にだけ同期的に送出する。失効の成立のみを
   * 保証し、物理切断の drain はサーバが担う。
   *
   * @param listener - 無効遷移時に同期的に呼ぶ処理。例外を投げないこと。
   * @returns 登録解除関数。
   */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /**
   * 現在の受付状態。
   *
   * @returns 現在の状態。
   */
  get(): AcceptanceInfo {
    return { enabled: this.enabledFlag };
  }

  /**
   * 受付が有効か。
   *
   * @returns 有効であれば真。
   */
  isEnabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * 有効時の受付世代を原子的に取得する。
   *
   * `create` が開始時と登録直前の世代一致を確認するための内部読み取りであり、
   * 公開 API には世代を出さない。無効であれば `null` を返す。
   *
   * @returns 有効であれば世代、無効であれば `null`。
   */
  snapshot(): { readonly generation: number } | null {
    if (!this.enabledFlag) {
      return null;
    }
    return { generation: this.generation };
  }

  /**
   * 無効遷移の通知を同期的に送出する。失効の成立のみを保証し、
   * WebSocket 操作は行わない。
   */
  private notifyClosed(): void {
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }
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
 * 無限に育たない）。受付の有効/無効の切替でリセットしない。
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
 * 表示と人間による目視照合にだけ使い、承認の照合・資格情報には使わないこと。
 * 時間での失効を持たない。
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
    }
  | {
      readonly status: "ALREADY_PENDING";
      /** 既存の保留の要求識別子。 */
      readonly requestId: PairingRequestId;
    }
  | {
      /** 受付が無効・保留枠が満杯・コード生成に失敗した。 */
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
      readonly status: "NOT_PENDING" | "CONNECTION_GONE" | "CONNECTION_CHECK_ERROR";
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
  /** 受付トグル。サーバ・CLI と共有すること。 */
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
  /** 作成時の受付世代。世代が変わるか受付が無効になると失効する。 */
  readonly generation: number;
}

/**
 * ペアリング要求の保留管理。
 *
 * 要求 ID は起動インスタンス ID＋単調カウンタで払い出し、削除後も再利用
 * しない（切替で採番は初期化しない）。比較コードは暗号学的乱数で生成し、
 * 全 `Origin` の生存保留と重複検査して再生成し、上限回数で得られなければ
 * エントリを残さず失敗する。承認は一度だけ成功し、すべての確認を同期的に
 * 行う（途中で `await` しない）。
 *
 * 各エントリは作成時の受付世代を記録する。受付の無効化で当該世代の保留は
 * 不可逆に失効・除去され、再有効化しても復活しない。論理的な終了は受付の
 * `onClose` 通知で同期的に成立させる。WebSocket 操作は持たせない
 * （物理切断の drain はサーバが担う）。時間での失効は持たない。
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
    // 受付無効化の論理的終了を同期的に成立させる。WebSocket 操作は行わない。
    this.acceptance.onClose(() => {
      this.entries.clear();
    });
  }

  /**
   * 保留を作成する。
   *
   * 同一接続の生存保留があれば新規作成せず `ALREADY_PENDING` を返す。
   * 受付が無効・保留枠が満杯・コード生成に失敗した場合はエントリを残さず
   * 失敗する。時間での失効を持たない。
   *
   * 受付世代は開始時と登録直前に確認し、コード生成中に無効化→再有効化が
   * 起きても旧世代としては登録しない（不正な作成を防ぐ）。
   *
   * @param connectionId - 要求元の接続識別子。
   * @param origin - 要求元の `Origin`。
   * @returns 作成結果。
   */
  create(connectionId: string, origin: string): PairingCreateResult {
    const first = this.acceptance.snapshot();
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
    // コード生成中に受付が無効化→再有効化する場合があるため、受付世代を
    // 取り直して同じ世代の有効性を確認する。世代が変わっていれば登録しない。
    const second = this.acceptance.snapshot();
    if (second === null || second.generation !== first.generation) {
      return { status: "ACCEPTANCE_CLOSED" };
    }
    const issuedWall = this.clock.now();
    this.nextSequence += 1;
    const requestId: PairingRequestId = `pairing-${this.instanceId}-${this.nextSequence}`;
    this.entries.set(requestId, {
      requestId,
      connectionId,
      origin,
      code,
      issuedAt: issuedWall,
      generation: second.generation,
    });
    return {
      status: "CREATED",
      requestId,
      code,
    };
  }

  /**
   * 保留を承認する。要求 ID の一致と接続生存だけを確認して
   * 一度だけ成功する（原子性。途中で `await` しない）。
   *
   * 比較コードの照合は行わない。コードの生成・両画面への表示・
   * 人間による目視照合は維持するが、承認操作の引数には含めない。
   *
   * 無効化で失効した世代の要求は `NOT_PENDING` とし、再有効化しても復活
   * しない。生存判定が例外を投げた場合は承認せず、対象要求を内部エラー
   * として終了する（`CONNECTION_CHECK_ERROR`。生存不明を `CONNECTION_GONE`
   * と断定しない）。
   *
   * 生存確認の後に、対象が同じ保留として残っていることを再確認してから
   * 承認する（確認中の切断・無効化で不正承認を成立させない）。
   *
   * @param requestId - 承認する要求の識別子。
   * @returns 承認結果。
   */
  approve(requestId: string): PairingApproveResult {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return { status: "NOT_PENDING" };
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
    // ADR: 生存確認の実行中に切断・無効化が割り込むと、確認結果が古くなる。
    // 同期呼び出しでも確認口の再入で除去されうるため、同じ保留が残って
    // いることを再確認してから承認し、不正承認を成立させない。
    if (this.entries.get(requestId) !== entry) {
      return { status: "NOT_PENDING" };
    }
    this.entries.delete(entry.requestId);
    return { status: "APPROVED", connectionId: entry.connectionId, origin: entry.origin };
  }

  /**
   * 保留を拒否する。未知の要求は `NOT_PENDING` とする。
   *
   * @param requestId - 拒否する要求の識別子。
   * @returns 拒否結果。
   */
  reject(requestId: string): PairingRejectResult {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return { status: "NOT_PENDING" };
    }
    this.entries.delete(entry.requestId);
    return { status: "REJECTED" };
  }

  /**
   * 保留を取り除く（接続切断時などの内部掃除用）。
   *
   * @param requestId - 取り除く要求の識別子。
   * @returns 取り除いた場合に真。
   */
  remove(requestId: string): boolean {
    return this.entries.delete(requestId);
  }

  /**
   * 保留を取得する。
   *
   * @param requestId - 取得する要求の識別子。
   * @returns 生存中の保留、または `undefined`。
   */
  get(requestId: string): PendingPairing | undefined {
    const entry = this.entries.get(requestId);
    if (entry === undefined) {
      return undefined;
    }
    return this.toPublic(entry);
  }

  /**
   * 生存中の保留の一覧。
   *
   * @returns 生存中の保留。
   */
  list(): PendingPairing[] {
    return [...this.entries.values()].map((entry) => this.toPublic(entry));
  }

  /**
   * 生存中の保留数。
   *
   * @returns 生存中の保留数。
   */
  size(): number {
    return this.entries.size;
  }

  private toPublic(entry: PairingEntry): PendingPairing {
    return {
      requestId: entry.requestId,
      connectionId: entry.connectionId,
      origin: entry.origin,
      code: entry.code,
      issuedAt: entry.issuedAt,
    };
  }
}
