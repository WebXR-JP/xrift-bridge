/**
 * Angular 画面の入れ物。
 *
 * 起動時に初回取得と準備完了通知だけを行い、表示は状態要約・受付操作の各部品に
 * 任せる。起動時の自動走行はしない（検証は明示の試験・ハーネスで行う）。
 * 比較コード本文・業務 payload・テキスト本文は扱わない。
 */
import { Component, ElementRef, ViewChild } from "@angular/core";
import type { OnInit } from "@angular/core";
import { AcceptanceToggleComponent } from "./acceptance-toggle.component.ts";
import { ManagementService } from "./management.service.ts";
import { StatusSummaryComponent } from "./status-summary.component.ts";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [AcceptanceToggleComponent, StatusSummaryComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  /** 採用中の表示状態。 */
  get snapshot() {
    return this.management.snapshot;
  }

  @ViewChild("spikeHost", { static: true })
  spikeHost?: ElementRef<HTMLElement>;

  constructor(private readonly management: ManagementService) {}

  async ngOnInit(): Promise<void> {
    console.log("[bridge-gui-ng] Angular 画面を起動した");
    await this.management.fetchInitial();
    this.management.notifyReady();
  }

  /** 受付を有効化する（人間の操作用）。 */
  async onEnable(): Promise<void> {
    await this.management.enableAcceptance();
  }

  /** 受付を無効化する（人間の操作用）。 */
  async onDisable(): Promise<void> {
    await this.management.disableAcceptance();
  }

  /** 子画面を作る（人間の操作用）。 */
  async onCreateSpike(): Promise<void> {
    if (this.spikeHost !== undefined) {
      await this.management.createSpike(this.spikeHost.nativeElement);
    }
  }
}
