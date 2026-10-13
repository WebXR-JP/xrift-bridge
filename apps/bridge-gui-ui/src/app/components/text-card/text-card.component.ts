/**
 * テキスト所有カード。
 *
 * 所有記録と取得済みフラグだけを扱う。割当て先・段階・割当て／解除ボタンのみ
 * 残し、送信可能／実行中・直近結果・統計は載せない（子画面で確認する）。
 * `cleanupFailed` は割当て済み扱いで新規割当てを抑止し、解除ボタンは無効に
 * して未回収表示にする。操作失敗の説明を出すが、本文は含めない。
 */
import { Component, input, output } from "@angular/core";
import type { OwnedPluginInstanceSummary } from "bridge-gui-contract/management";

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
  selector: "app-text-card",
  standalone: true,
  templateUrl: "./text-card.component.html",
})
export class TextCardComponent {
  /** テキスト種別の所有記録。無ければ `null`。 */
  readonly owned = input<OwnedPluginInstanceSummary | null>(null);

  /** 表示状態を取得済みの場合に真。未取得の間は偽である。 */
  readonly fetched = input<boolean>(false);

  /** テキスト操作の失敗表示。空なら失敗は無い。 */
  readonly error = input<string>("");

  /** 割当ての要求。 */
  readonly assignRequested = output<void>();

  /** 割当て解除の要求。描画した所有記録の三識別子を載せる。 */
  readonly unassignRequested = output<UnassignRequest>();

  /** 割当て中の場合に真。`cleanupFailed` も割当て済み扱いにする。 */
  get assigned(): boolean {
    return this.owned() !== null;
  }

  /** 回収に失敗して残っている場合に真。 */
  get unreclaimed(): boolean {
    return this.owned()?.phase === "cleanupFailed";
  }

  /** 解除できる場合に真。`cleanupFailed` は解除できない。 */
  get canUnassign(): boolean {
    const record = this.owned();
    return record !== null && record.phase !== "cleanupFailed";
  }

  /**
   * 割当て先の表示文を作る。
   *
   * @returns 割当て先または未割当て。未取得の間は未取得である。
   */
  assignmentText(): string {
    if (!this.fetched()) {
      return "未取得";
    }
    const record = this.owned();
    if (record === null) {
      return "未割当て";
    }
    return `${record.localSessionId}（instanceId ${record.instanceId}）`;
  }

  /**
   * 段階の表示文を作る。
   *
   * @returns 未取得・未割当て・段階のいずれか。
   */
  phaseText(): string {
    if (!this.fetched()) {
      return "未取得";
    }
    const record = this.owned();
    if (record === null) {
      return "未割当て";
    }
    switch (record.phase) {
      case "active":
        return "割当て中";
      case "initializing":
        return "割当て処理中";
      case "releasing":
        return "解除処理中";
      case "cleanupFailed":
        return "回収失敗（未回収）";
    }
  }

  /** 解除を要求する。描画した所有記録の三識別子を渡す。 */
  onUnassign(): void {
    const record = this.owned();
    if (record === null) {
      return;
    }
    this.unassignRequested.emit({
      instanceId: record.instanceId,
      localSessionId: record.localSessionId,
      portId: record.portId,
    });
  }
}
