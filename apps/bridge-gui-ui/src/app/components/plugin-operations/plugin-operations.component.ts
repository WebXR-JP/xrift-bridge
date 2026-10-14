/**
 * プラグイン操作のタブ表示部品。
 *
 * インスタンス単位のタブと選択中個体の子画面状態（準備中・失敗）だけを担う。
 * タブ切替は選択要求を出すだけであり、子画面タグを動かさない・業務 RPC を
 * 送らない（App 経由で表示制御に伝わる）。子画面の再生成もしない。
 */
import { Component, input, output } from "@angular/core";
import type { OwnedPluginInstanceSummary, PluginKindSummary } from "bridge-gui-contract/management";
import type {
  PluginUiMountFailure,
  PluginUiMountPlacement,
} from "bridge-gui-contract/plugin-instance";
import { HlmButton } from "../../ui/button/hlm-button.ts";

/** 既知種別の表示名。`plugin-list` の補助表と一致させる（表示だけである）。 */
const KNOWN_PLUGIN_NAMES: Readonly<Record<string, string>> = {
  text: "テキスト送信",
  diagnostic: "診断（echo・ping）",
};

@Component({
  selector: "app-plugin-operations",
  standalone: true,
  imports: [HlmButton],
  templateUrl: "./plugin-operations.component.html",
})
export class PluginOperationsComponent {
  /** 登録済み種別の一覧。未知種別の表示名（`label`）解決に使う。 */
  readonly kinds = input<readonly PluginKindSummary[]>([]);

  /** 管理層が所有する個体の一覧。タブの単位はインスタンスである。 */
  readonly instances = input<readonly OwnedPluginInstanceSummary[]>([]);

  /** 選択中のインスタンス識別子。所有が0の間は `null`。 */
  readonly selectedInstanceId = input<string | null>(null);

  /** 実プラグイン子画面の配置一覧。 */
  readonly mounts = input<readonly PluginUiMountPlacement[]>([]);

  /** 実プラグイン子画面の失敗一覧。 */
  readonly failures = input<readonly PluginUiMountFailure[]>([]);

  /** タブ選択の要求。インスタンス識別子を載せる。業務 RPC は送らない。 */
  readonly selectionRequested = output<string>();

  /** 再試行の要求。配置の再生成は保持者が行う。 */
  readonly retryRequested = output<void>();

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
   * タブ札を作る。同種が複数ある場合は短い識別（instanceId の末尾）を添える。
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
    return `${base} …${instance.instanceId.slice(-6)}`;
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

  /** 選択中個体に結び付く配置一覧。 */
  selectedMounts(): readonly PluginUiMountPlacement[] {
    const selected = this.selectedInstanceId();
    if (selected === null) {
      return [];
    }
    return this.mounts().filter((mount) => mount.instanceId === selected);
  }

  /** 選択中個体に結び付く失敗一覧。 */
  selectedFailures(): readonly PluginUiMountFailure[] {
    const selected = this.selectedInstanceId();
    if (selected === null) {
      return [];
    }
    return this.failures().filter((failure) => failure.instanceId === selected);
  }

  /**
   * 配置の状態表示文を作る。
   *
   * @param mount - 配置の表示状態。
   * @returns 準備完了・生成待ち・採用待ちのいずれか。
   */
  describeState(mount: PluginUiMountPlacement): string {
    if (mount.ready) {
      return "準備完了";
    }
    return mount.phase === "pending" ? "生成待ち" : "採用待ち";
  }

  /**
   * タブ選択を要求する。子画面タグは動かさない。
   *
   * @param instance - 選択する個体の表示状態。
   */
  onSelect(instance: OwnedPluginInstanceSummary): void {
    this.selectionRequested.emit(instance.instanceId);
  }
}
