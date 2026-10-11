/**
 * 接続一覧の表示部品。
 *
 * 取得・操作は行わず、表示と切断要求の送出だけを担う。認可状態・段階を
 * 示し、識別子は表示用である。
 */
import { Component, input, output } from "@angular/core";
import type { ConnectionSummary } from "bridge-gui-contract/management";

@Component({
  selector: "app-connection-list",
  standalone: true,
  templateUrl: "./connection-list.component.html",
})
export class ConnectionListComponent {
  /** 接続一覧。 */
  readonly connections = input<readonly ConnectionSummary[]>([]);

  /** 切断の要求。接続識別子を載せる。 */
  readonly disconnectRequested = output<string>();
}
