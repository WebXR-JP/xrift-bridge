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
  type RejectionResult,
  type Unsubscribe,
} from "bridge-server";
import {
  createBridgeAppCore,
  DIAGNOSTIC_PORT_ID,
  diagnosticPlugin,
  type BridgeAppCore,
  type DiagnosticStats,
  type PluginInstanceHandle,
} from "bridge-app-core";
import type {
  AdmissionState,
  AssignmentSummary,
  BackendStatus,
  ManagementSnapshot,
  OperationAck,
  PairingViewResult,
  StateChangedMessage,
} from "../shared/management.ts";

/** 既定の待ち受けポート。 */
export const DEFAULT_BRIDGE_PORT = 3100;

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
  return { accepting: info.state === "open", remainingMs: info.remainingMs };
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
   * 一覧で初期走査するため、取りこぼさない。
   *
   * @param server - 起動したブリッジ。
   */
  private attach(server: BridgeServer): void {
    this.server = server;
    this.core = createBridgeAppCore(server);
    this.managementUnsubscribe = server.onManagementEvent(() => {
      this.requestNotify();
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
   * ペアリング受付を開く。
   *
   * @returns 開いた後の受付状態。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  openAcceptance(): AdmissionState {
    const { server } = this.operable();
    const admission = toAdmission(server.openAcceptance());
    this.requestNotify();
    return admission;
  }

  /**
   * ペアリング受付を閉じる。開始待ち・承認待ちを終了し、認可済みは維持する。
   *
   * @returns 閉じた後の受付状態。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  closeAcceptance(): AdmissionState {
    const { server } = this.operable();
    server.closeAcceptance();
    const admission = toAdmission(server.getAcceptance());
    this.requestNotify();
    return admission;
  }

  /**
   * 選択した保留の比較コード・期限を表示用に取得する。
   *
   * 照合のための表示だけであり、取得自体は承認しない。
   * コード一致による自動承認はしない。
   *
   * @param params - 照合対象の要求識別子。
   * @returns 比較コードと期限。対象がなければ未提供の理由。
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
        reason: "対象の保留が無い。期限切れ・承認済み・拒否済みの場合がある。",
      };
    }
    return {
      available: true,
      requestId: entry.requestId,
      // 比較コードは文字列のまま扱い、数値化しない（先頭ゼロを保持する）。
      code: entry.code,
      displayCode: formatPairingCode(entry.code),
      expiresAt: entry.expiresAt,
      expiresInMs: entry.remainingMs,
    };
  }

  /**
   * 保留を比較コード照合で承認する。期限・承認可否は常に server が決める。
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
   *
   * @param params - 割り当てる生存セッションのローカル識別子。
   * @returns 確定した割当ての表示状態。
   * @throws `RangeError` — 識別子が空・文字列でない、不明・不適合・
   * 二重割当ての場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  assignDiagnostics(params: { localSessionId: unknown }): AssignmentSummary {
    const { core } = this.operable();
    const localSessionId = assertId(params.localSessionId, "localSessionId");
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
    this.requestNotify();
    return { localSessionId, instanceId: handle.instanceId, portId: DIAGNOSTIC_PORT_ID };
  }

  /**
   * 終了する。冪等であり、二度目以降は同じ終了を待つ。
   *
   * 終了中は新規操作を拒否し、受付を閉じる → 基盤を終了する
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
        this.server?.closeAcceptance();
      } catch {
        // 受付終了の失敗は後始末を止めない。
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
      admission:
        server === null
          ? { accepting: false, remainingMs: 0 }
          : toAdmission(server.getAcceptance()),
      pending:
        server === null
          ? []
          : server
              .listPending()
              .map((entry) => ({ requestId: entry.requestId, expiresInMs: entry.remainingMs })),
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
    };
  }
}
