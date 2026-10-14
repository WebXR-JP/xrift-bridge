/**
 * 埋込み検証（段0スパイク）の一覧表示部品。
 *
 * 所有一覧の表示と作成・送信・破棄・全破棄の要求送出だけを担う。
 * 子画面タグの配置は行わない（配置は保持者が安定した host へ行う）。
 * 状態の書き分けは vanilla（`renderSpikeStatus`）と同様である。
 */
import { Component, input, output } from "@angular/core";
import type { SpikeMountSummary } from "bridge-gui-contract/plugin-spike";
import { HlmButton } from "../../ui/button/hlm-button.ts";

@Component({
  selector: "app-spike-section",
  standalone: true,
  imports: [HlmButton],
  templateUrl: "./spike-section.component.html",
})
export class SpikeSectionComponent {
  /** 段0スパイクの所有一覧。 */
  readonly spikes = input<readonly SpikeMountSummary[]>([]);

  /** 子画面作成の要求。 */
  readonly createRequested = output<void>();

  /** 子画面への送信の要求。マウント識別子を載せる。 */
  readonly pushRequested = output<string>();

  /** 子画面破棄の要求。マウント識別子を載せる。 */
  readonly destroyRequested = output<string>();

  /** 子画面全破棄の要求。 */
  readonly resetRequested = output<void>();

  /**
   * 所有一覧の状態表示文を作る。
   *
   * @param mount - 所有一覧の表示状態。
   * @returns 準備完了・生成待ち・採用待ちのいずれか。
   */
  describeState(mount: SpikeMountSummary): string {
    if (mount.ready) {
      return "準備完了";
    }
    return mount.phase === "pending" ? "生成待ち" : "採用待ち";
  }
}
