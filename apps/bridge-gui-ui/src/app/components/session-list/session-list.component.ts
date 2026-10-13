/**
 * 生存セッション一覧の表示部品。
 *
 * 取得・操作は行わず、表示と診断割当て要求・診断解除要求の送出だけを担う。
 * テキスト表示用セッションは診断割当ての対象外であり、操作を受け付けない。
 * 所有中の診断現割当てには同行的な機械的解除ボタンを出す。
 */
import { Component, input, output } from "@angular/core";
import { TEXT_SESSION_ID } from "bridge-app-core/text-contract";
import type { PluginAssignmentSummary, SessionSummary } from "bridge-gui-contract/management";

/** 割当て要求。種別と生存セッションの識別子を載せる。 */
export interface AssignRequest {
  /** 割り当てる種別トークン。 */
  readonly pluginKind: string;
  /** 割り当てる生存セッションのローカル識別子。 */
  readonly localSessionId: string;
}

/** 解除要求。描画した所有記録の三識別子を載せる。 */
export interface UnassignRequest {
  /** 描画した所有記録のインスタンス識別子。 */
  readonly instanceId: string;
  /** 描画した所有記録のローカル識別子。 */
  readonly localSessionId: string;
  /** 描画した所有記録の接続口識別子。 */
  readonly portId: string;
}

@Component({
  selector: "app-session-list",
  standalone: true,
  templateUrl: "./session-list.component.html",
})
export class SessionListComponent {
  /** 生存セッション一覧。 */
  readonly sessions = input<readonly SessionSummary[]>([]);

  /** 所有中の診断現割当て。行ごとの解除ボタンの照合に使う。 */
  readonly diagnosticBindings = input<readonly PluginAssignmentSummary[]>([]);

  /** 診断割当ての要求。種別とローカル識別子を載せる。 */
  readonly assignRequested = output<AssignRequest>();

  /** 診断解除の要求。描画した所有記録の三識別子を載せる。 */
  readonly unassignRequested = output<UnassignRequest>();

  /**
   * 診断割当ての対象外（テキスト表示用）か判定する。
   *
   * @param sessionId - セッションの論理名。
   * @returns テキスト表示用の場合に真。
   */
  isTextSession(sessionId: string): boolean {
    return sessionId === TEXT_SESSION_ID;
  }

  /**
   * 行のセッションに結び付く診断現割当てを返す。
   *
   * @param localSessionId - 照合する生存セッションのローカル識別子。
   * @returns 結び付く現割当て。無ければ `null`。
   */
  diagnosticBindingOf(localSessionId: string): PluginAssignmentSummary | null {
    return (
      this.diagnosticBindings().find((binding) => binding.localSessionId === localSessionId) ?? null
    );
  }
}
