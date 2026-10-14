/**
 * Angular 画面の入れ物。
 *
 * 起動時に初回取得と準備完了通知だけを行い、表示は各部品に任せる。
 * 起動時の自動走行はしない（検証は明示の試験・ハーネスで行う）。
 * 比較コード本文・業務 payload・テキスト本文は扱わない。
 */
import { Component, ElementRef, ViewChild, effect, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { AcceptanceToggleComponent } from "./components/acceptance-toggle/acceptance-toggle.component.ts";
import { ConnectionListComponent } from "./components/connection-list/connection-list.component.ts";
import { EventLogComponent } from "./components/event-log/event-log.component.ts";
import { ManagementService } from "./Services/management.service.ts";
import { PendingListComponent } from "./components/pending-list/pending-list.component.ts";
import type { ApproveRequest } from "./components/pending-row/pending-row.component.ts";
import { PluginMountsComponent } from "./components/plugin-mounts/plugin-mounts.component.ts";
import { PluginListComponent } from "./components/plugin-list/plugin-list.component.ts";
import { PluginOperationsComponent } from "./components/plugin-operations/plugin-operations.component.ts";
import { SessionListComponent } from "./components/session-list/session-list.component.ts";
import { ShellComponent } from "./components/shell/shell.component.ts";
import type { ShellStatus } from "./components/shell/shell.component.ts";
import { SpikeSectionComponent } from "./components/spike-section/spike-section.component.ts";
import { StatusSummaryComponent } from "./components/status-summary/status-summary.component.ts";
import type {
  PluginAssignRequest,
  PluginUnassignRequest,
} from "./components/plugin-list/plugin-list.component.ts";
import { DEFAULT_VIEW_KEY, VIEW_DEFINITIONS } from "./view-config.ts";
import type { ViewKey } from "./view-config.ts";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    AcceptanceToggleComponent,
    ConnectionListComponent,
    EventLogComponent,
    PendingListComponent,
    PluginListComponent,
    PluginMountsComponent,
    PluginOperationsComponent,
    SessionListComponent,
    ShellComponent,
    SpikeSectionComponent,
    StatusSummaryComponent,
  ],
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit {
  /** 画面定義。ヘッダとナビが同一定義を参照する。 */
  readonly views = VIEW_DEFINITIONS;

  // ADR: 画面選択は App のローカル signal に閉じる。Router も汎用 store も
  // 追加しない。snapshot の更新で選択は戻さない（表示切替は業務 RPC を送らない）。
  private readonly selected = signal<ViewKey>(DEFAULT_VIEW_KEY);

  /** 選択中の画面キー。 */
  readonly selectedKey = this.selected.asReadonly();

  // ADR: 操作対象の個体選択も App のローカル signal に閉じる。初期は `text`
  // 種別があればそれ、無ければ先頭である。改訂進行・別個体追加では変えず、
  // 選択個体が消えたときだけ残存個体へ移す。所有が0なら `null` である。
  // タブ切替は表示制御だけであり、業務 RPC は送らない。
  private readonly selectedInstance = signal<string | null>(null);

  /** 現在選択中のプラグインインスタンス。所有が無い間は `null`。 */
  readonly activeInstanceId = this.selectedInstance.asReadonly();
  /** 採用中の表示状態。 */
  get snapshot() {
    return this.management.snapshot;
  }

  /** 保留行の一時状態。 */
  get pairingViews() {
    return this.management.pairingViews;
  }

  /** 受信記録。 */
  get eventLog() {
    return this.management.eventLog;
  }

  /** 表示状態を取得済みの場合に真。 */
  get fetched() {
    return this.management.snapshot() !== null;
  }

  /** 段0スパイクの所有一覧。 */
  get spikeMounts() {
    return this.management.spikeMounts;
  }

  /**
   * 画面キーごとの件数。snapshot から都度導出し、別 signal へ複製しない。
   * 件数が無い画面と未取得は `null` であり、出さない。
   */
  get viewCounts(): Readonly<Record<ViewKey, number | null>> {
    const current = this.management.snapshot();
    if (current === null) {
      return { connections: null, sessions: null, plugins: null, operations: null, log: null };
    }
    return {
      connections: current.connections.length,
      sessions: current.sessions.length,
      plugins: null,
      operations: null,
      log: null,
    };
  }

  /**
   * シェル側の状態サマリ値。snapshot から都度導出し、別 signal へ複製しない。
   * 未取得の項目は `null` であり、事実として出さない。
   */
  get shellStatus(): ShellStatus {
    const current = this.management.snapshot();
    if (current === null) {
      return {
        accepting: null,
        pendingCount: null,
        connectionCount: null,
        sessionCount: null,
      };
    }
    return {
      accepting: current.admission.accepting,
      pendingCount: current.pending.length,
      connectionCount: current.connections.length,
      sessionCount: current.sessions.length,
    };
  }

  /**
   * 画面を選択する。表示切替だけであり、業務 RPC は送らない。
   *
   * @param key - 選択する画面のキー。
   */
  onSelectView(key: ViewKey): void {
    this.selected.set(key);
  }

  /**
   * 操作対象の個体を選択する。表示切替だけであり、業務 RPC は送らない。
   *
   * 子画面タグは動かさない（選択は effect 経由で表示制御に伝わる）。
   *
   * @param instanceId - 選択するインスタンスの識別子。
   */
  onSelectPluginInstance(instanceId: string): void {
    this.selectedInstance.set(instanceId);
  }

  @ViewChild("spikeHost", { static: true })
  spikeHost?: ElementRef<HTMLElement>;

  @ViewChild("pluginHost", { static: true })
  pluginHost?: ElementRef<HTMLElement>;

  constructor(private readonly management: ManagementService) {
    // ADR: 個体選択の同期と表示制御の通知は effect に閉じる。snapshot の
    // 改訂進行で選択を戻さず、選択個体の消滅時だけ移す。通知は表示切替だけ
    // であり、業務 RPC は送らない。初期は operations 未選択のため非表示である。
    effect(() => {
      const instances = this.management.snapshot()?.plugins.instances ?? [];
      const current = this.selectedInstance();
      if (instances.length === 0) {
        if (current !== null) {
          this.selectedInstance.set(null);
        }
        return;
      }
      if (current === null) {
        const text = instances.find((item) => item.pluginKind === "text");
        const initial = text ?? instances[0];
        if (initial !== undefined) {
          this.selectedInstance.set(initial.instanceId);
        }
        return;
      }
      if (!instances.some((item) => item.instanceId === current)) {
        const text = instances.find((item) => item.pluginKind === "text");
        const fallback = text ?? instances[0];
        if (fallback !== undefined) {
          this.selectedInstance.set(fallback.instanceId);
        } else {
          this.selectedInstance.set(null);
        }
      }
    });
    effect(() => {
      this.management.setPluginViewState(this.selected() === "operations", this.selectedInstance());
    });
  }

  async ngOnInit(): Promise<void> {
    console.log("[bridge-gui-ng] Angular 画面を起動した");
    // ADR: 子画面タグの配置先は安定した host 要素に固定し、テンプレートでは
    // 描画しない。表示状態の更新で作り替えない。
    // ADR: 読み込み直しの残存掃除（vanilla の init `spikeReset` 相当）は main
    // 側の `did-navigate` が遷移時に行うため、ここでは送らない（重複排除）。
    // 初期化では所有一覧の読直しだけを行い、タグと表示を合わせる。
    if (this.spikeHost !== undefined && this.pluginHost !== undefined) {
      this.management.registerMountHosts(
        this.spikeHost.nativeElement,
        this.pluginHost.nativeElement,
      );
    }
    await this.management.fetchInitial();
    this.management.notifyReady();
    await this.management.refreshSpike("初期化");
  }

  /** 受付を有効化する（人間の操作用）。 */
  async onEnable(): Promise<void> {
    await this.management.enableAcceptance();
  }

  /** 受付を無効化する（人間の操作用）。 */
  async onDisable(): Promise<void> {
    await this.management.disableAcceptance();
  }

  /**
   * 比較コード表示を取得する（人間の操作用）。承認はしない。
   *
   * @param requestId - 照合対象の要求識別子。
   */
  async onShowCode(requestId: string): Promise<void> {
    await this.management.showPairingView(requestId);
  }

  /**
   * 保留を承認する（人間の操作用）。承認可否は server が決める。
   *
   * @param request - 承認要求（要求識別子と入力欄の比較コード）。
   */
  async onApprove(request: ApproveRequest): Promise<void> {
    await this.management.approvePairing(request.requestId, request.code);
  }

  /**
   * 保留を取り下げる（人間の操作用）。
   *
   * @param requestId - 照合対象の要求識別子。
   */
  async onReject(requestId: string): Promise<void> {
    await this.management.rejectPairing(requestId);
  }

  /**
   * 接続を切断する（人間の操作用）。
   *
   * @param connectionId - 切断する接続の識別子。
   */
  async onDisconnect(connectionId: string): Promise<void> {
    await this.management.disconnectConnection(connectionId);
  }

  /**
   * プラグインを割り当てる（人間の操作用）。
   *
   * @param request - 種別トークンと割当て先の生存セッションの識別子。
   */
  async onAssignPlugin(request: PluginAssignRequest): Promise<void> {
    await this.management.assignPlugin(request.pluginKind, request.localSessionId);
  }

  /**
   * プラグインの割当てを外す（人間の操作用）。描画した所有記録の三識別子を渡す。
   *
   * クリック後に引き直さず、描画時の識別子を使う。
   *
   * @param request - 描画した所有記録の三識別子。
   */
  async onUnassignPlugin(request: PluginUnassignRequest): Promise<void> {
    await this.management.unassignPlugin(
      request.instanceId,
      request.localSessionId,
      request.portId,
    );
  }

  /** アプリを終了する（人間の操作用）。 */
  async onQuit(): Promise<void> {
    await this.management.quit();
  }

  /** 子画面を作る（人間の操作用）。 */
  async onCreateSpike(): Promise<void> {
    await this.management.createSpike();
  }

  /**
   * 子画面へ送る（人間の操作用）。混線の確認用である。
   *
   * @param mountId - 送り先マウントの識別子。
   */
  async onPushSpike(mountId: string): Promise<void> {
    await this.management.pushSpike(mountId);
  }

  /**
   * 子画面を外す（人間の操作用）。
   *
   * @param mountId - 外す子画面のマウント識別子。
   */
  async onDestroySpike(mountId: string): Promise<void> {
    await this.management.destroySpike(mountId);
  }

  /** 子画面を全て外す（人間の操作用）。 */
  async onResetSpikes(): Promise<void> {
    await this.management.resetSpikes();
  }

  /** 実プラグイン子画面の再試行を要求する（人間の操作用）。 */
  async onRetryPluginMounts(): Promise<void> {
    await this.management.retryPluginMounts();
  }
}
