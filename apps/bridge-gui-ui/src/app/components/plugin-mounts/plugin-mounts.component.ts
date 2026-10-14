/**
 * 実プラグイン子画面の配置と失敗の表示部品。
 *
 * 配置一覧・失敗一覧の表示と再試行の要求送出だけを担う。
 * 子画面タグの配置は行わない（配置は保持者が安定した host へ行う）。
 * 一覧の書き分けは vanilla（`renderPluginMounts`）と同様であり、
 * 本文の入力・送信は子画面に任せる。失敗はその配置に局所化して示す。
 */
import { Component, input, output } from "@angular/core";
import type {
  PluginUiMountFailure,
  PluginUiMountPlacement,
} from "bridge-gui-contract/plugin-instance";
import { HlmButton } from "../../ui/button/hlm-button.ts";

@Component({
  selector: "app-plugin-mounts",
  standalone: true,
  imports: [HlmButton],
  templateUrl: "./plugin-mounts.component.html",
})
export class PluginMountsComponent {
  /** 実プラグイン子画面の配置一覧。 */
  readonly mounts = input<readonly PluginUiMountPlacement[]>([]);

  /** 実プラグイン子画面の失敗一覧。 */
  readonly failures = input<readonly PluginUiMountFailure[]>([]);

  /** 再試行の要求。 */
  readonly retryRequested = output<void>();

  /**
   * 配置一覧の状態表示文を作る。
   *
   * @param mount - 配置一覧の表示状態。
   * @returns 準備完了・生成待ち・採用待ちのいずれか。
   */
  describeState(mount: PluginUiMountPlacement): string {
    if (mount.ready) {
      return "準備完了";
    }
    return mount.phase === "pending" ? "生成待ち" : "採用待ち";
  }

  /** 配置も失敗も無い場合に真。 */
  get empty(): boolean {
    return this.mounts().length === 0 && this.failures().length === 0;
  }
}
