/**
 * GUI バックエンド。同一 main プロセス内で `bridge-server` と
 * `bridge-app-core` を組み立てる。
 *
 * Electron・native API に依存しない。表示状態 DTO（`src/shared/management.ts`）
 * と限定操作だけを公開し、テストから直接生成して使える。
 * `BridgeServer` や生の `Session` を Webview へ渡さない。
 *
 * @packageDocumentation
 */
import { formatPairingCode } from "bridge-protocol";
import {
  createBridgeServer,
  PRODUCTION_ORIGIN,
  type AcceptanceInfo,
  type ApprovalResult,
  type BridgeServer,
  type ManagementEvent,
  type RejectionResult,
  type Unsubscribe,
} from "bridge-server";
import {
  createBridgeAppCore,
  DIAGNOSTIC_PORT_ID,
  diagnosticPlugin,
  TEXT_PORT_ID,
  TEXT_SESSION_ID,
  textPlugin,
  type BridgeAppCore,
  type DiagnosticStats,
  type PluginInstanceHandle,
  type TextPluginOperations,
  type TextPluginState,
  type TextSendResult,
} from "bridge-app-core";
import type {
  AdmissionState,
  AssignmentSummary,
  BackendStatus,
  ManagementSnapshot,
  OperationAck,
  PairingViewResult,
  StateChangedMessage,
  TextDisplayState,
} from "../shared/management.ts";
import type { DiagnosticInstanceView, TextInstanceView } from "../shared/plugin-instance.ts";

/** 既定の待ち受けポート。 */
export const DEFAULT_BRIDGE_PORT = 3100;

/**
 * 診断統計の変化検出の間隔（ミリ秒）。
 *
 * 診断プラグインに状態購読が無いため、GUI 側で統計の写しを比べて
 * 変化を検出する周期である。汎用基盤の再設計はしない。
 */
export const DEFAULT_DIAGNOSTIC_POLL_MS = 500;

/** `GuiBackend.create` の設定。 */
export interface GuiBackendOptions {
  /**
   * 待ち受けポート。競合時は探索せず起動失敗にする。
   *
   * 試験用途で `0` を指定すると空きポートを自動選択する。
   *
   * @defaultValue `3100`（省略時に生成処理が適用）。
   */
  readonly port?: number;
  /**
   * 許可 `Origin` の一覧。完全一致で判定する。
   *
   * 省略時は `PRODUCTION_ORIGIN` のみである。開発 Origin は
   * 明示設定時のみ含め、バックエンド側で追加しない。
   *
   * @defaultValue `[PRODUCTION_ORIGIN]`（省略時に生成処理が適用）。
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * 診断統計の変化検出の間隔（ミリ秒）。正の有限値であること。
   *
   * 試験で短縮する場合に使う。通常は既定のままとする。
   *
   * @defaultValue `500`（省略時に生成処理が適用）。
   */
  readonly diagnosticPollMs?: number;
}

/**
 * 空でない識別子を検証する。
 *
 * 型付き RPC を実行時検証とみなさず、境界で検査する。
 *
 * @param value - 検査する未知値。
 * @param name - 項目名（人間向けの説明に使う）。
 * @returns 検証済みの識別子。
 * @throws `RangeError` — 空・空文字・文字列でない場合。
 */
function assertId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${name} は空でない文字列であること。`);
  }
  return value;
}

/**
 * 受付情報の表示形を作る。
 *
 * @param info - server の受付状態。
 * @returns 表示用の受付状態。
 */
function toAdmission(info: AcceptanceInfo): AdmissionState {
  return { accepting: info.enabled };
}

/**
 * テキスト個体の限定表示を作る。管理 snapshot 全体・他個体の情報・
 * 候補一覧・保留情報は載せず、本文も含めない。
 *
 * @param handle - 束縛テキスト個体の参照。
 * @param localSessionId - 現割当ての生存セッションのローカル識別子。
 * @returns 子画面へ渡せる限定表示。
 */
export function projectTextInstanceView(
  handle: PluginInstanceHandle<TextPluginState, TextPluginOperations>,
  localSessionId: string,
): TextInstanceView {
  const state = handle.getState();
  return {
    instanceId: handle.instanceId,
    pluginId: handle.pluginId,
    portId: TEXT_PORT_ID,
    localSessionId,
    canSend: state.canSend,
    pendingId: state.pendingId,
    lastResult: state.lastResult,
    stats: state.stats,
  };
}

/**
 * 診断個体の限定表示を作る。echo／ping 統計だけを持ち、管理 snapshot 全体・
 * 他個体の情報・候補一覧・保留情報は載せない。
 *
 * @param handle - 束縛診断個体の参照。
 * @param localSessionId - 現割当ての生存セッションのローカル識別子。
 * @returns 子画面へ渡せる限定表示。
 */
export function projectDiagnosticInstanceView(
  handle: PluginInstanceHandle<DiagnosticStats>,
  localSessionId: string,
): DiagnosticInstanceView {
  return {
    instanceId: handle.instanceId,
    pluginId: handle.pluginId,
    portId: DIAGNOSTIC_PORT_ID,
    localSessionId,
    stats: handle.getState(),
  };
}

/**
 * GUI バックエンド。`bridge-server` と `bridge-app-core` の組み立てと
 * 表示状態の提供・限定操作の実行を担う。
 *
 * 生成は {@link GuiBackend.create} で行う。server 起動に失敗しても
 * 例外にせず起動失敗状態で返すため、管理画面は表示と終了を続けられる。
 * 終了は {@link GuiBackend.close} に集約し、冪等である。
 */
export class GuiBackend {
  private status: BackendStatus = "starting";
  private server: BridgeServer | null = null;
  private core: BridgeAppCore | null = null;
  private managementUnsubscribe: Unsubscribe | null = null;
  private readonly listeners = new Set<(message: StateChangedMessage) => void>();
  /** 生成した診断インスタンスの handle。表示と合わせて保持する。 */
  private readonly diagnosticHandles = new Map<string, PluginInstanceHandle<DiagnosticStats>>();
  /**
   * 診断割当ての対応付け（生存セッションのローカル識別子→生成インスタンスの識別子）。
   *
   * セッション終了時の生成分回収用である。終了通知の時点では core の
   * 割当て失効が先に済んでいるため、割当て表からは引けない。
   */
  private readonly diagnosticSessions = new Map<string, string>();
  /** 生成したテキストインスタンスの handle。同時に一つのみ持つ。 */
  private textHandle: PluginInstanceHandle<TextPluginState, TextPluginOperations> | null = null;
  /** テキスト割当て対象の生存セッションのローカル識別子。未割当てなら null。 */
  private textLocalSessionId: string | null = null;
  /** テキスト状態購読の解除口。未購読なら null。 */
  private textStateUnsubscribe: Unsubscribe | null = null;
  /** 診断統計の変化検出の間隔（ミリ秒）。生成時に確定する。 */
  private diagnosticPollMs: number = DEFAULT_DIAGNOSTIC_POLL_MS;
  /** 診断統計の変化検出タイマー。監視対象が無ければ null。 */
  private diagnosticPollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 診断統計の前回値（インスタンス識別子→直列化した統計）。
   *
   * 診断プラグインに状態購読が無いため、変化検出の基準として保持する。
   * 統計以外の情報（本文など）は含めない。
   */
  private readonly lastDiagnosticStats = new Map<string, string>();
  private revision = 0;
  private cached: ManagementSnapshot | null = null;
  private notifyScheduled = false;
  private disposed = false;
  private closeTask: Promise<void> | null = null;
  private failure: Error | null = null;

  private constructor() {}

  /**
   * GUI バックエンドを生成する。
   *
   * server 起動の成否にかかわらず解決する。失敗時は起動失敗状態となり、
   * 表示（`getSnapshot`）と終了（`close`）だけを提供する。
   *
   * @param options - 待ち受けポート・許可 Origin の設定。
   * @returns 生成したバックエンド。起動失敗時は `startupError` を持つ。
   */
  static async create(options: GuiBackendOptions = {}): Promise<GuiBackend> {
    const backend = new GuiBackend();
    const allowedOrigins = options.allowedOrigins ?? [PRODUCTION_ORIGIN];
    const diagnosticPollMs = options.diagnosticPollMs ?? DEFAULT_DIAGNOSTIC_POLL_MS;
    // 不正な指定では既定に戻し、検出自体を止めない。
    backend.diagnosticPollMs =
      Number.isFinite(diagnosticPollMs) && diagnosticPollMs > 0
        ? diagnosticPollMs
        : DEFAULT_DIAGNOSTIC_POLL_MS;
    try {
      const server = await createBridgeServer({
        port: options.port ?? DEFAULT_BRIDGE_PORT,
        allowedOrigins: [...allowedOrigins],
      });
      backend.attach(server);
    } catch (error) {
      backend.markFailed(error);
    }
    return backend;
  }

  /** 起動失敗の原因。成功時は null。main 側の記録用である。 */
  get startupError(): Error | null {
    return this.failure;
  }

  /**
   * 起動した server と基盤を結び付ける。
   *
   * 基盤の購読を先に core 側で確定してから、後続の管理通知を
   * バックエンド側で受ける。購読前の既存セッションは core が
   * 一覧で初期走査するため、取りこぼさない。管理通知の配送順は
   * 購読順であるため、終了通知では core の失効処理が先に済んでいる。
   *
   * @param server - 起動したブリッジ。
   */
  private attach(server: BridgeServer): void {
    this.server = server;
    this.core = createBridgeAppCore(server);
    this.managementUnsubscribe = server.onManagementEvent((event) => {
      this.handleManagementEvent(event);
    });
    this.status = "ready";
    this.requestNotify();
  }

  /**
   * 起動失敗を記録する。
   *
   * server を持たないため、表示は空のまま・操作は拒否・終了は即時成功する。
   *
   * @param error - 起動失敗の原因。
   */
  private markFailed(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.status = "failed";
    this.requestNotify();
  }

  /**
   * 操作可能な server と基盤を取り出す。
   *
   * @returns 操作対象の server と基盤。
   * @throws `Error` — 終了中・起動失敗の場合。新規操作を受け付けない。
   */
  private operable(): { server: BridgeServer; core: BridgeAppCore } {
    if (this.status === "stopping" || this.disposed) {
      throw new Error("終了中のため操作を受け付けない。");
    }
    if (this.server === null || this.core === null || this.status !== "ready") {
      throw new Error("起動に失敗しているため操作を受け付けない。");
    }
    return { server: this.server, core: this.core };
  }

  /**
   * 状態通知を予約する。同一 tick の管理イベント・操作後の通知は
   * 一度にまとめ、core の失効処理後の状態を読む。
   */
  private requestNotify(): void {
    if (this.disposed || this.notifyScheduled) {
      return;
    }
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.flushNotify();
    });
  }

  /**
   * 予約した通知を確定する。購読者の例外は隔離する。
   *
   * 保留中の通知があれば `getSnapshot` でも先に確定するため、
   * 読み取りは常に失効処理後の最新状態を返す。
   */
  private flushNotify(): void {
    if (!this.notifyScheduled) {
      return;
    }
    this.notifyScheduled = false;
    if (this.disposed) {
      return;
    }
    this.revision += 1;
    this.cached = this.buildSnapshot();
    const message: StateChangedMessage = { revision: this.revision, snapshot: this.cached };
    // 購読の追加・削除が通知中に起きても配送を壊さない（Set の反復は安全）。
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // 購読者の例外で後始末を壊さない。
      }
    }
  }

  /**
   * 現在の表示状態を返す。読み取りは revision を進めないが、
   * 保留中の通知は先に確定する。
   *
   * @returns 現在の表示スナップショット。
   */
  getSnapshot(): ManagementSnapshot {
    this.flushNotify();
    if (this.cached === null) {
      this.cached = this.buildSnapshot();
    }
    return this.cached;
  }

  /**
   * 状態通知を受け取る。
   *
   * Webview は更新ハンドラ登録後に `getSnapshot()` し、
   * 単調増加 revision が新しいときだけ採用すること。
   *
   * @param listener - 最新の全状態を受け取る処理。例外を投げないこと。
   * @returns 登録解除関数。
   */
  onStateChanged(listener: (message: StateChangedMessage) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * ペアリング受付を有効化する。
   *
   * @returns 有効化後の受付状態。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  enableAcceptance(): AdmissionState {
    const { server } = this.operable();
    const admission = toAdmission(server.enableAcceptance());
    this.requestNotify();
    return admission;
  }

  /**
   * ペアリング受付を無効化する。認可済みは維持する。
   *
   * @returns 無効化後の受付状態。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  disableAcceptance(): AdmissionState {
    const { server } = this.operable();
    const admission = toAdmission(server.disableAcceptance());
    this.requestNotify();
    return admission;
  }

  /**
   * 選択した保留の比較コードを表示用に取得する。
   *
   * 照合のための表示だけであり、取得自体は承認しない。
   * コード一致による自動承認はしない。
   *
   * @param params - 照合対象の要求識別子。
   * @returns 比較コード。対象がなければ未提供の理由。
   * @throws `RangeError` — 要求識別子が空・文字列でない場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  getPairingView(params: { requestId: unknown }): PairingViewResult {
    const { server } = this.operable();
    const requestId = assertId(params.requestId, "requestId");
    const entry = server.listPending().find((candidate) => candidate.requestId === requestId);
    if (entry === undefined) {
      return {
        available: false,
        reason: "対象の保留が無い。承認済み・拒否済みの場合がある。",
      };
    }
    return {
      available: true,
      requestId: entry.requestId,
      // 比較コードは文字列のまま扱い、数値化しない（先頭ゼロを保持する）。
      code: entry.code,
      displayCode: formatPairingCode(entry.code),
    };
  }

  /**
   * 保留を比較コード照合で承認する。承認可否は常に server が決める。
   *
   * @param params - 承認する要求の識別子と比較コード（文字列のまま）。
   * @returns 承認結果。
   * @throws `RangeError` — 識別子・コードが空・文字列でない場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  approvePairing(params: { requestId: unknown; code: unknown }): ApprovalResult {
    const { server } = this.operable();
    const requestId = assertId(params.requestId, "requestId");
    const code = assertId(params.code, "code");
    const result = server.approvePairing(requestId, code);
    this.requestNotify();
    return result;
  }

  /**
   * 保留を取り下げる。対象の接続を終了する。
   *
   * @param params - 取り下げる要求の識別子。
   * @returns 拒否結果。
   * @throws `RangeError` — 要求識別子が空・文字列でない場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  rejectPairing(params: { requestId: unknown }): RejectionResult {
    const { server } = this.operable();
    const requestId = assertId(params.requestId, "requestId");
    const result = server.rejectPairing(requestId);
    this.requestNotify();
    return result;
  }

  /**
   * 指定接続だけを切断する。待ち受けと他接続は維持する。
   *
   * @param params - `listConnections` で得た接続識別子。
   * @returns 受付応答。
   * @throws `RangeError` — 接続識別子が空・文字列でない、または不明な場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  disconnectConnection(params: { connectionId: unknown }): OperationAck {
    const { server } = this.operable();
    const connectionId = assertId(params.connectionId, "connectionId");
    server.disconnectConnection(connectionId);
    this.requestNotify();
    return { ok: true };
  }

  /**
   * スパイク専用の診断割当て。reliable Session ごとに診断プラグインの
   * インスタンスを1つ生成し `"diagnostic"` 接続口へ割り当てる。
   *
   * 開始通知での自動割当てはしない。恒久採用（自動割当て・統計表示の
   * 扱い）は別判断とし、ここでは明示操作だけを提供する。
   * 失敗時は生成分を回収し、半端なインスタンスを残さない。
   * 論理名がテキスト表示用のセッションは対象外にする（テキスト割当てと排他）。
   *
   * @param params - 割り当てる生存セッションのローカル識別子。
   * @returns 確定した割当ての表示状態。
   * @throws `RangeError` — 識別子が空・文字列でない、不明・不適合・
   * 二重割当て・テキスト表示用の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  assignDiagnostics(params: { localSessionId: unknown }): AssignmentSummary {
    const { core, server } = this.operable();
    const localSessionId = assertId(params.localSessionId, "localSessionId");
    const info = server
      .listSessions()
      .find((candidate) => candidate.localSessionId === localSessionId);
    if (info !== undefined && info.sessionId === TEXT_SESSION_ID) {
      throw new RangeError("テキスト表示用のセッションには診断を割り当てない。");
    }
    const handle = core.createInstance(diagnosticPlugin);
    try {
      core.assign(localSessionId, handle.instanceId, DIAGNOSTIC_PORT_ID);
    } catch (error) {
      // 割当てに失敗した Session は残さず、生成したインスタンスだけを片付ける。
      try {
        core.removeInstance(handle.instanceId);
      } catch {
        // 片付けの失敗は元の失敗を優先し、ここでは無視する。
      }
      throw error;
    }
    // GUI バックエンドが生成した handle を保持し、表示と合わせて提供する。
    this.diagnosticHandles.set(handle.instanceId, handle);
    this.diagnosticSessions.set(localSessionId, handle.instanceId);
    this.watchDiagnostic(handle.instanceId);
    this.requestNotify();
    return { localSessionId, instanceId: handle.instanceId, portId: DIAGNOSTIC_PORT_ID };
  }

  /**
   * 固定テキスト表示の明示割当て。引数は取らない。
   *
   * テキストインスタンスを生成し、論理名がテキスト表示用で未割当ての
   * 生存セッションが全接続を通じて一件だけある場合に割り当てる。
   * 先着順・一件目・Origin 推測による選択はしない。失敗時は生成分を
   * 回収し、半端なインスタンスを残さない。
   *
   * @returns 確定した割当ての表示状態。
   * @throws `RangeError` — 候補ゼロ・複数・割当て中の再要求の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  assignText(): AssignmentSummary {
    const { core, server } = this.operable();
    if (this.textHandle !== null || this.textLocalSessionId !== null) {
      throw new RangeError("テキストは既に割当て済みである。");
    }
    // ADR: core の割当て表を先に読む。既存の割当て済みセッションは候補から
    // 外し、一対一検査と合わせる（診断など他用途の割当てと混ぜない）。
    const assigned = new Set(core.listAssignments().map((assignment) => assignment.localSessionId));
    const candidates = server
      .listSessions()
      .filter(
        (info) =>
          !assigned.has(info.localSessionId) &&
          info.sessionId === TEXT_SESSION_ID &&
          info.kind === "reliable" &&
          info.direction === "bidirectional" &&
          server.getSession(info.localSessionId)?.isAlive === true,
      );
    if (candidates.length === 0) {
      throw new RangeError("テキスト割当ての候補が無い。");
    }
    if (candidates.length > 1) {
      throw new RangeError("テキスト割当ての候補が複数ある。");
    }
    const target = candidates[0];
    if (target === undefined) {
      throw new RangeError("テキスト割当ての候補が無い。");
    }
    const handle = core.createInstance(textPlugin);
    try {
      core.assign(target.localSessionId, handle.instanceId, TEXT_PORT_ID);
    } catch (error) {
      // 割当てに失敗した Session は残さず、生成したインスタンスだけを片付ける。
      try {
        core.removeInstance(handle.instanceId);
      } catch {
        // 片付けの失敗は元の失敗を優先し、ここでは無視する。
      }
      throw error;
    }
    const operations = handle.getOperations?.();
    if (operations === undefined) {
      try {
        core.removeInstance(handle.instanceId);
      } catch {
        // 片付けの失敗は無視する。
      }
      throw new RangeError("テキストの操作口が無い。");
    }
    this.textHandle = handle;
    this.textLocalSessionId = target.localSessionId;
    try {
      // ADR: 状態変化は既存の通知予約経路へ結線する。購読者の例外は
      // プラグイン側で隔離されるため、ここでは予約だけを行う。
      this.textStateUnsubscribe = operations.onStateChanged(() => {
        this.requestNotify();
      });
    } catch (error) {
      this.textHandle = null;
      this.textLocalSessionId = null;
      try {
        core.removeInstance(handle.instanceId);
      } catch {
        // 片付けの失敗は元の失敗を優先し、ここでは無視する。
      }
      throw error;
    }
    this.requestNotify();
    return {
      localSessionId: target.localSessionId,
      instanceId: handle.instanceId,
      portId: TEXT_PORT_ID,
    };
  }

  /**
   * 固定テキストの送信。画面が認識している割当て識別子を含める。
   *
   * 現在の割当てと `localSessionId`・`instanceId` を照合し、一致しなければ
   * 拒否する。古い画面の要求を新しい割当てへ転送しない。本文の検証は
   * プラグインが行い、ここでは文字列かだけを検査する。本文は送信時のみ
   * 扱い、ログ・snapshot に残さない。
   *
   * 状態の更新通知は購読経路（`operations.onStateChanged`→`requestNotify`）
   * が担うため、ここでは追加の通知予約をしない。
   *
   * @param params - 現在の割当て識別子と送信する本文。
   * @returns 反映確認または結果不明。送信処理の失敗は `Promise` の拒否で表す。
   * @throws `RangeError` — 識別子・本文の型が不正、未割当て・不一致の場合（同期的）。
   * @throws `Error` — 終了中・起動失敗の場合（同期的）。
   */
  sendText(params: {
    localSessionId: unknown;
    instanceId: unknown;
    text: unknown;
  }): Promise<TextSendResult> {
    this.operable();
    const localSessionId = assertId(params.localSessionId, "localSessionId");
    const instanceId = assertId(params.instanceId, "instanceId");
    if (typeof params.text !== "string") {
      throw new RangeError("text は文字列であること。");
    }
    const handle = this.textHandle;
    const assignedId = this.textLocalSessionId;
    if (handle === null || assignedId === null) {
      throw new RangeError("テキストは割当てられていない。");
    }
    if (localSessionId !== assignedId || instanceId !== handle.instanceId) {
      throw new RangeError("現在の割当てと識別子が一致しない。");
    }
    const operations = handle.getOperations?.();
    if (operations === undefined) {
      throw new RangeError("テキストの操作口が無い。");
    }
    return operations.sendText(params.text, localSessionId);
  }

  /**
   * 固定テキストの明示解除。割当て表示を消し、生成分を回収する。
   *
   * 購読解除と表示の消去を先に行ってから基盤を片付ける。対象セッションの
   * 中断は基盤の解除規約に従う。失効済み（終了通知で回収済み）の場合は
   * 解除を省略し、生成分の回収だけを行う。
   *
   * @returns 受付応答。後続の状態は `stateChanged` で受け取る。
   * @throws `RangeError` — 未割当ての場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  unassignText(): OperationAck {
    const { core } = this.operable();
    const handle = this.textHandle;
    const localSessionId = this.textLocalSessionId;
    if (handle === null || localSessionId === null) {
      throw new RangeError("テキストは割当てられていない。");
    }
    this.detachTextSubscription();
    this.textHandle = null;
    this.textLocalSessionId = null;
    const assigned = core
      .listAssignments()
      .some((assignment) => assignment.localSessionId === localSessionId);
    if (assigned) {
      try {
        core.unassign(localSessionId);
      } catch {
        // 失効競合の失敗は回収を止めない。
      }
    }
    try {
      core.removeInstance(handle.instanceId);
    } catch {
      // 回収の失敗は無視する。
    }
    this.requestNotify();
    return { ok: true };
  }

  /**
   * 束縛テキスト個体の限定表示を返す。子画面用の射影であり、管理 snapshot
   * 全体・他個体の情報・候補一覧・保留情報は含めない。
   *
   * 現割当てが失効していれば拒否する。識別子は main の対応付けが決め、
   * 子からの指定は受け付けない。
   *
   * @param params - 束縛個体の識別子。
   * @returns 子画面へ渡せる限定表示。本文は含めない。
   * @throws `RangeError` — 識別子が不正・束縛外・現割当て失効の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  getTextInstanceView(params: { instanceId: unknown }): TextInstanceView {
    const { handle, localSessionId } = this.requireTextBinding(params.instanceId);
    return projectTextInstanceView(handle, localSessionId);
  }

  /**
   * 束縛テキスト個体の現割当てへ本文を送る。子は本文だけを渡し、
   * `instanceId`／`localSessionId` の指定は受け付けない。main が束縛した
   * 個体の現割当てに委譲する。本文は送信時のみ扱い、ログ・snapshot に残さない。
   *
   * @param instanceId - 束縛個体の識別子。main の対応付けが決める。
   * @param params - 送信する本文。
   * @returns 反映確認または結果不明。送信処理の失敗は `Promise` の拒否で表す。
   * @throws `RangeError` — 識別子・本文の型が不正、束縛外・現割当て失効の場合（同期的）。
   * @throws `Error` — 終了中・起動失敗の場合（同期的）。
   */
  sendTextForInstance(instanceId: unknown, params: { text: unknown }): Promise<TextSendResult> {
    const { handle, localSessionId } = this.requireTextBinding(instanceId);
    if (typeof params.text !== "string") {
      throw new RangeError("text は文字列であること。");
    }
    const operations = handle.getOperations?.();
    if (operations === undefined) {
      throw new RangeError("テキストの操作口が無い。");
    }
    return operations.sendText(params.text, localSessionId);
  }

  /**
   * 束縛診断個体の限定表示を返す。echo／ping 統計だけを持ち、管理 snapshot
   * 全体・他個体の情報・候補一覧・保留情報は含めない。
   *
   * 診断には状態購読が無いため、統計は読み取り時点の取得であり、通知は
   * 既存の状態通知（`onStateChanged`）の周期で送る。汎用基盤の再設計はしない。
   *
   * @param params - 束縛個体の識別子。
   * @returns 子画面へ渡せる限定表示。
   * @throws `RangeError` — 識別子が不正・束縛外・現割当て失効の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  getDiagnosticInstanceView(params: { instanceId: unknown }): DiagnosticInstanceView {
    const { handle, localSessionId } = this.requireDiagnosticBinding(params.instanceId);
    return projectDiagnosticInstanceView(handle, localSessionId);
  }

  /**
   * 外部状態（子画面配置など）の変化を状態通知に載せる。
   *
   * main 側の配置管理が backend の改訂番号を共有時計として使うための口で
   * あり、配置の有無自体は snapshot に含めない。ここでは通知予約だけを
   * 行い、改訂は既存の確定経路で進める。
   */
  notifyExternalChange(): void {
    this.requestNotify();
  }

  /**
   * 現在のテキスト束縛を返す。子画面配置の対応付け用である。
   *
   * handle と基盤の現割当ての両方が現在のものでなければ `null` とし、
   * 古い割当てへの配置は作らない。管理 snapshot 全体・他個体の情報・
   * 候補一覧・保留情報は返さない。
   *
   * @returns 現割当てがある場合の束縛情報。無ければ `null`。
   */
  getTextBinding(): { instanceId: string; localSessionId: string; portId: string } | null {
    if (this.status !== "ready" || this.core === null) {
      return null;
    }
    const handle = this.textHandle;
    const localSessionId = this.textLocalSessionId;
    if (handle === null || localSessionId === null) {
      return null;
    }
    const assigned = this.core
      .listAssignments()
      .some(
        (assignment) =>
          assignment.instanceId === handle.instanceId &&
          assignment.localSessionId === localSessionId &&
          assignment.portId === TEXT_PORT_ID,
      );
    if (!assigned) {
      return null;
    }
    return { instanceId: handle.instanceId, localSessionId, portId: TEXT_PORT_ID };
  }

  /**
   * 現在の診断束縛の一覧を返す。子画面配置の対応付け用である。
   *
   * 基盤の現割当てと生成分の保持の両方にあるものだけを返し、失効した
   * 割当てへの配置は作らない。管理 snapshot 全体・他個体の情報・
   * 候補一覧・保留情報は返さない。
   *
   * @returns 現割当てがある束縛情報の一覧。無ければ空配列。
   */
  listDiagnosticBindings(): Array<{
    instanceId: string;
    localSessionId: string;
    portId: string;
  }> {
    if (this.status !== "ready" || this.core === null) {
      return [];
    }
    const live = new Map<string, string>();
    for (const assignment of this.core.listAssignments()) {
      if (assignment.portId !== DIAGNOSTIC_PORT_ID) {
        continue;
      }
      if (!this.diagnosticHandles.has(assignment.instanceId)) {
        continue;
      }
      live.set(assignment.instanceId, assignment.localSessionId);
    }
    return [...live].map(([instanceId, localSessionId]) => ({
      instanceId,
      localSessionId,
      portId: DIAGNOSTIC_PORT_ID,
    }));
  }

  /**
   * 診断統計の変化検出を始める。
   *
   * 診断プラグインに状態購読が無いため、GUI 側で統計の写しを保持し、
   * 周期的に比べて変化を検出する。テキストと同程度の最小の購読口であり、
   * 汎用プラグイン基盤の再設計はしない（`packages/*` は変更しない）。
   * 監視対象が無くなったらタイマーを止め、残さない。
   *
   * @param instanceId - 監視する診断インスタンスの識別子。
   */
  private watchDiagnostic(instanceId: string): void {
    const handle = this.diagnosticHandles.get(instanceId);
    if (handle === undefined) {
      return;
    }
    try {
      this.lastDiagnosticStats.set(instanceId, JSON.stringify(handle.getState()));
    } catch {
      this.lastDiagnosticStats.set(instanceId, "");
    }
    if (this.diagnosticPollTimer !== null) {
      return;
    }
    this.diagnosticPollTimer = setInterval(() => {
      this.pollDiagnosticStats();
    }, this.diagnosticPollMs);
    // ADR: `as` で `unref` の有無を主張する理由は、実行系（Node・Bun）で
    // タイマー型が異なるためである。待機の維持には使わず、単独滞留での
    // 固着を避けるために外せる場合だけ外す。根拠は Node の `Timeout.unref`
    // と Bun の互換タイマーであり、無い環境では何もしない。
    const timer = this.diagnosticPollTimer as unknown as { unref?: () => void };
    try {
      timer.unref?.();
    } catch {
      // 解除の失敗は検出を止めない。
    }
  }

  /** 診断統計の変化検出タイマーを止める。監視対象が無い場合に使う。 */
  private stopDiagnosticPoll(): void {
    const timer = this.diagnosticPollTimer;
    this.diagnosticPollTimer = null;
    if (timer === null) {
      return;
    }
    clearInterval(timer);
  }

  /**
   * 診断統計の変化を検出し、変化があれば状態通知を予約する。
   *
   * 取得の失敗は無視し、検出自体を止めない。監視対象が空になったら
   * タイマーを止める。
   */
  private pollDiagnosticStats(): void {
    if (this.disposed) {
      return;
    }
    let changed = false;
    for (const [instanceId, handle] of this.diagnosticHandles) {
      let current: string;
      try {
        current = JSON.stringify(handle.getState());
      } catch {
        continue;
      }
      if (this.lastDiagnosticStats.get(instanceId) !== current) {
        this.lastDiagnosticStats.set(instanceId, current);
        changed = true;
      }
    }
    if (changed) {
      this.requestNotify();
    }
    if (this.diagnosticHandles.size === 0) {
      this.stopDiagnosticPoll();
    }
  }

  /**
   * 束縛テキスト個体を取り出す。handle と現割当ての両方が現在のもので
   * なければ拒否し、古い割当てへの転送はしない。
   *
   * @param instanceId - 照合する束縛個体の識別子。
   * @throws `RangeError` — 識別子が不正・束縛外・現割当て失効の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  private requireTextBinding(instanceId: unknown): {
    handle: PluginInstanceHandle<TextPluginState, TextPluginOperations>;
    localSessionId: string;
  } {
    this.operable();
    const id = assertId(instanceId, "instanceId");
    const handle = this.textHandle;
    const localSessionId = this.textLocalSessionId;
    if (handle === null || localSessionId === null || handle.instanceId !== id) {
      throw new RangeError("束縛したテキスト個体ではない。");
    }
    return { handle, localSessionId };
  }

  /**
   * 束縛診断個体を取り出す。生成分の保持と基盤の現割当ての両方を照合し、
   * 失効していれば拒否する。
   *
   * @param instanceId - 照合する束縛個体の識別子。
   * @throws `RangeError` — 識別子が不正・束縛外・現割当て失効の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  private requireDiagnosticBinding(instanceId: unknown): {
    handle: PluginInstanceHandle<DiagnosticStats>;
    localSessionId: string;
  } {
    const { core } = this.operable();
    const id = assertId(instanceId, "instanceId");
    const handle = this.diagnosticHandles.get(id);
    if (handle === undefined) {
      throw new RangeError("束縛した診断個体ではない。");
    }
    const assignment = core
      .listAssignments()
      .find((candidate) => candidate.instanceId === id && candidate.portId === DIAGNOSTIC_PORT_ID);
    if (assignment === undefined) {
      throw new RangeError("診断の現割当てが無い。");
    }
    return { handle, localSessionId: assignment.localSessionId };
  }

  /**
   * 管理通知を処理する。テキスト割当て対象の終了では core の失効後に
   * 生成分を回収し、診断割当ての終了でも該当の生成分を回収する。
   * その後の通知予約は既存経路にまとめる。
   *
   * プラグインの操作口は失効時に購読を解除するため、後始末を
   * プラグインの `onEnd` 到達には依存しない（管理通知で駆動する）。
   *
   * @param event - サーバーの管理通知。
   */
  private handleManagementEvent(event: ManagementEvent): void {
    if (event.kind === "session-ended") {
      if (event.session.localSessionId === this.textLocalSessionId) {
        this.reclaimText();
      }
      this.reclaimDiagnostics(event.session.localSessionId);
    }
    this.requestNotify();
  }

  /**
   * 終了した診断割当ての生成分を回収する。
   *
   * core の割当て失効は購読順で先に済んでいるため、生成分の削除だけを
   * 行う。対象が無ければ何もしない。挙動の他の変更はしない。
   *
   * @param localSessionId - 終了した生存セッションのローカル識別子。
   */
  private reclaimDiagnostics(localSessionId: string): void {
    const instanceId = this.diagnosticSessions.get(localSessionId);
    if (instanceId === undefined) {
      return;
    }
    this.diagnosticSessions.delete(localSessionId);
    this.diagnosticHandles.delete(instanceId);
    this.lastDiagnosticStats.delete(instanceId);
    if (this.diagnosticHandles.size === 0) {
      this.stopDiagnosticPoll();
    }
    if (this.core !== null) {
      try {
        this.core.removeInstance(instanceId);
      } catch {
        // 回収の失敗は通知を止めない。
      }
    }
  }

  /**
   * 終了したテキスト割当ての生成分を回収する。
   *
   * 購読解除と表示の消去を先に行ってから基盤の生成分を片付ける。
   * core の割当て失効は購読順で先に済んでいるため、ここでは問わない。
   * 回収後は再承認・新規セッション・新規の明示割当てを要求し、
   * 旧操作口・未完了要求・本文を引き継がない。
   */
  private reclaimText(): void {
    const handle = this.textHandle;
    this.detachTextSubscription();
    this.textHandle = null;
    this.textLocalSessionId = null;
    if (handle !== null && this.core !== null) {
      try {
        this.core.removeInstance(handle.instanceId);
      } catch {
        // 回収の失敗は通知を止めない。
      }
    }
  }

  /** テキスト状態の購読を外す。未購読なら何もしない。 */
  private detachTextSubscription(): void {
    const unsubscribe = this.textStateUnsubscribe;
    this.textStateUnsubscribe = null;
    if (unsubscribe === null) {
      return;
    }
    try {
      unsubscribe();
    } catch {
      // 購読解除の失敗は後始末を止めない。
    }
  }

  /**
   * 終了する。冪等であり、二度目以降は同じ終了を待つ。
   *
   * 終了中は新規操作を拒否し、受付の無効化 → 基盤を終了する
   * （割当ての失効・中断、購読解除）→ server を閉じる（待受停止）の
   * 順で後始末する。購読・通知予約の解除は最後に行う。
   */
  close(): Promise<void> {
    if (this.closeTask === null) {
      this.closeTask = this.shutdown();
    }
    return this.closeTask;
  }

  /** 終了処理の本体。失敗しても購読の解除までは進める。 */
  private async shutdown(): Promise<void> {
    if (this.status !== "failed") {
      this.status = "stopping";
    }
    // 終了中表示を確定し、以降の新規操作を拒否する。
    this.flushNotify();
    try {
      try {
        this.server?.disableAcceptance();
      } catch {
        // 受付無効化の失敗は後始末を止めない。
      }
      try {
        this.core?.close();
      } catch {
        // 基盤終了の失敗は待受停止を止めない。
      }
      if (this.server !== null) {
        await this.server.close();
      }
    } finally {
      this.dispose();
    }
  }

  /** 購読・通知予約・保持 handle を解く。 */
  private dispose(): void {
    this.disposed = true;
    this.notifyScheduled = false;
    this.detachTextSubscription();
    this.textHandle = null;
    this.textLocalSessionId = null;
    this.stopDiagnosticPoll();
    this.lastDiagnosticStats.clear();
    if (this.managementUnsubscribe !== null) {
      try {
        this.managementUnsubscribe();
      } catch {
        // 購読解除の失敗は終了を止めない。
      }
      this.managementUnsubscribe = null;
    }
    this.listeners.clear();
    this.diagnosticHandles.clear();
    this.diagnosticSessions.clear();
  }

  /** 現在の表示スナップショットを組み立てる。比較コード本文は含めない。 */
  private buildSnapshot(): ManagementSnapshot {
    const server = this.server;
    const core = this.core;
    return {
      revision: this.revision,
      backend: this.status,
      endpoint:
        server === null ? null : { url: server.endpoint, listening: this.status === "ready" },
      admission: server === null ? { accepting: false } : toAdmission(server.getAcceptance()),
      pending:
        server === null
          ? []
          : server.listPending().map((entry) => ({ requestId: entry.requestId })),
      connections:
        server === null
          ? []
          : server.listConnections().map((connection) => ({
              connectionId: connection.connectionId,
              origin: connection.origin,
              authorized: connection.authorized,
              phase: connection.phase,
            })),
      sessions: server === null ? [] : [...server.listSessions()],
      plugins: {
        instances: [...this.diagnosticHandles.values()].map((handle) => ({
          instanceId: handle.instanceId,
          pluginId: handle.pluginId,
        })),
        assignments:
          core === null
            ? []
            : core.listAssignments().map((assignment) => ({
                localSessionId: assignment.localSessionId,
                instanceId: assignment.instanceId,
                portId: assignment.portId,
              })),
      },
      text: this.buildTextState(),
      // 実プラグイン子画面の配置は main 側の対応付けが持ち、backend は
      // 所有しない。ここでは空を返し、RPC 層で対応付けの現在値を載せる。
      pluginMounts: [],
      pluginMountFailures: [],
    };
  }

  /**
   * 固定テキスト表示の状態を組み立てる。本文は含めない。
   *
   * 未割当てなら識別子は `null`・統計は零値である。handle 取得の失敗時は
   * 未割当てとして扱い、表示の組み立てを壊さない。
   */
  private buildTextState(): TextDisplayState {
    const handle = this.textHandle;
    const localSessionId = this.textLocalSessionId;
    if (handle === null || localSessionId === null) {
      return {
        localSessionId: null,
        instanceId: null,
        canSend: false,
        pendingId: null,
        lastResult: null,
        stats: { attempts: 0, acknowledged: 0, unknown: 0 },
      };
    }
    let state: TextPluginState;
    try {
      state = handle.getState();
    } catch {
      return {
        localSessionId: null,
        instanceId: null,
        canSend: false,
        pendingId: null,
        lastResult: null,
        stats: { attempts: 0, acknowledged: 0, unknown: 0 },
      };
    }
    return {
      localSessionId,
      instanceId: handle.instanceId,
      canSend: state.canSend,
      pendingId: state.pendingId,
      lastResult: state.lastResult,
      stats: state.stats,
    };
  }
}
