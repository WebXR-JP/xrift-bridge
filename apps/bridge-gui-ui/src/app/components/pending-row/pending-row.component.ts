/**
 * 保留行の比較コード表示と操作の行部品。
 *
 * 比較コードの入力欄は持たず、自動取得した表示用コードを示すだけである。
 * 取得成功まで承認は押せず、取得後は追加入力・確認なしで承認できる。
 * 比較コード本文は送るだけで記録しない（ログ・snapshot に残さない）。
 * 行は札（`--card` 背景・`--border` 境界・角丸 8・padding 16）で描き、
 * 操作は helm ボタン（承認 primary・再試行・取下げ outline）にする。
 */
import { Component, input, output } from "@angular/core";
import type { PairingViewResult } from "bridge-gui-contract/management";
import type { PairingCodeState } from "../../Services/management.service.ts";
import { HlmButton } from "../../ui/button/hlm-button.ts";

@Component({
  selector: "app-pending-row",
  standalone: true,
  imports: [HlmButton],
  templateUrl: "./pending-row.component.html",
})
export class PendingRowComponent {
  /** 照合対象の要求識別子。行の同一性に使う。 */
  readonly requestId = input.required<string>();

  /** 表示用の比較コード取得結果。未取得の間は undefined である。 */
  readonly view = input<PairingViewResult | undefined>(undefined);

  /** 比較コードの取得状態。承認可否と本文表示の分岐に使う。 */
  readonly codeState = input<PairingCodeState>("unfetched");

  /** 比較コード取得の再試行の要求。取得失敗時の明示操作だけに使う。 */
  readonly retryRequested = output<string>();

  /** 承認の要求。要求識別子だけを載せる。 */
  readonly approveRequested = output<string>();

  /** 取り下げの要求。 */
  readonly rejectRequested = output<string>();

  /** 取得成功まで承認は押せない。取得後は追加入力なしで承認できる。 */
  get canApprove(): boolean {
    return this.codeState() === "ready";
  }

  /** 比較コード取得の再試行を要求する。 */
  onRetry(): void {
    this.retryRequested.emit(this.requestId());
  }

  /** 要求識別子だけで承認を要求する。 */
  onApprove(): void {
    this.approveRequested.emit(this.requestId());
  }

  /** 取り下げを要求する。 */
  onReject(): void {
    this.rejectRequested.emit(this.requestId());
  }
}
