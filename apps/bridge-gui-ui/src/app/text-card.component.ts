/**
 * 固定テキスト表示カード。
 *
 * 割当て／解除の可否だけを扱う。本文の入力と送信は子画面に任せる。
 * 割当て先・送信可能／実行中・直近結果・統計を示し、割当て中は割当て
 * ボタンを、未割当ては解除ボタンを無効化する。操作失敗の説明を出すが、
 * 本文は含めない。
 */
import { Component, input, output } from "@angular/core";
import type { TextDisplayState } from "bridge-gui-contract/management";

@Component({
  selector: "app-text-card",
  standalone: true,
  templateUrl: "./text-card.component.html",
})
export class TextCardComponent {
  /** 固定テキスト表示の状態。本文は含めない。 */
  readonly text = input<TextDisplayState | null>(null);

  /** テキスト操作の失敗表示。空なら失敗は無い。 */
  readonly error = input<string>("");

  /** 割当ての要求。 */
  readonly assignRequested = output<void>();

  /** 割当て解除の要求。 */
  readonly unassignRequested = output<void>();

  /** 割当て中の場合に真。 */
  get assigned(): boolean {
    const state = this.text();
    return state !== null && state.localSessionId !== null && state.instanceId !== null;
  }

  /**
   * 割当て先の表示文を作る。
   *
   * @returns 割当て先または未割当て。未取得の間は未取得である。
   */
  assignmentText(): string {
    const state = this.text();
    if (state === null) {
      return "未取得";
    }
    if (state.localSessionId !== null && state.instanceId !== null) {
      return `${state.localSessionId}（instanceId ${state.instanceId}）`;
    }
    return "未割当て";
  }

  /**
   * 状態の表示文を作る。
   *
   * @returns 未割当て・実行中・送信可能・送信不可のいずれか。
   */
  statusText(): string {
    const state = this.text();
    if (state === null) {
      return "未取得";
    }
    if (state.localSessionId === null || state.instanceId === null) {
      return "未割当て";
    }
    if (state.pendingId !== null) {
      return `実行中（応答待ち id=${state.pendingId}）`;
    }
    return state.canSend ? "送信可能" : "送信不可";
  }

  /**
   * 直近結果の表示文を作る。
   *
   * 「反映確認」はワールドの表示用状態に反映した意味であり、送信完了や
   * 描画完了の保証ではない。
   *
   * @returns 直近結果の表示文。
   */
  resultText(): string {
    const state = this.text();
    if (state === null) {
      return "未取得";
    }
    const last = state.lastResult;
    if (last === null) {
      return "まだ送信していない";
    }
    if (last.status === "acknowledged") {
      return "反映確認（ワールドの表示用状態に反映した・送信完了や描画完了の意味ではない）";
    }
    return `結果不明（理由: ${describeUnknownReason(last.reason)}・表示用状態への反映を確認できない）`;
  }

  /**
   * 統計の表示文を作る。
   *
   * @returns 送信試行・反映確認・結果不明の件数。
   */
  statsText(): string {
    const state = this.text();
    if (state === null) {
      return "未取得";
    }
    return `送信試行 ${state.stats.attempts}・反映確認 ${state.stats.acknowledged}・結果不明 ${state.stats.unknown}`;
  }
}

/**
 * 結果不明の理由を人間向けの短い説明にする。
 *
 * 識別子そのままでは伝わらないため、応答期限切れ・切断・破棄を書き分ける。
 * 未知の理由はそのまま載せ、落とさない。
 *
 * @param reason - 結果不明の理由。
 * @returns 表示用の短い説明。
 */
export function describeUnknownReason(reason: string): string {
  if (reason === "timeout") {
    return "応答期限切れ";
  }
  if (reason === "disconnected") {
    return "切断";
  }
  if (reason === "disposed") {
    return "破棄";
  }
  return reason;
}
