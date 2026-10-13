/**
 * 保留一覧（照合待ち）の表示部品。
 *
 * 取得・操作は行わず、表示と要求の送出だけを担う。行の同一性は `requestId`
 * で保持し、状態更新で入力値・フォーカスを失わせない。比較コード本文は
 * snapshot・ログに残さない（表示用の取得結果だけを行へ渡す）。
 */
import { Component, input, output } from "@angular/core";
import type { PairingViewResult, PendingEntry } from "bridge-gui-contract/management";
import { PendingRowComponent } from "../pending-row/pending-row.component.ts";
import type { ApproveRequest } from "../pending-row/pending-row.component.ts";

@Component({
  selector: "app-pending-list",
  standalone: true,
  imports: [PendingRowComponent],
  templateUrl: "./pending-list.component.html",
})
export class PendingListComponent {
  /** 保留一覧（コード本文なし）。 */
  readonly pending = input<readonly PendingEntry[]>([]);

  /** 保留行の一時状態（表示用の比較コード取得結果）。 */
  readonly views = input<ReadonlyMap<string, PairingViewResult>>(new Map());

  /** 比較コード表示の要求。 */
  readonly showRequested = output<string>();

  /** 承認の要求。入力欄の比較コードを載せる。 */
  readonly approveRequested = output<ApproveRequest>();

  /** 取り下げの要求。 */
  readonly rejectRequested = output<string>();

  /**
   * 指定した保留の表示用取得結果を返す。未取得なら undefined である。
   *
   * @param requestId - 照合対象の要求識別子。
   * @returns 表示用の取得結果または undefined。
   */
  viewFor(requestId: string): PairingViewResult | undefined {
    return this.views().get(requestId);
  }
}
