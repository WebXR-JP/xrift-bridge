/**
 * Angular スパイクのルートコンポーネント。
 *
 * 最小の実現性確認だけを担う。起動時に初回取得・準備完了・残存掃除を行い、
 * ヘッドレスでも判定できるよう限定操作（受付の有効化→無効化）と子画面配置の
 * 自動走行を1回だけ行う。表示は採用中の表示状態の要約に限り、比較コード本文・
 * 業務 payload・テキスト本文は扱わない。
 */
import { Component, ElementRef, ViewChild, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { ManagementService } from "./management.service.ts";

/** 自動走行の各段階の待ち時間（ミリ秒）。 */
const POLL_INTERVAL_MS = 100;

/** 自動走行の段階ごとの期限（ミリ秒）。 */
const GATE_TIMEOUT_MS = 5000;

@Component({
  selector: "app-root",
  standalone: true,
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  /** 採用中の表示状態。 */
  get snapshot() {
    return this.management.snapshot;
  }

  /** 自動走行の進行記録（表示・受信記録用）。 */
  readonly gateLog = signal<readonly string[]>([]);

  @ViewChild("spikeHost", { static: true })
  spikeHost?: ElementRef<HTMLElement>;

  constructor(private readonly management: ManagementService) {}

  async ngOnInit(): Promise<void> {
    console.log("[bridge-gui-ng] Angular スパイク画面を起動した");
    await this.management.fetchInitial();
    this.management.notifyReady();
    await this.management.resetSpike("初期化");
    await this.runGates();
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

  /** 進行を記録する（表示用。識別子・本文は載せない）。 */
  private record(message: string): void {
    this.gateLog.update((entries) => [...entries, message]);
    console.log(`[bridge-gui-ng] ${message}`);
  }

  /** 条件が満たされるまで待つ。期限切れの場合は偽を返す。 */
  private async waitFor(label: string, done: () => boolean): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if (done()) {
        return true;
      }
      if (Date.now() - started > GATE_TIMEOUT_MS) {
        this.record(`${label}が期限切れになった`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * 限定操作と子画面配置の自動走行を1回だけ行う。
   *
   * 受付の有効化→無効化で往復と push 更新を確かめ、元の無効状態に戻す。
   * 子画面は1つだけ作り、作り直されないことを確かめる。
   */
  private async runGates(): Promise<void> {
    const before = this.snapshot()?.revision ?? -1;
    await this.management.enableAcceptance();
    // push の到達は再取得とは別に改訂番号で確かめる。採用規約で無視されても到達は残る。
    const pushedAfterEnable = await this.waitFor("有効化後の push", () => {
      const revision = this.management.lastPushRevision();
      return revision !== null && revision > before;
    });
    const enabledSnapshot = this.snapshot();
    const enabled =
      pushedAfterEnable && enabledSnapshot !== null && enabledSnapshot.admission.accepting === true;
    this.record(
      enabled
        ? `受付の有効化が往復した revision=${enabledSnapshot.revision}`
        : "受付の有効化が往復しなかった",
    );
    const mid = this.management.lastPushRevision() ?? before;
    await this.management.disableAcceptance();
    const pushedAfterDisable = await this.waitFor("無効化後の push", () => {
      const revision = this.management.lastPushRevision();
      return revision !== null && revision > mid;
    });
    const disabledSnapshot = this.snapshot();
    const disabled =
      pushedAfterDisable &&
      disabledSnapshot !== null &&
      disabledSnapshot.admission.accepting === false;
    this.record(
      disabled
        ? `受付の無効化が往復した revision=${disabledSnapshot.revision}`
        : "受付の無効化が往復しなかった",
    );
    if (this.spikeHost !== undefined) {
      await this.management.createSpike(this.spikeHost.nativeElement);
    }
    const kept = await this.waitFor("子画面タグの保持", () => this.management.isSpikeTagKept());
    this.record(kept ? "子画面タグを置き同一性を保った" : "子画面タグを保てなかった");
    this.record("自動走行を終えた");
  }
}
