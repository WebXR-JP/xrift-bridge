/**
 * Angular 画面の入れ物。
 *
 * 起動時に初回取得と準備完了通知だけを行い、表示は各部品に任せる。
 * 起動時の自動走行はしない（検証は明示の試験・ハーネスで行う）。
 * 比較コード本文・業務 payload・テキスト本文は扱わない。
 */
import { Component, ElementRef, ViewChild } from "@angular/core";
import type { OnInit } from "@angular/core";
import { AcceptanceToggleComponent } from "./components/acceptance-toggle/acceptance-toggle.component.ts";
import { ConnectionListComponent } from "./components/connection-list/connection-list.component.ts";
import { EventLogComponent } from "./components/event-log/event-log.component.ts";
import { ManagementService } from "./Services/management.service.ts";
import { PendingListComponent } from "./components/pending-list/pending-list.component.ts";
import type { ApproveRequest } from "./components/pending-row/pending-row.component.ts";
import { PluginMountsComponent } from "./components/plugin-mounts/plugin-mounts.component.ts";
import { SessionListComponent } from "./components/session-list/session-list.component.ts";
import { SpikeSectionComponent } from "./components/spike-section/spike-section.component.ts";
import { StatusSummaryComponent } from "./components/status-summary/status-summary.component.ts";
import { TextCardComponent } from "./components/text-card/text-card.component.ts";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    AcceptanceToggleComponent,
    ConnectionListComponent,
    EventLogComponent,
    PendingListComponent,
    PluginMountsComponent,
    SessionListComponent,
    SpikeSectionComponent,
    StatusSummaryComponent,
    TextCardComponent,
  ],
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit {
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

  /** テキスト操作の失敗表示。 */
  get textError() {
    return this.management.textError;
  }

  /** 段0スパイクの所有一覧。 */
  get spikeMounts() {
    return this.management.spikeMounts;
  }

  @ViewChild("spikeHost", { static: true })
  spikeHost?: ElementRef<HTMLElement>;

  @ViewChild("pluginHost", { static: true })
  pluginHost?: ElementRef<HTMLElement>;

  constructor(private readonly management: ManagementService) {}

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
   * 診断を割り当てる（人間の操作用）。
   *
   * @param localSessionId - 割り当てる生存セッションのローカル識別子。
   */
  async onAssignDiagnostics(localSessionId: string): Promise<void> {
    await this.management.assignDiagnostics(localSessionId);
  }

  /** テキストを割り当てる（人間の操作用）。 */
  async onAssignText(): Promise<void> {
    await this.management.assignText();
  }

  /** テキストの割当てを外す（人間の操作用）。 */
  async onUnassignText(): Promise<void> {
    await this.management.unassignText();
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
