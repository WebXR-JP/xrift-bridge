/**
 * 管理画面シェル（左ナビ＋右コンテンツの2カラム）。
 *
 * 画面定義・選択中キー・件数・状態値を入力に受け、選択要求と終了要求を出す。
 * 取得・操作は行わない。件数と状態値は snapshot からの導出であり、内部の
 * 別 signal へ複製しない。URL 遷移ではないため Router・疑似リンク・tab
 * widget は使わず、ナビ項目は素の button で作り、選択中にだけ
 * `aria-current="page"` を付ける。
 */
import { Component, computed, input, output } from "@angular/core";
import { NgIcon, provideIcons } from "@ng-icons/core";
import {
  lucideAppWindow,
  lucideHexagon,
  lucidePlug,
  lucidePower,
  lucidePuzzle,
  lucideRadio,
  lucideScrollText,
} from "@ng-icons/lucide";
import type { ViewDefinition, ViewKey } from "../../view-config.ts";

/**
 * シェル側の状態サマリ値。未取得の項目は `null` であり、事実として出さない
 * （受付中や0件を断定しない）。
 */
export interface ShellStatus {
  /** 受付状態。未取得の間は `null`。 */
  readonly accepting: boolean | null;
  /** 保留件数。未取得の間は `null`。 */
  readonly pendingCount: number | null;
  /** 接続件数。未取得の間は `null`。 */
  readonly connectionCount: number | null;
  /** 生存セッション件数。未取得の間は `null`。 */
  readonly sessionCount: number | null;
}

@Component({
  selector: "app-shell",
  standalone: true,
  imports: [NgIcon],
  providers: [
    provideIcons({
      lucideAppWindow,
      lucideHexagon,
      lucidePlug,
      lucidePower,
      lucidePuzzle,
      lucideRadio,
      lucideScrollText,
    }),
  ],
  templateUrl: "./shell.component.html",
})
export class ShellComponent {
  /** 画面定義。順序はナビの表示順である。 */
  readonly views = input.required<readonly ViewDefinition[]>();

  /** 選択中の画面キー。 */
  readonly selectedKey = input.required<ViewKey>();

  /** 画面キーごとの件数。件数が無い画面と未取得は `null` であり、出さない。 */
  readonly counts = input.required<Readonly<Record<ViewKey, number | null>>>();

  /** 左カラムの状態サマリ値。 */
  readonly status = input.required<ShellStatus>();

  /** ナビ項目の選択要求。業務 RPC は送らず、キーを載せるだけである。 */
  readonly selectRequested = output<ViewKey>();

  /** 終了要求。 */
  readonly quitRequested = output<void>();

  /** 選択中の画面定義。右ページヘッダに使う。 */
  readonly selectedView = computed(() =>
    this.views().find((view) => view.key === this.selectedKey()),
  );

  /**
   * ナビ項目の右端に出す件数文を作る。
   *
   * @param key - 対象画面のキー。
   * @returns 件数文。件数が無い画面と未取得は `null`（出さない）。
   */
  countText(key: ViewKey): string | null {
    const count = this.counts()[key];
    return count === null ? null : `${count} 件`;
  }

  /**
   * 状態サマリの行に出す件数文を作る。
   *
   * @param count - 件数。未取得の間は `null`。
   * @returns 件数文。未取得の間は「—」であり、0件を断定しない。
   */
  summaryCountText(count: number | null): string {
    return count === null ? "—" : `${count} 件`;
  }
}
