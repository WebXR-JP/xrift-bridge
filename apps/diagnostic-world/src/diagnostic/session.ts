/**
 * ブリッジ接続の診断手順。React・R3F に依存しない。
 *
 * 接続は `connect` 呼び出し時のみ行い、自動接続・自動再接続・自動再送は
 * しない。ペアリング秘密値は呼び出し引数として受け渡すだけで保持せず、
 * 診断結果（`toResultJson`）には秘密値と業務 payload を含めない。
 *
 * @packageDocumentation
 */
import {
  WorldClientError,
  createWorldClient,
  type ConnectionState,
  type Unsubscribe,
  type WorldClient,
  type WorldClientEvent,
} from "world-client";
import type { DiagnosticBuildInfo } from "../build-info.ts";

/** 診断画面の接続待機（ミリ秒）。初回 LNA 許可操作を妨げないよう長めにする。 */
export const DIAGNOSTIC_CONNECT_TIMEOUT_MS = 120_000;

/** echo 往復に使うストリーム。 */
export const ECHO_STREAM_ID = "diag-echo";

/** ping に使うストリーム。 */
export const PING_STREAM_ID = "diag-ping";

/** 診断のおおまかな進行。 */
export type DiagnosticPhase = "idle" | "connecting" | "authorized" | "ended";

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

/** echo 往復の表示内容。payload 本文は保持しない。 */
export interface EchoView {
  readonly status: "none" | "running" | "matched" | "mismatched" | "failed";
  /** 送信時に採番したストリーム内連番。 */
  readonly seq?: number;
  /** 送信 payload の UTF-8 バイト数。本文は保持しない。 */
  readonly bytes?: number;
  /** 失敗時の内容。 */
  readonly error?: DiagnosticErrorView;
}

/** ping の表示内容。 */
export interface PingView {
  readonly status: "none" | "running" | "pong" | "failed";
  /** 失敗時の内容。 */
  readonly error?: DiagnosticErrorView;
}

/** 購読者へ配る診断の写し。秘密値・payload 本文は含まない。 */
export interface DiagnosticSnapshot {
  readonly phase: DiagnosticPhase;
  readonly connectionState: ConnectionState;
  readonly endpoint: string;
  readonly connectTimeoutMs: number;
  readonly lastError: DiagnosticErrorView | null;
  readonly echo: EchoView;
  readonly ping: PingView;
  readonly env: DiagnosticEnv;
  readonly build: DiagnosticBuildInfo;
}

/** 快照を受け取る購読者。 */
export type DiagnosticListener = (snapshot: DiagnosticSnapshot) => void;

/** セッション生成時の設定。 */
export interface DiagnosticSessionOptions {
  /** ブリッジの接続先。`ws://127.0.0.1:<port>/v1` のみ受け付ける。 */
  readonly endpoint: string;
  /** 診断実行時の自ウィンドウの環境。 */
  readonly env: DiagnosticEnv;
  /** 実行ビルドの識別子。 */
  readonly build: DiagnosticBuildInfo;
}

/**
 * エラー符号に対応する次の一手を返す。
 *
 * @param code - 機械可読の符号。
 * @returns 次の一手。該当なしは `undefined`。
 */
export function errorHint(code: string): string | undefined {
  if (code === "UNAUTHORIZED" || code === "AUTH_TIMEOUT" || code === "INVALID_SECRET") {
    return (
      "秘密値が無効・期限切れ（120秒）・使用済みの可能性。" +
      "bridge CLI の `pair` で新規ペアリングを発行して再試行すること。"
    );
  }
  if (code === "CONNECT_TIMEOUT") {
    return (
      "120秒待機でも認証が完了しない。初回 LNA 許可ダイアログの応答、" +
      "bridge の起動と Origin 許可（`--dev --origin`）を確認し、新規ペアリングで再試行すること。"
    );
  }
  if (code === "CONNECTION_CLOSED" || code.startsWith("CLOSED_")) {
    return "切断された。再接続には再ペアリングが必要である（自動再接続はしない）。";
  }
  if (code === "NOT_AUTHORIZED" || code === "NOT_CONNECTED") {
    return "未認証のため操作できない。先に接続・認証すること。";
  }
  return undefined;
}

/** 診断手順のセッション。接続・タイマー・購読を所有し、`dispose` で終える。 */
export class DiagnosticSession {
  private readonly client: WorldClient;
  private readonly env: DiagnosticEnv;
  private readonly build: DiagnosticBuildInfo;
  private readonly listeners = new Set<DiagnosticListener>();
  private readonly unsubscribeClient: Unsubscribe;
  private phase: DiagnosticPhase = "idle";
  private lastError: DiagnosticErrorView | null = null;
  private echo: EchoView = { status: "none" };
  private ping: PingView = { status: "none" };
  private closeInitiated = false;
  private disposed = false;

  /**
   * セッションを生成する。接続は `connect` まで行わない。
   *
   * @param options - 接続先・環境・ビルド識別子。
   * @throws `RangeError` — `endpoint` が正規の loopback 接続先でない場合。
   */
  constructor(options: DiagnosticSessionOptions) {
    this.client = createWorldClient({ endpoint: options.endpoint });
    this.env = options.env;
    this.build = options.build;
    this.unsubscribeClient = this.client.onEvent((event: WorldClientEvent) => {
      this.handleClientEvent(event);
    });
  }

  /** 現在の診断の写しを返す。秘密値・payload 本文は含まない。 */
  getSnapshot(): DiagnosticSnapshot {
    return {
      phase: this.phase,
      connectionState: this.client.getState(),
      endpoint: this.client.endpoint,
      connectTimeoutMs: DIAGNOSTIC_CONNECT_TIMEOUT_MS,
      lastError: this.lastError,
      echo: { ...this.echo },
      ping: { ...this.ping },
      env: this.env,
      build: this.build,
    };
  }

  /**
   * 診断の写しを購読する。戻り値で解除できる。
   *
   * @param listener - 写しを受け取る購読者。
   * @returns 購読の解除関数。
   */
  subscribe(listener: DiagnosticListener): Unsubscribe {
    this.assertActive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 接続してペアリング秘密値で認証する。ボタン操作時のみ呼ぶこと。
   *
   * 秘密値は引数として受け渡すだけで保持しない。接続待機は診断用に
   * 120秒を指定する（bridge の認証待ち制限・秘密値の有効期限は変えない）。
   *
   * @param secret - ペアリング秘密値。空にできない。
   * @throws `WorldClientError` — 進行中・認証済み・破棄済み・秘密値不正の場合。
   */
  async connect(secret: string): Promise<void> {
    this.assertActive();
    if (this.phase === "connecting") {
      throw new WorldClientError("SESSION_BUSY", "接続処理が進行中である。");
    }
    if (this.phase === "authorized") {
      throw new WorldClientError("ALREADY_CONNECTED", "既に認証済みである。");
    }
    this.phase = "connecting";
    this.lastError = null;
    this.echo = { status: "none" };
    this.ping = { status: "none" };
    this.closeInitiated = false;
    this.emit();
    try {
      await this.client.connect(secret, { timeoutMs: DIAGNOSTIC_CONNECT_TIMEOUT_MS });
    } catch (error) {
      if (this.disposed) throw error;
      this.phase = "ended";
      this.lastError = toErrorView(error);
      this.emit();
      throw error;
    }
  }

  /**
   * echo を往復させて一致を確認する。本文は結果に残さない。
   *
   * @returns 一致した場合に真。
   * @throws `WorldClientError` — 未認証・破棄済み・往復失敗の場合。
   */
  async runEcho(): Promise<boolean> {
    this.assertActive();
    this.assertAuthorized();
    this.echo = { status: "running" };
    this.emit();
    // ADR: 送信内容は都度生成する乱数トークンとし、利用者の業務値は扱わない。
    // 照合は送受の厳密な等価で行い、写しには真偽・連番・バイト数のみ残す。
    // トークンは局所変数に限り、写し・証拠・ログに残さない。
    const token = crypto.randomUUID();
    const bytes = new TextEncoder().encode(token).length;
    try {
      const result = await this.client.sendEcho(ECHO_STREAM_ID, token);
      const matched = result.payload === token;
      this.echo = matched
        ? { status: "matched", seq: result.seq, bytes }
        : { status: "mismatched", seq: result.seq, bytes };
      this.emit();
      return matched;
    } catch (error) {
      this.echo = { status: "failed", bytes, error: toErrorView(error) };
      this.emit();
      throw error;
    }
  }

  /**
   * ping を送り `pong` を確認する。
   *
   * @returns `pong` を受けた場合に真。
   * @throws `WorldClientError` — 未認証・破棄済み・応答失敗の場合。
   */
  async runPing(): Promise<boolean> {
    this.assertActive();
    this.assertAuthorized();
    this.ping = { status: "running" };
    this.emit();
    try {
      const response = await this.client.sendCommand(PING_STREAM_ID, "ping");
      const ok = response.ok === true && response.result === "pong";
      this.ping = ok ? { status: "pong" } : { status: "failed" };
      this.emit();
      return ok;
    } catch (error) {
      this.ping = { status: "failed", error: toErrorView(error) };
      this.emit();
      throw error;
    }
  }

  /** 接続を閉じる。待機中の要求は破棄される。 */
  disconnect(): void {
    this.assertActive();
    this.closeInitiated = true;
    this.client.close(1000, "diagnostic disconnect");
  }

  /**
   * 接続・タイマー・購読を終える。再マウント時は新規生成すること。
   *
   * 以降の操作は拒否し、内部の購読者へは通知しない。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeInitiated = true;
    this.listeners.clear();
    this.unsubscribeClient();
    this.client.close(1000, "diagnostic dispose");
  }

  /**
   * 証拠用の診断結果を返す。秘密値・業務 payload を含まない。
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
      connectTimeoutMs: snapshot.connectTimeoutMs,
      lastError: snapshot.lastError,
      echo: snapshot.echo,
      ping: snapshot.ping,
      env: { ...snapshot.env },
      build: { ...snapshot.build },
      recordedAt: new Date().toISOString(),
    };
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new WorldClientError("DISPOSED", "破棄済みのセッションは操作できない。");
    }
  }

  private assertAuthorized(): void {
    if (this.client.getState() !== "authorized" || this.phase !== "authorized") {
      throw new WorldClientError("NOT_AUTHORIZED", "認証後にのみ実行できる。");
    }
  }

  private handleClientEvent(event: WorldClientEvent): void {
    if (this.disposed) return;
    if (event.kind === "state") {
      if (event.state === "authorized") {
        this.phase = "authorized";
      } else if (event.state === "connecting" || event.state === "authenticating") {
        if (this.phase === "idle" || this.phase === "ended") this.phase = "connecting";
      } else if (event.state === "closed") {
        this.phase = "ended";
      }
      this.emit();
      return;
    }
    if (event.kind === "error") {
      this.lastError = { code: event.code, message: event.message, hint: errorHint(event.code) };
      this.emit();
      return;
    }
    // 切断の表示。能動切断では上書きせず、非自発の切断のみ記録する。
    const reason = event.reason === "" ? "(なし)" : event.reason;
    if (!this.closeInitiated) {
      this.lastError = {
        code: `CLOSED_${event.code}`,
        message: `接続が閉じた（code=${event.code} reason=${reason}）。`,
        hint: errorHint("CONNECTION_CLOSED"),
      };
    }
    this.phase = "ended";
    this.emit();
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
 * 失敗を診断表示用の形にそろえる。秘密値・payload は取り込まない。
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
