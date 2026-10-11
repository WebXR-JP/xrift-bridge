/**
 * 生存セッション一覧の表示部品。
 *
 * 取得・操作は行わず、表示と診断割当て要求の送出だけを担う。テキスト表示用
 * セッションは診断割当ての対象外であり、操作を受け付けない。
 */
import { Component, input, output } from "@angular/core";
import { TEXT_SESSION_ID } from "bridge-app-core/text-contract";
import type { SessionSummary } from "bridge-gui-contract/management";

@Component({
  selector: "app-session-list",
  standalone: true,
  templateUrl: "./session-list.component.html",
})
export class SessionListComponent {
  /** 生存セッション一覧。 */
  readonly sessions = input<readonly SessionSummary[]>([]);

  /** 診断割当ての要求。ローカル識別子を載せる。 */
  readonly assignRequested = output<string>();

  /**
   * 診断割当ての対象外（テキスト表示用）か判定する。
   *
   * @param sessionId - セッションの論理名。
   * @returns テキスト表示用の場合に真。
   */
  isTextSession(sessionId: string): boolean {
    return sessionId === TEXT_SESSION_ID;
  }
}
