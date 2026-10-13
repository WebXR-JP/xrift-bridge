/**
 * 採用中の表示状態の要約表示。
 *
 * snapshot の描画だけを担い、取得・操作は行わない。比較コード本文・業務
 * payload・テキスト本文は扱わない（改訂番号・起動状態・件数のみ）。
 */
import { Component, input } from "@angular/core";
import type { ManagementSnapshot } from "bridge-gui-contract/management";

@Component({
  selector: "app-status-summary",
  standalone: true,
  templateUrl: "./status-summary.component.html",
})
export class StatusSummaryComponent {
  /** 採用中の表示状態。未取得の間は null である。 */
  readonly snapshot = input<ManagementSnapshot | null>(null);

  /**
   * 公開先の表示文を作る。URL と受付中／停止中だけを示す。
   *
   * @param current - 採用中の表示状態。
   * @returns 未公開または URL と受付状態の表示文。
   */
  endpointText(current: ManagementSnapshot): string {
    if (current.endpoint === null) {
      return "未公開";
    }
    return `${current.endpoint.url}（${current.endpoint.listening ? "受付中" : "停止中"}）`;
  }
}
