/**
 * 受付の有効化／無効化の操作部品。
 *
 * 操作できるかは表示状態の有無で決まる（未取得の間は両方押せない）。
 * 操作自体は行わず、有効化・無効化の要求を送出する。
 * ボタンは helm の意匠で描き、有効化を primary・無効化を outline にする。
 */
import { Component, input, output } from "@angular/core";
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import { HlmButton } from "../../ui/button/hlm-button.ts";

@Component({
  selector: "app-acceptance-toggle",
  standalone: true,
  imports: [HlmButton],
  templateUrl: "./acceptance-toggle.component.html",
})
export class AcceptanceToggleComponent {
  /** 採用中の表示状態。未取得の間は null である。 */
  readonly snapshot = input<ManagementSnapshot | null>(null);

  /** 有効化の要求。 */
  readonly enableRequested = output<void>();

  /** 無効化の要求。 */
  readonly disableRequested = output<void>();

  /** 操作できるか（表示状態の取得済みの場合に真）。 */
  get canOperate(): boolean {
    return this.snapshot() !== null;
  }

  /** 受付中の場合に真。未取得の間は偽である。 */
  get accepting(): boolean {
    return this.snapshot()?.admission.accepting ?? false;
  }
}
