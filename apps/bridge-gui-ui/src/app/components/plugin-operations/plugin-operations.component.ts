/**
 * プラグイン操作のタブ表示部品。
 *
 * インスタンス単位のタブ切替だけを担う。タブ切替は選択要求を出すだけであり、
 * 子画面タグを動かさない・業務 RPC を送らない（App 経由で表示制御に伝わる）。
 * マウント状態一覧・失敗一覧・再試行は出さない（代替表示の責務である）。
 * 非選択個体の警告印はマウント失敗または `cleanupFailed` のときだけ付け、
 * 準備中・ready には付けない。
 */
import { Component, computed, input, output } from "@angular/core";
import type { OwnedPluginInstanceSummary, PluginKindSummary } from "bridge-gui-contract/management";
import type { PluginUiMountFailure } from "bridge-gui-contract/plugin-instance";
import { hasPluginTabWarning } from "../../plugin-view-state.ts";

/** 既知種別の表示名。`plugin-list` の補助表と一致させる（表示だけである）。 */
const KNOWN_PLUGIN_NAMES: Readonly<Record<string, string>> = {
  text: "テキスト送信",
  diagnostic: "診断（echo・ping）",
};

@Component({
  selector: "app-plugin-operations",
  standalone: true,
  templateUrl: "./plugin-operations.component.html",
})
export class PluginOperationsComponent {
  /** 登録済み種別の一覧。未知種別の表示名（`label`）解決に使う。 */
  readonly kinds = input<readonly PluginKindSummary[]>([]);

  /** 管理層が所有する個体の一覧。タブの単位はインスタンスである。 */
  readonly instances = input<readonly OwnedPluginInstanceSummary[]>([]);

  /** 選択中のインスタンス識別子。所有が0の間は `null`。 */
  readonly selectedInstanceId = input<string | null>(null);

  /** 実プラグイン子画面の失敗一覧。警告印の判定だけに使う（表示はしない）。 */
  readonly failures = input<readonly PluginUiMountFailure[]>([]);

  /** タブ選択の要求。インスタンス識別子を載せる。業務 RPC は送らない。 */
  readonly selectionRequested = output<string>();

  /**
   * 同種衝突を解消したタブ札の一覧。表示名＋短い個体識別であり、同じ札を許さない。
   *
   * 単独種別は基本名のみ、同種複数は末尾6文字を添え、衝突時は識別部分を
   * 延長して一意にする。インスタンス識別子順ではなく所有順を保つ。
   */
  readonly tabLabels = computed((): readonly string[] => {
    const instances = this.instances();
    return instances.map((instance) => this.tabLabelFor(instance));
  });

  /**
   * 個体の表示名を返す。既知種別は固定名、未知は登録 `label`、登録外は種別名である。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns タブに載せる基本名。
   */
  displayNameFor(instance: OwnedPluginInstanceSummary): string {
    const known = KNOWN_PLUGIN_NAMES[instance.pluginKind];
    if (known !== undefined) {
      return known;
    }
    const registered = this.kinds().find((kind) => kind.pluginKind === instance.pluginKind);
    return registered?.label ?? instance.pluginKind;
  }

  /**
   * タブ札を作る。同種が複数ある場合は短い識別を添え、衝突時は延長して一意にする。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns タブ札。単独種別は基本名のみである。
   */
  tabLabelFor(instance: OwnedPluginInstanceSummary): string {
    const base = this.displayNameFor(instance);
    const sameKind = this.instances().filter((item) => item.pluginKind === instance.pluginKind);
    if (sameKind.length <= 1) {
      return base;
    }
    // ADR: 末尾6文字を起点に、同じ札にならない長さまで延長する。末尾一致の
    // 衝突（例: 連番の上桁だけが違う個体）でも識別できるための最小延長であり、
    // 全識別子の常時表示はしない。識別子が短い場合は全体を使う。
    const peers = sameKind.map((item) => item.instanceId);
    for (let length = 6; length <= Math.max(...peers.map((id) => id.length)); length += 1) {
      const suffix = instance.instanceId.slice(-length);
      const label = `${base} …${suffix}`;
      const collided = sameKind.some(
        (other) =>
          other.instanceId !== instance.instanceId &&
          `${this.displayNameFor(other)} …${other.instanceId.slice(-length)}` === label,
      );
      if (!collided) {
        return label;
      }
    }
    return `${base} …${instance.instanceId}`;
  }

  /**
   * 個体が選択中か判定する。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns 選択中の場合に真。
   */
  isSelected(instance: OwnedPluginInstanceSummary): boolean {
    return this.selectedInstanceId() === instance.instanceId;
  }

  /**
   * タブに警告印を付けるか判定する。マウント失敗または `cleanupFailed` のときだけ真。
   *
   * 準備中・ready には付けない。色だけに依存せず、表示側で読み上げ用文言を添える。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns 警告印を付ける場合に真。
   */
  hasWarning(instance: OwnedPluginInstanceSummary): boolean {
    return hasPluginTabWarning(instance, this.failures());
  }

  /**
   * タブの要素識別子を作る。tabpanel 側の関連付けに使う。
   *
   * @param instance - 所有する個体の表示状態。
   * @returns タブ要素の `id`。
   */
  tabIdFor(instance: OwnedPluginInstanceSummary): string {
    return `plugin-tab-${instance.instanceId}`;
  }

  /**
   * タブ選択を要求する。子画面タグは動かさない。
   *
   * @param instance - 選択する個体の表示状態。
   */
  onSelect(instance: OwnedPluginInstanceSummary): void {
    this.selectionRequested.emit(instance.instanceId);
  }

  /**
   * 矢印・Home／End のタブ移動を扱う。表示切替だけであり、業務 RPC は送らない。
   *
   * 移動先のタブへ焦点を移し、選択要求も出す（roving tabindex のため）。
   *
   * @param event - キーボード操作。
   * @param currentIndex - 現在のタブ位置。
   */
  onTabKeydown(event: KeyboardEvent, currentIndex: number): void {
    const count = this.instances().length;
    if (count === 0) {
      return;
    }
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (currentIndex + 1) % count;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (currentIndex - 1 + count) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = this.instances()[next ?? 0];
    if (target === undefined) {
      return;
    }
    this.selectionRequested.emit(target.instanceId);
    // 焦点は描画後のタブへ移す。同一枠内の照会であり、業務 RPC は送らない。
    const host = (event.target as HTMLElement | null)?.closest('[role="tablist"]');
    requestAnimationFrame(() => {
      const tabs = host?.querySelectorAll('[role="tab"]') ?? [];
      (tabs[next ?? 0] as HTMLElement | undefined)?.focus();
    });
  }
}
