/**
 * プラグイン子画面スロットの代替表示部品。
 *
 * 子画面が出せないときの文言だけを担い、スロット（`#plugin-slot`）内で
 * 子画面タグと同一矩形に重ねて出す。状態の判定は共有の導出関数
 * （`derivePluginViewState`）の結果を受け、ここでは複製しない。
 * `answered` のときは状態文を出さず子画面のみにする。
 * 重なり順で子画面より上に描かれても操作を奪わないよう、受け口自体は
 * 操作を受け付けず、再試行・再読み込みのボタンだけ受け付ける。
 */
import { Component, input, output } from "@angular/core";
import type { PluginViewState } from "../../plugin-view-state.ts";
import { HlmButton } from "../../ui/button/hlm-button.ts";

@Component({
  selector: "app-plugin-view-fallback",
  standalone: true,
  imports: [HlmButton],
  templateUrl: "./plugin-view-fallback.component.html",
  // ADR: 代替表示は子画面タグと同一矩形に重なるため、受け口自体は透過させ
  // （`pointer-events: none`）、空の `answered` が子画面への操作を奪わない。
  // 操作可能なボタンだけテンプレートで `pointer-events: auto` を戻す。
  // 大域規則に置かず受け口の属性に閉じるため、試験でも値で確かめられる。
  host: {
    style: "pointer-events: none",
  },
})
export class PluginViewFallbackComponent {
  /** 共有の導出関数が求めたスロットの状態。 */
  readonly state = input.required<PluginViewState>();

  /** 対象個体の再試行の要求。App 経由で個体限定の要求を送る。 */
  readonly retryRequested = output<void>();

  /** 表示状態の再読み込みの要求。App 経由で snapshot を読み直す。 */
  readonly reloadRequested = output<void>();

  // ADR: テンプレートの `@switch` では union の絞り込みが効かないため、
  // 失敗欄だけを返す小さな読取りに閉じる。判定自体は共有の導出に任せ、
  // ここでは複製しない。
  /** 失敗理由。`failed` 以外では空文字である。 */
  failureReason(): string {
    const current = this.state();
    return current.kind === "failed" ? current.reason : "";
  }

  /** 再試行要求中の場合に真。 */
  isRetryPending(): boolean {
    const current = this.state();
    return current.kind === "failed" && current.retryPending;
  }

  /** 再試行要求自体が失敗した場合に真。 */
  isRetryRequestFailed(): boolean {
    const current = this.state();
    return current.kind === "failed" && current.retryRequestFailed;
  }
}
