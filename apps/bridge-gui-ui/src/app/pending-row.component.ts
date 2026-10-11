/**
 * 保留行の比較コード入力と操作の行部品。
 *
 * 入力値はこの行だけが保持し、親の状態更新で値・フォーカスを失わせない。
 * 親は `requestId` の同一性（`track`）でこの行を使い回す。比較コード本文は
 * 送るだけで記録しない（ログ・snapshot に残さない）。
 */
import { Component, input, output, signal } from "@angular/core";
import type { PairingViewResult } from "bridge-gui-contract/management";

/** 承認要求の内容。入力欄の比較コードをそのまま載せる。 */
export interface ApproveRequest {
  /** 照合対象の要求識別子。 */
  readonly requestId: string;
  /** 入力欄の比較コード（整形しない）。 */
  readonly code: string;
}

@Component({
  selector: "app-pending-row",
  standalone: true,
  templateUrl: "./pending-row.component.html",
})
export class PendingRowComponent {
  /** 照合対象の要求識別子。行の同一性に使う。 */
  readonly requestId = input.required<string>();

  /** 表示用の比較コード取得結果。未取得の間は undefined である。 */
  readonly view = input<PairingViewResult | undefined>(undefined);

  /** 比較コード表示の要求。 */
  readonly showRequested = output<string>();

  /** 承認の要求。入力欄の比較コードを載せる。 */
  readonly approveRequested = output<ApproveRequest>();

  /** 取り下げの要求。 */
  readonly rejectRequested = output<string>();

  // ADR: 入力値は行の一時状態にのみ保持し、親の snapshot 更新で上書きしない。
  // `[value]` と `(input)` で結び付け、親からの入力値の流入経路を作らない。
  // 保留が消えたら行ごと破棄されるため、残存の掃除は不要である。
  /** 入力欄の比較コード。保留行の一時状態にのみ保持する。 */
  readonly code = signal("");

  /**
   * 入力欄の変更を一時状態へ写す。整形はしない。
   *
   * @param value - 入力欄の現在の値。
   */
  onCodeInput(value: string): void {
    this.code.set(value);
  }

  /** 比較コード表示を要求する。 */
  onShow(): void {
    this.showRequested.emit(this.requestId());
  }

  /** 入力欄の比較コードで承認を要求する。 */
  onApprove(): void {
    this.approveRequested.emit({ requestId: this.requestId(), code: this.code() });
  }

  /** 取り下げを要求する。 */
  onReject(): void {
    this.rejectRequested.emit(this.requestId());
  }
}
