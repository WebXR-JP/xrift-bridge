/**
 * 保留一覧（照合待ち）の表示部品。
 *
 * 取得・操作は行わず、表示と要求の送出だけを担う。行の同一性は `requestId`
 * で保持し、状態更新で行を使い回す。比較コード本文は
 * snapshot・ログに残さない（表示用の取得結果だけを行へ渡す）。
 * 比較コードは自動取得が原則であり、一覧からの明示要求は再試行だけである。
 * 前の区画との区切りは helm separator で置く（App は変えない）。
 */
import { Component, input, output } from "@angular/core";
import type { PairingViewResult, PendingEntry } from "bridge-gui-contract/management";
import type { PairingCodeState } from "../../Services/management.service.ts";
import { HlmSeparator } from "../../ui/separator/hlm-separator.ts";
import { PendingRowComponent } from "../pending-row/pending-row.component.ts";

@Component({
  selector: "app-pending-list",
  standalone: true,
  imports: [PendingRowComponent, HlmSeparator],
  templateUrl: "./pending-list.component.html",
})
export class PendingListComponent {
  /** 保留一覧（コード本文なし）。 */
  readonly pending = input<readonly PendingEntry[]>([]);

  /** 保留行の一時状態（表示用の比較コード取得結果）。 */
  readonly views = input<ReadonlyMap<string, PairingViewResult>>(new Map());

  /** 比較コードを取得中の保留の要求識別子一覧。 */
  readonly fetchPending = input<readonly string[]>([]);

  /** 比較コードの取得 RPC に失敗した保留の要求識別子一覧。 */
  readonly fetchFailed = input<readonly string[]>([]);

  /** 比較コード取得の再試行の要求。 */
  readonly retryRequested = output<string>();

  /** 承認の要求。要求識別子だけを載せる。 */
  readonly approveRequested = output<string>();

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

  /**
   * 指定した保留の比較コードの取得状態を返す。行の表示分岐に使う。
   *
   * 取得済み（表示できるコードあり）・取得中・失敗・未取得を返す。
   * 未取得と取得中はいずれも取得中表示にする。
   *
   * @param requestId - 照合対象の要求識別子。
   * @returns 取得状態。
   */
  codeStateFor(requestId: string): PairingCodeState {
    const view = this.views().get(requestId);
    if (view?.available === true) {
      return "ready";
    }
    if (this.fetchPending().includes(requestId)) {
      return "fetching";
    }
    if (this.fetchFailed().includes(requestId) || view !== undefined) {
      return "failed";
    }
    return "unfetched";
  }
}
