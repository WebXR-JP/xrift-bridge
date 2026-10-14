/**
 * ブリッジ接続の診断手順。React・R3F に依存しない。
 *
 * 接続は `connect` 呼び出し時のみ行い、自動接続・自動再接続・自動再送は
 * しない。接続開始は `createConnectionRequest` が返す2つの約束で行う。
 * 比較コード（`pairingInfo`）は画面表示のみに使い、認可成立は
 * `sessionProvider` の解決で判定する。認可後は reliable 双方向の
 * `diag-echo`・`diag-ping` を開き、診断相当の往復だけを行う。
 * 秘密値は扱わない（ワールド側で入力・保持しない）。ブリッジが
 * 発行する比較コードは画面表示のみに使い、診断結果（`toResultJson`）・
 * ログ・永続保存には含めない（表示した事実のみ残してよい）。
 *
 * @packageDocumentation
 */
import {
  WorldClientError,
  createConnectionRequest as defaultCreateConnectionRequest,
  parseBridgeEndpoint,
  type ConnectOptions,
  type ConnectionRequest,
  type PairingInfo,
  type ReliableSession,
  type SessionProvider,
} from "world-client";
import type { DiagnosticBuildInfo } from "../build-info.ts";

/** echo 往復に使う Session の論理名。 */
export const ECHO_SESSION_ID = "diag-echo";

/** ping に使う Session の論理名。 */
export const PING_SESSION_ID = "diag-ping";

/**
 * echo・ping の応答待ちの上限（ミリ秒）。
 *
 * 診断が所有する待機時間であり、bridge の承認待ち期限とは別物である。
 */
export const DIAGNOSTIC_PROBE_TIMEOUT_MS = 10_000;

/** 診断のおおまかな進行。 */
export type DiagnosticPhase = "idle" | "connecting" | "awaiting_approval" | "authorized" | "ended";

/** 診断が管理する接続状態。`world-client` の内部状態は公開しない。 */
export type DiagnosticConnectionState =
  | "disconnected"
  | "awaiting_pairing"
  | "awaiting_approval"
  | "authorized"
  | "closed";

/** 比較コードの表示用情報。画面表示のみに使い、証拠には含めない。 */
export interface PairingView {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: string;
  /** ASCII 数字 6 文字の比較コード。 */
  readonly code: string;
}

/** 診断実行時の自ウィンドウの環境。呼び出し側が一度だけ採取する。 */
export interface DiagnosticEnv {
  /** 自ウィンドウの `location.origin`。 */
  readonly origin: string;
  /** 自ウィンドウの `isSecureContext`。 */
  readonly secureContext: boolean;
  /** top-level（`window.top === window.self`）か。 */
  readonly topLevel: boolean;
}

/** 表示・証拠用のエラー内容。 */
export interface DiagnosticErrorView {
  /** 機械可読の符号。 */
  readonly code: string;
  /** 人間可読の説明。 */
  readonly message: string;
  /** 次の一手。該当なしは `undefined`。 */
  readonly hint?: string;
}

/** echo 往復の表示内容。payload 本文・wire 連番は保持しない。 */
export interface EchoView {
  readonly status: "none" | "running" | "matched" | "mismatched" | "failed" | "unknown";
  /** 診断が採番した操作番号。wire の連番ではない。 */
  readonly opNo?: number;
  /** 送信 payload の UTF-8 バイト数。本文は保持しない。 */
  readonly bytes?: number;
  /** 送信から相関応答までの往復時間（ミリ秒）。 */
  readonly rttMs?: number;
  /** 失敗・結果不明時の内容。 */
  readonly error?: DiagnosticErrorView;
}

/** ping の表示内容。 */
export interface PingView {
  readonly status: "none" | "running" | "pong" | "failed" | "unknown";
  /** 診断が採番した操作番号。wire の連番ではない。 */
  readonly opNo?: number;
  /** 送信から応答までの往復時間（ミリ秒）。 */
  readonly rttMs?: number;
  /** 失敗・結果不明時の内容。 */
  readonly error?: DiagnosticErrorView;
}

/** 購読者へ配る診断の写し。秘密値・payload 本文・比較コード本文は含まない。 */
export interface DiagnosticSnapshot {
  readonly phase: DiagnosticPhase;
  readonly connectionState: DiagnosticConnectionState;
  readonly endpoint: string;
  /** 表示中の比較コード。画面表示のみに使う。証拠には含めない。 */
  readonly pairing: PairingView | null;
  readonly lastError: DiagnosticErrorView | null;
  readonly echo: EchoView;
  readonly ping: PingView;
  readonly env: DiagnosticEnv;
  readonly build: DiagnosticBuildInfo;
}

/** 快照を受け取る購読者。 */
export type DiagnosticListener = (snapshot: DiagnosticSnapshot) => void;

/** 接続開始の差し替え口。試験ではスタブの管理口を返す実装を渡す。 */
export type CreateConnectionRequestFn = (options: ConnectOptions) => ConnectionRequest;

/** セッション生成時の設定。 */
export interface DiagnosticSessionOptions {
  /** ブリッジの接続先。`ws://127.0.0.1:<port>/v1` のみ受け付ける。 */
  readonly endpoint: string;
  /** 診断実行時の自ウィンドウの環境。 */
  readonly env: DiagnosticEnv;
  /** 実行ビルドの識別子。 */
  readonly build: DiagnosticBuildInfo;
  /** 接続開始の実装。省略時は製品の `createConnectionRequest` を使う。 */
  readonly createRequest?: CreateConnectionRequestFn;
  /**
   * echo・ping の応答待ちの上限（ミリ秒）。
   *
   * 省略時は `DIAGNOSTIC_PROBE_TIMEOUT_MS` を使う。試験で短縮する場合に指定する。
   */
  readonly probeTimeoutMs?: number;
}

/**
 * エラー符号に対応する次の一手を返す。
 *
 * @param code - 機械可読の符号。
 * @returns 次の一手。該当なしは `undefined`。
 */
export function errorHint(code: string): string | undefined {
  if (code === "PAIRING_REJECTED") {
    return (
      "bridge 側で承認が拒否された。新規に接続開始して表示された比較コードを照合し、" +
      "bridge 側で承認し直すこと。"
    );
  }
  if (code === "ACCEPTANCE_CLOSED") {
    return "bridge の受付が有効でない。bridge の状態を確認してから再試行すること。";
  }
  if (code === "PENDING_FULL") {
    return "bridge の承認待ちが満杯である。不要な承認待ちを片付けてから新規に接続開始すること。";
  }
  if (code === "CODE_GENERATION_FAILED") {
    return "比較コードの生成に失敗した。bridge の状態を確認して新規に接続開始すること。";
  }
  if (code === "DUPLICATE_PAIRING_START") {
    return "開始要求が重複した。接続状態を確認し、必要なら取消してから再試行すること。";
  }
  if (code === "CONNECT_CANCELLED") {
    return "接続試行を取り消した。再試行する場合は新規に接続開始すること。";
  }
  if (code === "ORIGIN_RATE_LIMITED") {
    return "同一 Origin からの接続試行が多い。少し待ってから新規に接続開始すること。";
  }
  if (code === "TOTAL_RATE_LIMITED") {
    return "bridge への接続試行が多い。少し待ってから新規に接続開始すること。";
  }
  if (code === "TOO_MANY_CONNECTIONS") {
    return "bridge の同時接続数が上限である。不要な接続を閉じてから再試行すること。";
  }
  if (code === "TOO_MANY_UNAUTHORIZED") {
    return "bridge の未認可接続数が上限である。承認待ちを片付けてから再試行すること。";
  }
  if (code === "NOT_PENDING") {
    return "対象の承認待ちが見当たらない。既に失効・処理済みのため新規に接続開始すること。";
  }
  if (code === "CONNECTION_GONE") {
    return "承認対象の接続が失われた。新規に接続開始すること。";
  }
  if (code === "CONNECTION_CHECK_ERROR") {
    return "接続確認に失敗した。bridge の状態を確認して新規に接続開始すること。";
  }
  if (code === "UNEXPECTED_DIRECTION") {
    return "想定外の方向のメッセージである。bridge と診断の版を確認して新規に接続開始すること。";
  }
  if (code === "SESSION_MISMATCH") {
    return "セッション識別子が一致しない。新規に接続開始すること。";
  }
  if (code === "INVALID_JSON" || code === "INVALID_MESSAGE") {
    return "受信メッセージが不正である。版の一致を確認して新規に接続開始すること。";
  }
  if (code === "VERSION_MISMATCH") {
    return "protocol の版が一致しない。bridge と診断の版を確認してそろえること。";
  }
  if (code === "UNKNOWN_TYPE") {
    return "未知のメッセージ種別である。bridge と診断の版を確認して新規に接続開始すること。";
  }
  if (code === "UNEXPECTED_BINARY" || code === "UNEXPECTED_MESSAGE") {
    return "認可前後の受信順序が想定外である。bridge と診断の版を確認して新規に接続開始すること。";
  }
  if (code === "MUX_FAILURE") {
    return "認可後の多重化を開始できない。bridge の状態を確認して新規に接続開始すること。";
  }
  if (code === "PROBE_TIMEOUT") {
    return "応答が時間内に返らない。bridge の診断応答を確認して再実行すること。";
  }
  if (code === "RESULT_UNKNOWN") {
    return "応答待ちのまま終了したため結果は不明である。新規に接続開始して再実行すること。";
  }
  if (code === "CONNECTION_CLOSED" || code.startsWith("CLOSED_")) {
    return "切断された。再接続には新規の接続開始が必要である（自動再接続はしない）。";
  }
  if (code === "NOT_AUTHORIZED" || code === "NOT_CONNECTED" || code === "NOT_CONNECTING") {
    return "未認証のため操作できない。先に接続開始し、比較コードを承認して認証すること。";
  }
  return undefined;
}

/** echo 要求1件の待機内容。診断が所有する相関表の1行である。 */
interface EchoPending {
  /** 診断が採番した操作番号。 */
  readonly opNo: number;
  /** 送出した `value`（乱数トークン）。本文はここにだけ留める。 */
  readonly value: string;
  /** 送信 payload の UTF-8 バイト数。 */
  readonly bytes: number;
  /** 送信時刻（ミリ秒）。 */
  readonly startedAt: number;
  /** 相関応答で真偽を渡す。 */
  readonly resolve: (matched: boolean) => void;
  /** 待機打ち切り・終了時の結果不明で失敗を渡す。 */
  readonly reject: (error: WorldClientError) => void;
  /** 応答待ちの時限。 */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** ping 要求1件の待機内容。診断 payload 内の明示 `id` で対応付ける。 */
interface PingPending {
  /** 診断が採番した操作番号。 */
  readonly opNo: number;
  /** 送信時刻（ミリ秒）。 */
  readonly startedAt: number;
  /** 同 `id` の `pong` 到達で真を渡す。 */
  readonly resolve: (ok: boolean) => void;
  /** 待機打ち切り・終了時の結果不明で失敗を渡す。 */
  readonly reject: (error: WorldClientError) => void;
  /** 応答待ちの時限。 */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 接続開始の決着口。`connect` の戻り約束と対になる。 */
interface ConnectSettlement {
  /** 認可成立（応答用 Session の準備完了）で解決する。 */
  readonly resolve: () => void;
  /** 失敗・取消で拒否する。 */
  readonly reject: (error: WorldClientError) => void;
}

/** 診断手順のセッション。接続・タイマー・購読を所有し、`dispose` で終える。 */
export class DiagnosticSession {
  private readonly endpoint: string;
  private readonly env: DiagnosticEnv;
  private readonly build: DiagnosticBuildInfo;
  private readonly createRequest: CreateConnectionRequestFn;
  private readonly probeTimeoutMs: number;
  private readonly listeners = new Set<DiagnosticListener>();
  private phase: DiagnosticPhase = "idle";
  private connectionState: DiagnosticConnectionState = "disconnected";
  private pairing: PairingView | null = null;
  private lastError: DiagnosticErrorView | null = null;
  private echo: EchoView = { status: "none" };
  private ping: PingView = { status: "none" };
  private aborter: AbortController | null = null;
  private provider: SessionProvider | null = null;
  private echoSession: ReliableSession | null = null;
  private pingSession: ReliableSession | null = null;
  private readonly echoUnsubs: Array<() => void> = [];
  private readonly pingUnsubs: Array<() => void> = [];
  private providerUnsub: (() => void) | null = null;
  private readonly echoPending = new Map<string, EchoPending>();
  private readonly pingPending = new Map<string, PingPending>();
  private opCounter = 0;
  private connectSettlement: ConnectSettlement | null = null;
  private closeInitiated = false;
  private disposed = false;

  /**
   * セッションを生成する。接続は `connect` まで行わない。
   *
   * @param options - 接続先・環境・ビルド識別子。
   * @throws `RangeError` — `endpoint` が正規の loopback 接続先でない場合。
   */
  constructor(options: DiagnosticSessionOptions) {
    this.endpoint = parseBridgeEndpoint(options.endpoint);
    this.env = options.env;
    this.build = options.build;
    this.createRequest = options.createRequest ?? defaultCreateConnectionRequest;
    const probeTimeoutMs = options.probeTimeoutMs ?? DIAGNOSTIC_PROBE_TIMEOUT_MS;
    if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs <= 0) {
      throw new RangeError("応答待ちの上限は正の整数（ミリ秒）であること。");
    }
    this.probeTimeoutMs = probeTimeoutMs;
  }

  /** 現在の診断の写しを返す。秘密値・payload 本文・比較コード本文は含まない。 */
  getSnapshot(): DiagnosticSnapshot {
    return {
      phase: this.phase,
      connectionState: this.connectionState,
      endpoint: this.endpoint,
      pairing: this.pairing === null ? null : { ...this.pairing },
      lastError: this.lastError,
      echo: { ...this.echo },
      ping: { ...this.ping },
      env: this.env,
      build: this.build,
    };
  }

  /**
   * 認可済みのセッション管理口を返す。テキスト専用セッションの生成だけに使う。
   *
   * 所有権は移転しない。呼び出し側は `close` しないこと。テキスト受信の生成は
   * 3D盤側だけが行い、開発 DOM パネル側では呼ばない。認可前・切断後・破棄済みは
   * `null` を返す。
   *
   * @returns 認可中で生存している場合の管理口。それ以外は `null`。
   */
  getAuthorizedProvider(): SessionProvider | null {
    if (this.disposed) return null;
    if (this.phase !== "authorized") return null;
    const provider = this.provider;
    if (provider === null || !provider.isAlive) return null;
    return provider;
  }

  /**
   * 診断の写しを購読する。戻り値で解除できる。
   *
   * @param listener - 写しを受け取る購読者。
   * @returns 購読の解除関数。
   */
  subscribe(listener: DiagnosticListener): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 接続を開始し、比較コードの発行を受けて人間の承認成立を待つ。ボタン操作時のみ呼ぶこと。
   *
   * 秘密値は扱わない。比較コード受信待ちに時限は設けず、取消は `cancel`、
   * 通信失敗はソケットの close 通知で扱う。応答用 Session（`diag-echo`・
   * `diag-ping`）の準備完了で成功する。
   *
   * @returns 認可成立時に解決する。
   * @throws `WorldClientError` — 進行中・認証済み・破棄済みの場合。
   */
  async connect(): Promise<void> {
    this.assertActive();
    if (this.phase === "connecting" || this.phase === "awaiting_approval") {
      throw new WorldClientError("SESSION_BUSY", "接続処理が進行中である。");
    }
    if (this.phase === "authorized") {
      throw new WorldClientError("ALREADY_CONNECTED", "既に認証済みである。");
    }
    this.teardownTransport();
    this.phase = "connecting";
    this.connectionState = "awaiting_pairing";
    this.pairing = null;
    this.lastError = null;
    this.echo = { status: "none" };
    this.ping = { status: "none" };
    this.closeInitiated = false;
    this.emit();
    const aborter = new AbortController();
    this.aborter = aborter;
    // ADR: `origin` は渡さない。ブラウザではブラウザが付与する `Origin` を
    // 使い、Node 診断用途の明示指定は Unit F（実ネットワーク）の責務とする。
    // ここで渡すと DOM の overload と食い違うため渡さない。
    const request = this.createRequest({
      endpoint: this.endpoint,
      signal: aborter.signal,
    });
    const settlement = new Promise<void>((resolve, reject) => {
      this.connectSettlement = { resolve, reject };
    });
    void request.pairingInfo.then(
      (info) => {
        this.handlePairingInfo(info);
      },
      (error: unknown) => {
        this.handleConnectFailure(error);
      },
    );
    void request.sessionProvider.then(
      (provider) => {
        void this.handleSessionProvider(provider);
      },
      (error: unknown) => {
        this.handleConnectFailure(error);
      },
    );
    return settlement;
  }

  /**
   * 待機中の接続試行を取り消す。承認待ちの表示は消える。
   *
   * @throws `WorldClientError` — 破棄済み・待機中でない場合。
   */
  cancel(): void {
    this.assertActive();
    if (this.phase !== "connecting" && this.phase !== "awaiting_approval") {
      throw new WorldClientError("NOT_CONNECTING", "取り消せる接続試行がない。");
    }
    this.closeInitiated = true;
    try {
      this.aborter?.abort();
    } catch {
      // 中断合図の失敗は接続試行の決着に任せる。
    }
  }

  /**
   * echo を往復させて一致を確認する。本文は結果に残さない。
   *
   * 診断ハンドラの厳密形状（`{ op: "echo", id, value }` の3キーのみ）に合わせ、
   * 相関識別子は payload 直下の `id` に格納する。応答の `id` で待機表を引き、
   * `value` の等価で一致を確認する。送信完了だけでは一致にしない。
   * 相関表と時限は診断が所有し、ブリッジ層へは持ち込まない。
   * 業務 requestId は wire に載せない（`id` は診断 payload 内の相関用である）。
   *
   * @returns 一致した場合に真、不一致の場合に偽。
   * @throws `WorldClientError` — 未認証・破棄済み・待機打ち切り・結果不明の場合。
   */
  async runEcho(): Promise<boolean> {
    this.assertActive();
    this.assertAuthorized();
    const target = this.echoSession;
    if (target === null || !target.isAlive) {
      throw new WorldClientError("NOT_CONNECTED", "応答用の Session が無いため実行できない。");
    }
    const opNo = this.nextOpNo();
    // ADR: 送信内容は都度生成する乱数トークンとし、利用者の業務値は扱わない。
    // 照合は送受の等価で行い、写しには真偽・操作番号・バイト数・往復時間のみ残す。
    // トークンと相関 `id` は待機表の局所値に限り、写し・証拠・ログに残さない。
    const id = crypto.randomUUID();
    const value = crypto.randomUUID();
    const bytes = new TextEncoder().encode(JSON.stringify({ op: "echo", id, value })).length;
    const startedAt = Date.now();
    this.echo = { status: "running", opNo, bytes };
    this.emit();
    const pending = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.echoPending.delete(id);
        const error = new WorldClientError("PROBE_TIMEOUT", "echo の応答が時間内に返らない。");
        if (this.echo.opNo === opNo && this.echo.status === "running") {
          this.echo = { status: "failed", opNo, bytes, error: toErrorView(error) };
          this.emit();
        }
        reject(error);
      }, this.probeTimeoutMs);
      this.echoPending.set(id, {
        opNo,
        value,
        bytes,
        startedAt,
        resolve,
        reject,
        timer,
      });
    });
    try {
      await target.sendReliable({ op: "echo", id, value });
    } catch (error) {
      this.dropEchoPending(id);
      const view = toErrorView(error);
      if (this.echo.opNo === opNo && this.echo.status === "running") {
        this.echo = { status: "failed", opNo, bytes, error: view };
        this.emit();
      }
      throw error instanceof WorldClientError
        ? error
        : new WorldClientError("NOT_CONNECTED", view.message);
    }
    // ADR: 送信の解決はローカル送出の完了であり、相手の受信・業務完了では
    // ない。一致の判定は相関応答の到達でのみ行う。
    return pending;
  }

  /**
   * ping を送り `pong` を確認する。
   *
   * 業務ハンドラの応答確認であり、yamux 監視 Ping（接続の生存監視）とは
   * 別物である。wire 形状は診断ハンドラの厳密形（`{ op: "ping", id }` のみ）
   * に合わせ、応答 `{ op: "pong", id }` の `id` で待機表を対応付ける。
   * 到着順 FIFO では対応付けない。時限切れで脱落した `id` への遅延応答は
   * 未知 `id` として無視し、次の要求へ誤対応させない。
   * 送信完了だけでは `pong` にしない。
   *
   * @returns `pong` を受けた場合に真。
   * @throws `WorldClientError` — 未認証・破棄済み・待機打ち切り・結果不明の場合。
   */
  async runPing(): Promise<boolean> {
    this.assertActive();
    this.assertAuthorized();
    const target = this.pingSession;
    if (target === null || !target.isAlive) {
      throw new WorldClientError("NOT_CONNECTED", "応答用の Session が無いため実行できない。");
    }
    const opNo = this.nextOpNo();
    // ADR: 相関 `id` は診断 payload 内の局所値であり、業務 requestId ではない。
    // wire に業務 requestId は載せない。待機表と時限は診断が所有する。
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    this.ping = { status: "running", opNo };
    this.emit();
    const pending = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pingPending.delete(id);
        const error = new WorldClientError("PROBE_TIMEOUT", "pong が時間内に返らない。");
        if (this.ping.opNo === opNo && this.ping.status === "running") {
          this.ping = { status: "failed", opNo, error: toErrorView(error) };
          this.emit();
        }
        reject(error);
      }, this.probeTimeoutMs);
      this.pingPending.set(id, { opNo, startedAt, resolve, reject, timer });
    });
    try {
      await target.sendReliable({ op: "ping", id });
    } catch (error) {
      this.dropPingPending(id);
      const view = toErrorView(error);
      if (this.ping.opNo === opNo && this.ping.status === "running") {
        this.ping = { status: "failed", opNo, error: view };
        this.emit();
      }
      throw error instanceof WorldClientError
        ? error
        : new WorldClientError("NOT_CONNECTED", view.message);
    }
    return pending;
  }

  /** 接続を閉じる。待機中の要求は結果不明として終える。 */
  disconnect(): void {
    this.assertActive();
    this.closeInitiated = true;
    try {
      this.aborter?.abort();
    } catch {
      // 中断合図の失敗は管理口の終端に任せる。
    }
    const provider = this.provider;
    if (provider !== null) {
      try {
        provider.close();
      } catch {
        // 閉塞の失敗は終端通知に任せる。
      }
    } else if (this.phase === "idle") {
      return;
    }
    if (this.phase !== "ended") {
      this.phase = "ended";
      this.connectionState = "closed";
      this.pairing = null;
      this.failAllPendingUnknown();
      this.emit();
    }
  }

  /**
   * 接続・タイマー・購読を終える。再マウント時は新規生成すること。
   *
   * 以降の操作は拒否し、内部の購読者へは通知しない。
   * 終了時点で未完了の要求は結果不明として終える。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeInitiated = true;
    this.listeners.clear();
    const settlement = this.connectSettlement;
    this.connectSettlement = null;
    try {
      this.aborter?.abort();
    } catch {
      // 破棄時の合図失敗は無視する。
    }
    this.aborter = null;
    const provider = this.provider;
    this.provider = null;
    if (provider !== null) {
      try {
        provider.close();
      } catch {
        // 破棄時の閉塞失敗は無視する。
      }
    }
    this.teardownTransport();
    this.phase = "ended";
    this.connectionState = "closed";
    this.pairing = null;
    this.failAllPendingUnknown();
    if (settlement !== null) {
      settlement.reject(new WorldClientError("DISPOSED", "破棄したため接続試行を終える。"));
    }
  }

  /**
   * 証拠用の診断結果を返す。秘密値・業務 payload・比較コード本文を含まない。
   *
   * 比較コードは画面表示のみとし、ここには表示した事実だけを残す。
   * echo・ping の写しに載るのは操作番号・バイト数・往復時間・成否のみである。
   *
   * @returns 保存・コピー用の JSON 値。
   */
  toResultJson(): Record<string, unknown> {
    const snapshot = this.getSnapshot();
    return {
      version: 1,
      endpoint: snapshot.endpoint,
      phase: snapshot.phase,
      connectionState: snapshot.connectionState,
      probeTimeoutMs: this.probeTimeoutMs,
      pairingShown: snapshot.pairing !== null,
      lastError: snapshot.lastError,
      echo: snapshot.echo,
      ping: snapshot.ping,
      env: { ...snapshot.env },
      build: { ...snapshot.build },
      recordedAt: new Date().toISOString(),
    };
  }

  private nextOpNo(): number {
    this.opCounter += 1;
    return this.opCounter;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new WorldClientError("DISPOSED", "破棄済みのセッションは操作できない。");
    }
  }

  private assertAuthorized(): void {
    if (this.phase !== "authorized" || this.provider === null || !this.provider.isAlive) {
      throw new WorldClientError("NOT_AUTHORIZED", "認証後にのみ実行できる。");
    }
  }

  private handlePairingInfo(info: PairingInfo): void {
    if (this.disposed) return;
    if (this.phase !== "connecting") return;
    // ADR: 比較コードは画面表示用に写しへ載せるだけにし、証拠・ログへ混ぜない。
    // 購読遅れの UI も `getSnapshot()` で表示できるよう保存を先に行う。
    this.pairing = toPairingView(info);
    this.phase = "awaiting_approval";
    this.connectionState = "awaiting_approval";
    this.emit();
  }

  private handleConnectFailure(error: unknown): void {
    if (this.disposed) return;
    if (this.phase !== "connecting" && this.phase !== "awaiting_approval") return;
    const settlement = this.connectSettlement;
    this.connectSettlement = null;
    this.aborter = null;
    this.phase = "ended";
    this.connectionState = "closed";
    this.pairing = null;
    this.lastError = toErrorView(error);
    this.teardownTransport();
    this.failAllPendingUnknown();
    this.emit();
    if (settlement !== null) {
      settlement.reject(
        error instanceof WorldClientError
          ? error
          : new WorldClientError("NOT_CONNECTED", this.lastError.message),
      );
    }
  }

  private async handleSessionProvider(provider: SessionProvider): Promise<void> {
    if (this.disposed) {
      try {
        provider.close();
      } catch {
        // 破棄後の閉塞失敗は無視する。
      }
      return;
    }
    if (this.phase !== "connecting" && this.phase !== "awaiting_approval") return;
    this.provider = provider;
    try {
      this.providerUnsub = provider.onClosed((cause) => {
        this.handleProviderClosed(cause);
      });
    } catch {
      // 購読の失敗は応答用 Session の準備で検出する。
    }
    try {
      await this.openProbeSessions(provider);
    } catch (error) {
      this.handleConnectFailure(error);
      return;
    }
    if (this.disposed) return;
    if (this.provider !== provider) return;
    const settlement = this.connectSettlement;
    this.connectSettlement = null;
    this.aborter = null;
    this.phase = "authorized";
    this.connectionState = "authorized";
    this.pairing = null;
    this.emit();
    if (settlement !== null) settlement.resolve();
  }

  private async openProbeSessions(provider: SessionProvider): Promise<void> {
    const echo = await provider.tryCreateSession({
      sessionId: ECHO_SESSION_ID,
      kind: "reliable",
      direction: "bidirectional",
    });
    if (this.disposed || this.provider !== provider) {
      try {
        echo.abort();
      } catch {
        // 後片付けの失敗は無視する。
      }
      throw new WorldClientError("DISPOSED", "破棄したため応答用 Session を終える。");
    }
    this.echoSession = echo;
    this.echoUnsubs.push(
      echo.onMessage((payload) => {
        this.handleEchoMessage(payload);
      }),
      echo.onRemoteEnd(() => {
        this.handleEchoTerminated("相手が echo 用 Session を終えたため結果は不明である。");
      }),
      echo.onEnd(() => {
        this.handleEchoTerminated("echo 用 Session が終端したため結果は不明である。");
      }),
    );
    const ping = await provider.tryCreateSession({
      sessionId: PING_SESSION_ID,
      kind: "reliable",
      direction: "bidirectional",
    });
    if (this.disposed || this.provider !== provider) {
      try {
        ping.abort();
      } catch {
        // 後片付けの失敗は無視する。
      }
      throw new WorldClientError("DISPOSED", "破棄したため応答用 Session を終える。");
    }
    this.pingSession = ping;
    this.pingUnsubs.push(
      ping.onMessage((payload) => {
        this.handlePingMessage(payload);
      }),
      ping.onRemoteEnd(() => {
        this.handlePingTerminated("相手が ping 用 Session を終えたため結果は不明である。");
      }),
      ping.onEnd(() => {
        this.handlePingTerminated("ping 用 Session が終端したため結果は不明である。");
      }),
    );
  }

  private handleEchoMessage(payload: unknown): void {
    if (this.disposed) return;
    if (!isRecord(payload) || payload["op"] !== "echo") return;
    const id: unknown = payload["id"];
    if (typeof id !== "string") return;
    const pending = this.echoPending.get(id);
    // 未知 `id`（時限切れで脱落した要求への遅延応答を含む）は無視し、
    // 待機中の別要求へ誤対応させない。
    if (pending === undefined) return;
    this.echoPending.delete(id);
    clearTimeout(pending.timer);
    const rttMs = Date.now() - pending.startedAt;
    const matched = JSON.stringify(payload["value"]) === JSON.stringify(pending.value);
    this.echo = matched
      ? { status: "matched", opNo: pending.opNo, bytes: pending.bytes, rttMs }
      : { status: "mismatched", opNo: pending.opNo, bytes: pending.bytes, rttMs };
    this.emit();
    pending.resolve(matched);
  }

  private handlePingMessage(payload: unknown): void {
    if (this.disposed) return;
    if (!isRecord(payload) || payload["op"] !== "pong") return;
    const id: unknown = payload["id"];
    if (typeof id !== "string") return;
    const pending = this.pingPending.get(id);
    // 未知 `id`（時限切れで脱落した要求への遅延 `pong` を含む）は無視し、
    // 待機中の別要求へ誤対応させない。
    if (pending === undefined) return;
    this.pingPending.delete(id);
    clearTimeout(pending.timer);
    const rttMs = Date.now() - pending.startedAt;
    this.ping = { status: "pong", opNo: pending.opNo, rttMs };
    this.emit();
    pending.resolve(true);
  }

  private handleEchoTerminated(message: string): void {
    if (this.disposed) return;
    if (this.echoPending.size === 0) return;
    const error = new WorldClientError("RESULT_UNKNOWN", message);
    for (const pending of this.echoPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.echoPending.clear();
    if (this.echo.status === "running") {
      this.echo = {
        status: "unknown",
        opNo: this.echo.opNo,
        bytes: this.echo.bytes,
        error: toErrorView(error),
      };
      this.emit();
    }
  }

  private handlePingTerminated(message: string): void {
    if (this.disposed) return;
    if (this.pingPending.size === 0) return;
    const error = new WorldClientError("RESULT_UNKNOWN", message);
    for (const pending of this.pingPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pingPending.clear();
    if (this.ping.status === "running") {
      this.ping = { status: "unknown", opNo: this.ping.opNo, error: toErrorView(error) };
      this.emit();
    }
  }

  private handleProviderClosed(cause: Error): void {
    if (this.disposed) return;
    this.teardownTransport();
    this.phase = "ended";
    this.connectionState = "closed";
    this.pairing = null;
    // 切断の表示。能動切断では上書きせず、非自発の切断のみ記録する。
    if (!this.closeInitiated) {
      const code = cause instanceof WorldClientError ? cause.code : "CONNECTION_CLOSED";
      const message =
        cause instanceof WorldClientError ? cause.message : "接続が閉じたため認可は失効した。";
      this.lastError = { code, message, hint: errorHint(code) };
    }
    this.failAllPendingUnknown();
    const settlement = this.connectSettlement;
    this.connectSettlement = null;
    this.aborter = null;
    this.emit();
    if (settlement !== null) {
      settlement.reject(
        cause instanceof WorldClientError
          ? cause
          : new WorldClientError("CONNECTION_CLOSED", "承認前に接続が閉じた。"),
      );
    }
  }

  private dropEchoPending(id: string): void {
    const pending = this.echoPending.get(id);
    if (pending === undefined) return;
    this.echoPending.delete(id);
    clearTimeout(pending.timer);
  }

  private dropPingPending(id: string): void {
    const pending = this.pingPending.get(id);
    if (pending === undefined) return;
    this.pingPending.delete(id);
    clearTimeout(pending.timer);
  }

  private failAllPendingUnknown(): void {
    if (this.echoPending.size > 0) {
      const error = new WorldClientError(
        "RESULT_UNKNOWN",
        "応答待ちのまま終了したため echo の結果は不明である。",
      );
      for (const pending of this.echoPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.echoPending.clear();
      if (this.echo.status === "running") {
        this.echo = {
          status: "unknown",
          opNo: this.echo.opNo,
          bytes: this.echo.bytes,
          error: toErrorView(error),
        };
      }
    }
    if (this.pingPending.size > 0) {
      const error = new WorldClientError(
        "RESULT_UNKNOWN",
        "応答待ちのまま終了したため ping の結果は不明である。",
      );
      for (const pending of this.pingPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pingPending.clear();
      if (this.ping.status === "running") {
        this.ping = { status: "unknown", opNo: this.ping.opNo, error: toErrorView(error) };
      }
    }
  }

  private teardownTransport(): void {
    for (const unsubscribe of this.echoUnsubs.splice(0, this.echoUnsubs.length)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は無視する。
      }
    }
    for (const unsubscribe of this.pingUnsubs.splice(0, this.pingUnsubs.length)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は無視する。
      }
    }
    if (this.providerUnsub !== null) {
      try {
        this.providerUnsub();
      } catch {
        // 購読解除の失敗は無視する。
      }
      this.providerUnsub = null;
    }
    this.echoSession = null;
    this.pingSession = null;
    this.provider = null;
    this.aborter = null;
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // 購読者の例外で診断状態を壊さないため握りつぶす。
      }
    }
  }
}

/**
 * クライアントの比較コード通知を診断の表示用にそろえる。
 *
 * @param pairing - クライアントの比較コード。
 * @returns 診断の写しに載せる表示用情報。
 */
function toPairingView(pairing: PairingInfo): PairingView {
  return {
    requestId: pairing.requestId,
    code: pairing.code,
  };
}

/**
 * 失敗を診断表示用の形にそろえる。秘密値・payload・比較コード本文は取り込まない。
 *
 * @param error - 捕捉した失敗。
 * @returns 表示用の内容。
 */
function toErrorView(error: unknown): DiagnosticErrorView {
  if (error instanceof WorldClientError) {
    return { code: error.code, message: error.message, hint: errorHint(error.code) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "UNKNOWN", message };
}

/**
 * 受信 payload が対象の記録値か判定する。
 *
 * @param value - 受信した JSON 値。
 * @returns 記録値の場合に真。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
