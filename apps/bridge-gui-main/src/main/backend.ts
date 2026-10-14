/**
 * GUI バックエンド。同一 main プロセス内で `bridge-server` と
 * `bridge-app-core` と汎用管理層を組み立てる。
 *
 * Electron・native API に依存しない。表示状態 DTO（`bridge-gui-contract/management`）
 * と限定操作だけを公開し、テストから直接生成して使える。
 * `BridgeServer` や生の `Session` を Webview へ渡さない。
 *
 * 組立は server→core→manager の順に行い、注入された登録関数でプラグインを
 * 登録する（同梱の選択と登録順は composition root が宣言し、backend は
 * 汎用の登録口だけを渡す）。登録結果は一時表へ組み立て、全登録成功後に
 * 公開する。管理 DTO の種別表（`pluginKinds`）は登録内容から生成し、
 * backend に種別分岐を持たない。
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
import { createBridgeAppCore, type BridgeAppCore } from "bridge-app-core/core";
import type {
  AdmissionState,
  BackendStatus,
  ManagementSnapshot,
  OperationAck,
  OwnedPluginInstanceSummary,
  PairingViewResult,
  PluginBindingSummary,
  PluginKindSummary,
  StateChangedMessage,
  UnassignPluginResult,
} from "bridge-gui-contract/management";
import { buildPluginNavigationRules } from "bridge-gui-contract/plugin-instance";
import { PluginInstanceManager } from "./plugin-instance-manager.ts";
import type { OwnedPluginInstanceInfo, Stop } from "bridge-gui-plugin-sdk/management";
import type {
  GuiPluginRegisterFunction,
  GuiPluginRegistrar,
} from "bridge-gui-plugin-sdk/registration";
import type { PluginManagerSessions } from "./plugin-instance-management.ts";
import { PluginCompanionRegistry } from "./plugin-companions.ts";

/** 既定の待ち受けポート。 */
export const DEFAULT_BRIDGE_PORT = 3100;

/** `GuiBackend.create` の依存注入口。 */
export interface GuiBackendDependencies {
  /**
   * プラグインの登録関数。同梱の選択と登録順は composition root が宣言する。
   *
   * backend は composition root を import せず、受け取った登録関数だけを
   * 使う。省略時は空構成（登録なし）であり、backend 側で既定の同梱登録を
   * 持たない。空構成の検証は明示的に空登録関数を渡す。
   */
  readonly registerPlugins?: GuiPluginRegisterFunction;
}

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
  return { accepting: info.enabled };
}

/**
 * 所有記録の表示形を作る。段階の絞り込みはしない。
 *
 * @param record - 管理層の所有記録の写し。
 * @returns 子画面へ渡せる所有の表示状態。
 */
function toOwnedSummary(record: OwnedPluginInstanceInfo): OwnedPluginInstanceSummary {
  return {
    pluginKind: record.kind,
    pluginId: record.pluginId,
    instanceId: record.instanceId,
    localSessionId: record.localSessionId,
    portId: record.portId,
    phase: record.phase,
  };
}

/**
 * GUI バックエンド。`bridge-server` と `bridge-app-core` と汎用管理層の
 * 組み立てと表示状態の提供・限定操作の実行を担う。
 *
 * 生成は {@link GuiBackend.create} で行う。server 起動に失敗しても
 * 例外にせず起動失敗状態で返すため、管理画面は表示と終了を続けられる。
 * 終了は {@link GuiBackend.close} に集約し、冪等である。
 */
export class GuiBackend {
  private status: BackendStatus = "starting";
  private server: BridgeServer | null = null;
  private core: BridgeAppCore | null = null;
  private manager: PluginInstanceManager | null = null;
  private readonly registry = new PluginCompanionRegistry();
  private pluginKinds: PluginKindSummary[] = [];
  private managementUnsubscribe: Unsubscribe | null = null;
  private readonly listeners = new Set<(message: StateChangedMessage) => void>();
  /**
   * 管理層の問題記録。段階と識別子だけを持ち、原因・本文は載せない。
   *
   * 表示 DTO には載せず、記録用の上限だけを保つ。
   */
  private readonly issueLog: Array<{
    readonly stage: string;
    readonly pluginKind: string | null;
    readonly instanceId: string | null;
  }> = [];
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
   * 表示（`getSnapshot`）と終了（`close`）だけを提供する。プラグイン登録は
   * `deps.registerPlugins` で受け、省略時は空構成とする。登録途中の例外では
   * 部分登録を公開せず、生成済みの資源を回収して失敗状態にする。
   *
   * @param options - 待ち受けポート・許可 Origin の設定。
   * @param deps - プラグイン登録関数の注入口。省略時は空構成である。
   * @returns 生成したバックエンド。起動失敗時は `startupError` を持つ。
   */
  static async create(
    options: GuiBackendOptions = {},
    deps?: GuiBackendDependencies,
  ): Promise<GuiBackend> {
    const backend = new GuiBackend();
    const allowedOrigins = options.allowedOrigins ?? [PRODUCTION_ORIGIN];
    // ADR: 省略時の空関数は既定の同梱登録ではない。同梱の選択は composition root
    // が担い、backend は受け取った登録関数だけを使う。backend 側に既定登録を
    // 置くと具象への依存が戻るため、空構成の検証は明示的に空登録関数を渡す。
    const registerPlugins: GuiPluginRegisterFunction = deps?.registerPlugins ?? ((): void => {});
    try {
      const server = await createBridgeServer({
        port: options.port ?? DEFAULT_BRIDGE_PORT,
        allowedOrigins: [...allowedOrigins],
      });
      await backend.attach(server, registerPlugins);
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
   * backend ごとの companion 登録表。coordinator・channel factory への
   * 注入用である。起動失敗時は空の表を返す。
   */
  get companionRegistry(): PluginCompanionRegistry {
    return this.registry;
  }

  /**
   * 起動した server と基盤・管理層を結び付け、注入された登録関数で
   * プラグインを登録する。
   *
   * server→core→manager の順に生成する。基盤の購読を先に core 側で確定して
   * から、後続の管理通知をバックエンド側で受ける。購読前の既存セッションは
   * core が一覧で初期走査するため、取りこぼさない。管理通知の配送順は
   * 購読順である。
   *
   * 登録関数へは生 backend・管理層全体ではなく、汎用の登録口だけを持つ
   * registrar を渡す。登録結果は一時表へ組み立て、全登録成功後に公開する。
   * 登録途中の例外では部分登録を公開せず、生成済みの manager・core・server
   * を回収して失敗状態にする。
   *
   * @param server - 起動したブリッジ。
   * @param registerPlugins - プラグインの登録関数。
   */
  private async attach(
    server: BridgeServer,
    registerPlugins: GuiPluginRegisterFunction,
  ): Promise<void> {
    const core = createBridgeAppCore(server);
    const sessions: PluginManagerSessions = {
      list: () =>
        server.listSessions().map((info) => ({
          localSessionId: info.localSessionId,
          connectionId: info.connectionId,
          sessionId: info.sessionId,
          capability:
            info.kind === "reliable"
              ? { kind: "reliable" as const, direction: "bidirectional" as const }
              : { kind: "latest" as const, direction: "to_server" as const },
          alive: server.getSession(info.localSessionId)?.isAlive === true,
        })),
      onEnded: (listener: (localSessionId: string) => void): Stop => {
        const unsubscribe = server.onManagementEvent((event) => {
          if (event.kind === "session-ended") {
            listener(event.session.localSessionId);
          }
        });
        return () => {
          try {
            unsubscribe();
          } catch {
            // 購読解除の失敗は管理層を壊さない。
          }
        };
      },
    };
    const manager = new PluginInstanceManager({
      core,
      sessions,
      clock: {
        every: (intervalMs: number, tick: () => void): Stop => {
          const timer = setInterval(tick, intervalMs);
          // ADR: `as` で `unref` の有無を主張する理由は、実行系（Node・Bun）で
          // タイマー型が異なるためである。待機の維持には使わず、単独滞留での
          // 固着を避けるために外せる場合だけ外す。根拠は Node の `Timeout.unref`
          // と Bun の互換タイマーであり、無い環境では何もしない。
          const held = timer as unknown as { unref?: () => void };
          try {
            held.unref?.();
          } catch {
            // 解除の失敗は監視を止めない。
          }
          return () => {
            clearInterval(timer);
          };
        },
      },
      onChanged: () => {
        this.requestNotify();
      },
      onIssue: (issue) => {
        this.recordIssue(issue.stage, issue.binding);
      },
    });
    const stagedRegistry = new PluginCompanionRegistry();
    const stagedKinds: PluginKindSummary[] = [];
    const registrar: GuiPluginRegistrar = {
      registerPlugin(registration) {
        const access = manager.register(registration.management);
        const companion = registration.createCompanion(access);
        if (companion.kind !== registration.management.kind) {
          throw new Error("companion の種別が管理記述子と一致しない。");
        }
        stagedRegistry.register(companion);
        stagedKinds.push({
          pluginKind: registration.management.kind,
          pluginId: registration.management.definition.pluginId,
          label: companion.label,
          maxInstances: registration.management.assignment.maxInstances,
        });
      },
    };
    try {
      registerPlugins(registrar);
    } catch (error) {
      // 部分登録を公開せず、生成済みの資源を回収して失敗状態にする。
      // 一時表の中身は捨て、公開表・種別表には載せない。
      try {
        manager.close();
      } catch {
        // 管理層終了の失敗は後始末を止めない。
      }
      try {
        core.close();
      } catch {
        // 基盤終了の失敗は待受停止を止めない。
      }
      try {
        await server.close();
      } catch {
        // 待受停止の失敗は失敗状態の記録を止めない。
      }
      this.markFailed(error);
      return;
    }
    // 全登録成功後に公開する。
    this.server = server;
    this.core = core;
    this.manager = manager;
    for (const companion of stagedRegistry.list()) {
      this.registry.register(companion);
    }
    this.pluginKinds = stagedKinds;
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
   * 登録途中の失敗では呼び出し側で manager・core・server の回収済みであり、
   * ここでは原因の記録と失敗状態への遷移だけを行う。
   *
   * @param error - 起動失敗の原因。
   */
  private markFailed(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.status = "failed";
    this.requestNotify();
  }

  /**
   * 操作可能な server・基盤・管理層を取り出す。
   *
   * @returns 操作対象の server・基盤・管理層。
   * @throws `Error` — 終了中・起動失敗の場合。新規操作を受け付けない。
   */
  private operable(): {
    server: BridgeServer;
    core: BridgeAppCore;
    manager: PluginInstanceManager;
  } {
    if (this.status === "stopping" || this.disposed) {
      throw new Error("終了中のため操作を受け付けない。");
    }
    if (
      this.server === null ||
      this.core === null ||
      this.manager === null ||
      this.status !== "ready"
    ) {
      throw new Error("起動に失敗しているため操作を受け付けない。");
    }
    return { server: this.server, core: this.core, manager: this.manager };
  }

  /**
   * 管理層の問題を安全に記録する。
   *
   * 段階と識別子だけを残し、原因・本文は管理 DTO・開発応答・ログへ
   * 無条件に流さない（本文の混入があり得るため）。
   *
   * @param stage - 失敗した段階。
   * @param binding - 対象の束縛情報。特定できない場合は `null`。
   */
  private recordIssue(
    stage: string,
    binding: {
      readonly kind: string;
      readonly instanceId: string;
    } | null,
  ): void {
    this.issueLog.push({
      stage,
      pluginKind: binding?.kind ?? null,
      instanceId: binding?.instanceId ?? null,
    });
    if (this.issueLog.length > 32) {
      this.issueLog.splice(0, this.issueLog.length - 32);
    }
    console.log(
      `[bridge-gui] 管理層の問題を記録した: stage=${stage} kind=${binding?.kind ?? "-"} instanceId=${binding?.instanceId ?? "-"}`,
    );
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
   * 保留中の通知は先に確定する。回収の副作用は付けない。
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
   * 保留を要求 ID だけで承認する。承認可否は常に server が決める。
   *
   * 比較コードは表示専用であり、承認の引数にしない。
   *
   * @param params - 承認する要求の識別子。
   * @returns 承認結果。
   * @throws `RangeError` — 識別子が空・文字列でない場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  approvePairing(params: { requestId: unknown }): ApprovalResult {
    const { server } = this.operable();
    const requestId = assertId(params.requestId, "requestId");
    const result = server.approvePairing(requestId);
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
   * 汎用プラグインの割当て。種別トークンと生存セッションの指定だけを受け、
   * 管理記述子に従って割り当てる。
   *
   * `localSessionId` を省略した場合は方針に従い候補から選ぶ。指定した
   * 場合はその生存セッションへ割り当て、方針の選択結果が指定と一致しな
   * ければ拒否する。割当ての確定後は通知予約を行い、後続の状態は
   * `stateChanged` で受け取る。
   *
   * @param params - 種別トークンと割当て先の生存セッションの識別子（省略可）。
   * @returns 確定した束縛の表示状態。
   * @throws `RangeError` — 識別子が不正・候補不足・曖昧・上限超過の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  assignPlugin(params: { pluginKind: unknown; localSessionId?: unknown }): PluginBindingSummary {
    const { manager } = this.operable();
    const pluginKind = assertId(params.pluginKind, "pluginKind");
    const binding =
      params.localSessionId === undefined
        ? manager.assign(pluginKind, { mode: "auto" })
        : manager.assign(pluginKind, {
            mode: "session",
            localSessionId: assertId(params.localSessionId, "localSessionId"),
          });
    return {
      pluginKind: binding.kind,
      pluginId: binding.pluginId,
      instanceId: binding.instanceId,
      localSessionId: binding.localSessionId,
      portId: binding.portId,
    };
  }

  /**
   * 汎用プラグインの解除。描画した所有記録の三識別子で照合し、
   * 完全一致する所有だけを回収する。
   *
   * 所有があるのに三識別子が不一致の場合は拒否し、新束縛へ転送しない。
   * 回収済み・未知の識別子は `{released:false, issues:[]}` とする。
   * `cleanupFailed` は自動再試行しない。解除の成否は戻り値で示し、
   * 後続の状態は `stateChanged` で受け取る。
   *
   * @param params - 描画した所有記録の三識別子。
   * @returns 解放結果。問題の原因・状態は載せない。
   * @throws `RangeError` — 識別子が不正・所有中の三識別子不一致の場合。
   * @throws `Error` — 終了中・起動失敗の場合。
   */
  unassignPlugin(params: {
    instanceId: unknown;
    localSessionId: unknown;
    portId: unknown;
  }): UnassignPluginResult {
    const { manager } = this.operable();
    const instanceId = assertId(params.instanceId, "instanceId");
    const localSessionId = assertId(params.localSessionId, "localSessionId");
    const portId = assertId(params.portId, "portId");
    const owned = manager.listOwned().find((record) => record.instanceId === instanceId);
    if (owned === undefined) {
      return { released: false, issues: [] };
    }
    if (owned.localSessionId !== localSessionId || owned.portId !== portId) {
      throw new RangeError("現在の所有と識別子が一致しない。");
    }
    const result = manager.unassign(owned.kind, instanceId);
    return {
      released: result.released,
      issues: result.issues.map((issue) => ({ stage: issue.stage })),
    };
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
   * 管理通知を処理する。種別固有の回収は持たず、`manager.reconcile()` で
   * 現割当ての無音取消しを回収し、その後の通知予約は既存経路にまとめる。
   *
   * 読み取り（`getSnapshot`・companion 読取）に回収の副作用は入れない。
   *
   * @param _event - サーバーの管理通知。種別を問わず照合するため中身は読まない。
   */
  private handleManagementEvent(_event: ManagementEvent): void {
    try {
      this.manager?.reconcile();
    } catch {
      // 照合の失敗は通知を止めない。
    }
    this.requestNotify();
  }

  /**
   * 終了する。冪等であり、二度目以降は同じ終了を待つ。
   *
   * 終了中は新規操作を拒否し、受付の無効化 → `manager.close()` →
   * 基盤を終了する（割当ての失効・中断、購読解除）→ server を閉じる
   * （待受停止）の順で後始末する。途中失敗で後続を止めない。
   * 購読・通知予約の解除は最後に行う。
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
        this.manager?.close();
      } catch {
        // 管理層終了の失敗は後始末を止めない。
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

  /** 購読・通知予約・保持を解く。 */
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
    this.manager = null;
  }

  /** 現在の表示スナップショットを組み立てる。比較コード本文は含めない。 */
  private buildSnapshot(): ManagementSnapshot {
    const server = this.server;
    const core = this.core;
    const manager = this.manager;
    // 遷移規則は登録成功後の解決済み view パス集合から生成する。静的登録の
    // ため backend 生存期間中は不変であり、`getSnapshot` と `stateChanged`
    // の両方に同じ確定経路で載る。登録が無ければ基底（全面拒否＋空ページ）になる。
    const pluginNavigationRules = buildPluginNavigationRules(
      this.registry.list().map((companion) => companion.viewPath),
    );
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
        kinds: [...this.pluginKinds],
        instances: manager === null ? [] : manager.listOwned().map(toOwnedSummary),
        assignments:
          core === null
            ? []
            : core.listAssignments().map((assignment) => ({
                localSessionId: assignment.localSessionId,
                instanceId: assignment.instanceId,
                portId: assignment.portId,
              })),
      },
      // 実プラグイン子画面の配置は main 側の対応付けが持ち、backend は
      // 所有しない。ここでは空を返し、RPC 層で対応付けの現在値を載せる。
      pluginMounts: [],
      pluginMountFailures: [],
      pluginNavigationRules,
    };
  }
}
