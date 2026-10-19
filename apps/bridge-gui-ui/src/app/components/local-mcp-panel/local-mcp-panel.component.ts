/**
 * 製品向けローカル業務操作 MCP の操作・表示部品。
 *
 * 有効／無効の状態、接続先 URL、有効化・停止の操作、URL の複写を提供する。
 * 取得・操作は行わず、要求の送出だけを行う。接続に必要なのは公開状態の
 * URL のみである。
 */
import { Component, input, output, signal } from "@angular/core";
import type { LocalMcpStatus } from "bridge-gui-contract/management";
import { HlmButton } from "../../ui/button/hlm-button.ts";
import { HlmInput } from "../../ui/input/hlm-input.ts";

@Component({
  selector: "app-local-mcp-panel",
  standalone: true,
  imports: [HlmButton, HlmInput],
  templateUrl: "./local-mcp-panel.component.html",
})
export class LocalMcpPanelComponent {
  /** 製品向け MCP の公開状態。未取得の間は null である。 */
  readonly status = input<LocalMcpStatus | null>(null);

  /** 操作の失敗・未完了表示。本文は含めない（理由だけである）。 */
  readonly error = input<string>("");

  // ADR: 実行中の操作はボタンに無効として見せる。黙って捨てず、押せないことを
  // 示す。判定は公開状態の内容と実行中旗の両方で行い、応答の到達で戻す。
  // 種類の異なる操作は互いを止めない（有効化の実行中は停止できる）。
  /** 有効化の実行中旗。真の間は有効化ボタンを無効にする。 */
  readonly enablePending = input(false);

  /** 停止の実行中旗。真の間は停止ボタンを無効にする。 */
  readonly disablePending = input(false);

  /** 有効化の要求。 */
  readonly enableRequested = output<void>();

  /** 停止の要求。 */
  readonly disableRequested = output<void>();

  // ADR: 複写の合図は signal で持つ。通常のプロパティでは zoneless の変更検知が
  // 走らず表示が追随しないためである。合図は短く出し、タイマーで消す。
  private readonly copied = signal(false);

  /** 複写の合図が出ている場合に真。合図の表示だけに使う。 */
  readonly copiedKey = this.copied.asReadonly();

  /** 操作できるか（公開状態の取得済みの場合に真）。 */
  get canOperate(): boolean {
    return this.status() !== null;
  }

  /** 有効（待受中）の場合に真。未取得の間は偽である。 */
  get enabled(): boolean {
    return this.status()?.enabled ?? false;
  }

  /** 停止が未完了の場合に真。未完了の間は再試行できる。 */
  get pendingCleanup(): boolean {
    return this.status()?.cleanupPending ?? false;
  }

  // ADR: ボタンの対応表。未取得の間は両方とも無効であり状態を断定しない。
  // 無効（未完了でない）の間は有効化だけが有効、待受中は停止だけが有効、
  // 未完了（enabled によらず cleanupPending が真）の間は停止の再試行だけが
  // 有効であり、有効化は無効である（未終了の待受けがある間は新しい待受けを
  // 開かない）。実行中の操作はその操作のボタンを無効にし、黙って捨てずに
  // 押せないことを見せる。「停止した」と見せるのは解放の確認後だけであり、
  // 未完了の間は操作無効（無効表示）と停止未完了を分けて出す。
  /** 有効化の操作ができる場合に真。実行中は押せないことを示すため偽である。 */
  get canEnable(): boolean {
    return this.canOperate && !this.enabled && !this.pendingCleanup && !this.enablePending();
  }

  /** 停止（再試行を含む）の操作ができる場合に真。実行中は押せないことを示すため偽である。 */
  get canDisable(): boolean {
    return this.canOperate && (this.enabled || this.pendingCleanup) && !this.disablePending();
  }

  /**
   * 接続先 URL を複写する。複写手段が無い環境では入力欄の選択に任せる。
   *
   * @param value - 複写する接続先 URL。
   * @param input - 失敗時に選択する入力欄。
   */
  async copyText(value: string, input: HTMLInputElement): Promise<void> {
    const clipboard = (
      navigator as unknown as {
        clipboard?: { writeText: (text: string) => Promise<void> };
      }
    ).clipboard;
    if (clipboard === undefined) {
      input.select();
      return;
    }
    try {
      await clipboard.writeText(value);
    } catch {
      // 複写に失敗したら入力欄の選択に任せる（手動の複写ができる）。
      input.select();
      return;
    }
    this.copied.set(true);
    // 合図は短く出し、残さない。
    setTimeout(() => {
      this.copied.set(false);
    }, 2000);
  }
}
