/**
 * 生存セッション一覧の表示部品（表示専用）。
 *
 * 取得・操作は行わず、生存セッションの読み取り表示だけを担う。
 * 診断・テキストの割当て・解除はプラグイン一覧で行う。
 */
import { Component, input } from "@angular/core";
import type { SessionSummary } from "bridge-gui-contract/management";

@Component({
  selector: "app-session-list",
  standalone: true,
  templateUrl: "./session-list.component.html",
})
export class SessionListComponent {
  /** 生存セッション一覧。 */
  readonly sessions = input<readonly SessionSummary[]>([]);
}
