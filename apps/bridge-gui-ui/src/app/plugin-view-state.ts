/**
 * プラグイン子画面スロットの表示導出。
 *
 * 代替表示（`app-plugin-view-fallback`）と子タグ配置（`ManagementService`）が
 * 食い違わないよう、判定をこの純粋関数にまとめる。独立した状態の複製は
 * 作らず、採用中 snapshot・所有段階・選択個体のマウント／失敗と、初回取得
 * 失敗・局所再試行の旗だけから導出する。汎用ストア・Router は追加しない。
 *
 * 子画面の寿命は表示期間ごとの作り直しであり、配置・失敗表示は採用中
 * snapshot の表示要求（`pluginView`）の世代だけを正とする。古い世代の
 * 配置・失敗表示では子を復活させない。`pluginResponded` は最初の正常な
 * plugin 応答の到達であり、採用・描画・業務準備完了の証明ではない。
 *
 * @packageDocumentation
 */
import type {
  ManagementSnapshot,
  OwnedPluginInstanceSummary,
} from "bridge-gui-contract/management";
import type { PluginUiMountFailure } from "bridge-gui-contract/plugin-instance";
import { firstResponseOf } from "bridge-gui-contract/plugin-instance";

/** 子画面スロットの代替表示の状態。表示文と言語は部品側が持つ。 */
export type PluginViewState =
  /** 初回 snapshot 未取得（読込み中）。 */
  | { readonly kind: "loading" }
  /** 初回取得失敗で採用済み snapshot なし（再読み込みを出す）。 */
  | { readonly kind: "loadFailed" }
  /** 所有0件。 */
  | { readonly kind: "empty" }
  /** 選択個体が所有段階 `initializing`。 */
  | { readonly kind: "starting" }
  /** `active` で配置なし／初期応答待ち（準備中）。 */
  | { readonly kind: "preparing" }
  /** `active` で選択個体の同世代マウント失敗（再試行を出す）。 */
  | {
      readonly kind: "failed";
      /** 人間向けの短い理由。本文・識別子は含めない。 */
      readonly reason: string;
      /** 再試行要求中の場合に真。失敗表示を残しボタンだけ変える。 */
      readonly retryPending: boolean;
      /** 再試行要求自体が失敗した場合に真。元の失敗表示に注記を足す。 */
      readonly retryRequestFailed: boolean;
    }
  /** `active` で最初の正常な plugin 応答あり（子画面のみ。状態文は出さない）。 */
  | { readonly kind: "answered" }
  /** 選択個体が所有段階 `releasing`。 */
  | { readonly kind: "releasing" }
  /** 選択個体が所有段階 `cleanupFailed`（子画面再試行は出さない）。 */
  | { readonly kind: "cleanupFailed" };

/** 導出に要る局所の旗。snapshot の複製ではなく要求の成否だけである。 */
export interface PluginViewFlags {
  /** 初回取得に失敗し採用済み snapshot が無い場合に真。 */
  readonly initialFetchFailed: boolean;
  /** 選択個体の再試行要求中の場合に真。 */
  readonly retryPending: boolean;
  /** 選択個体の再試行要求自体が失敗した場合に真。 */
  readonly retryRequestFailed: boolean;
}

/**
 * 子画面スロットの状態を導出する。
 *
 * 所有段階をマウント状態より優先する。`cleanupFailed` を「準備中」に
 * 読み替えない。配置・失敗表示は採用中 snapshot の表示要求の世代に一致する
 * ものだけを見る（古い世代では子を復活させない）。失敗は選択個体に結び付く
 * ものだけを見る（特定不能の `instanceId: null` は対象外）。
 *
 * @param snapshot - 採用中の表示状態。未取得なら `null`。
 * @param selectedInstanceId - 選択中のインスタンス識別子。所有が無い間は `null`。
 * @param flags - 初回取得失敗・局所再試行の旗。
 * @returns スロットの状態。
 */
export function derivePluginViewState(
  snapshot: ManagementSnapshot | null,
  selectedInstanceId: string | null,
  flags: PluginViewFlags,
): PluginViewState {
  if (snapshot === null) {
    return flags.initialFetchFailed ? { kind: "loadFailed" } : { kind: "loading" };
  }
  const instances = snapshot.plugins.instances;
  if (instances.length === 0) {
    return { kind: "empty" };
  }
  const selected: OwnedPluginInstanceSummary | undefined = instances.find(
    (item) => item.instanceId === selectedInstanceId,
  );
  if (selected === undefined) {
    // 選択が定まらない間は準備中として扱う（`cleanupFailed` への読替えはしない）。
    return { kind: "preparing" };
  }
  switch (selected.phase) {
    case "initializing":
      return { kind: "starting" };
    case "releasing":
      return { kind: "releasing" };
    case "cleanupFailed":
      return { kind: "cleanupFailed" };
    case "active":
      break;
  }
  // ADR: 表示要求の世代だけを正とし、古い世代の配置・失敗表示では子を
  // 復活させない。同一表示期間の再試行は世代を維持するため、再試行後の
  // 作り直しは同世代として扱う。画面を離れての再表示は新しい世代になる。
  const generation = snapshot.pluginView.viewGeneration;
  const mounts = snapshot.pluginMounts.filter(
    (mount) => mount.instanceId === selected.instanceId && mount.viewGeneration === generation,
  );
  if (mounts.some((mount) => mount.pluginResponded)) {
    return { kind: "answered" };
  }
  if (mounts.some((mount) => firstResponseOf(mount, snapshot.pluginMountFailures) === "failed")) {
    const failure = snapshot.pluginMountFailures.find(
      (item) => item.instanceId === selected.instanceId && item.viewGeneration === generation,
    );
    return {
      kind: "failed",
      reason: failure?.reason ?? "子画面を表示できませんでした。",
      retryPending: flags.retryPending,
      retryRequestFailed: flags.retryRequestFailed,
    };
  }
  // 配置が無い間の同世代の失敗（生成に至らない場合）も失敗として出す。
  // 古い世代の失敗表示では復活させない。
  const failureWithoutMount = snapshot.pluginMountFailures.find(
    (item) => item.instanceId === selected.instanceId && item.viewGeneration === generation,
  );
  if (failureWithoutMount !== undefined) {
    return {
      kind: "failed",
      reason: failureWithoutMount.reason,
      retryPending: flags.retryPending,
      retryRequestFailed: flags.retryRequestFailed,
    };
  }
  return { kind: "preparing" };
}

/**
 * タブに警告印を付ける条件を判定する。
 *
 * 非選択個体はマウント失敗または `cleanupFailed` のときだけ付け、
 * 準備中・応答済みには付けない。色だけに依存せず、部品側で読み上げ用
 * 文言を添える。失敗表示の世代は問わない。main が世代進行時に旧世代分を
 * 剪定するため、この一覧は個体ごとの最新のみであり、最終試行の失敗を示す。
 *
 * @param instance - 所有する個体の表示状態。
 * @param failures - snapshot の失敗一覧。
 * @returns 警告印を付ける場合に真。
 */
export function hasPluginTabWarning(
  instance: OwnedPluginInstanceSummary,
  failures: readonly PluginUiMountFailure[],
): boolean {
  if (instance.phase === "cleanupFailed") {
    return true;
  }
  return failures.some((failure) => failure.instanceId === instance.instanceId);
}
