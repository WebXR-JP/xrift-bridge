/**
 * 汎用プラグイン・インスタンス管理層のホスト内部型。
 *
 * プラグイン実装者が参照する公開契約（記述子・候補 DTO・公開参照口・
 * 監視方式）は `bridge-gui-plugin-sdk/management` が正本であり、ここでは
 * 再 export する。ここには管理層の実装依存口（依存注入・問題報告・解放結果・
 * セッション最小口・時計）だけを置く。具体の送受信・表示内容は companion が
 * 宣言する記述子が駆動し、この層に種別分岐と汎用の任意 payload ディスパッチ表は
 * 持たない。
 *
 * 本番配線は backend が行う（server→core→manager の順に生成し、記述子を
 * 登録して companion を backend ごとの登録表へ載せる）。この層から
 * backend・binder・coordinator への依存は作らない。
 *
 * @packageDocumentation
 */
import type { BridgeAppCore } from "bridge-app-core/core";
import type {
  PluginBindingInfo,
  PluginSessionMetadata,
  Stop,
} from "bridge-gui-plugin-sdk/management";

export type {
  GuiPluginAccess,
  GuiPluginManagementDescriptor,
  GuiPluginObservation,
  OwnedPluginInstanceInfo,
  PluginAssignmentCandidate,
  PluginAssignmentPolicy,
  PluginAssignmentRequest,
  PluginAssignmentTarget,
  PluginBindingInfo,
  PluginOperationAccess,
  PluginOwnershipPhase,
  PluginSessionMetadata,
  Stop,
} from "bridge-gui-plugin-sdk/management";

/**
 * 個体の解放結果。回収失敗を `{ok:true}` に潰さず、問題を残す。
 */
export interface PluginReleaseResult {
  /** 初回解除なら真。二重解除なら偽。 */
  readonly released: boolean;
  /** 回収・通知の過程で起きた問題の一覧。無ければ空配列。 */
  readonly issues: readonly PluginManagerIssue[];
}

/**
 * 管理層の問題報告。自動再試行はせず、報告に留める。
 */
export interface PluginManagerIssue {
  /** 失敗した段階。 */
  readonly stage:
    | "event-unsubscribe"
    | "observation-stop"
    | "unassign"
    | "remove-instance"
    | "poll"
    | "notification";
  /** 対象の束縛情報。特定できない場合は `null`。 */
  readonly binding: PluginBindingInfo | null;
  /** 失敗の原因。 */
  readonly cause: unknown;
}

/**
 * 管理層が読む生存セッションの最小口。生の Session は扱わない。
 */
export interface PluginManagerSessions {
  /**
   * 生存セッションの公開情報の一覧。
   *
   * @returns 公開情報の写し。
   */
  list(): readonly PluginSessionMetadata[];
  /**
   * セッション終了を受ける。
   *
   * @param listener - 終了した生存セッションのローカル識別子を受ける処理。
   * @returns 購読解除口。
   */
  onEnded(listener: (localSessionId: string) => void): Stop;
}

/**
 * 管理層が使う周期時計。実時間待ちの試験は偽時計で差し替える。
 */
export interface PluginManagerClock {
  /**
   * 周期処理を始める。
   *
   * @param intervalMs - 実行間隔（ミリ秒）。
   * @param tick - 周期ごとの処理。例外を投げないこと。
   * @returns 停止口。
   */
  every(intervalMs: number, tick: () => void): Stop;
}

/**
 * 管理層の依存注入口。偽 core・偽セッション・偽時計で検証できる。
 */
export interface PluginInstanceManagerDependencies {
  /** 個体生成・割当ての最小口。終了口は含めず、閉じない。 */
  readonly core: Pick<
    BridgeAppCore,
    "createInstance" | "assign" | "unassign" | "removeInstance" | "listAssignments"
  >;
  /** 生存セッションの最小口。 */
  readonly sessions: PluginManagerSessions;
  /** 周期時計。 */
  readonly clock: PluginManagerClock;
  /** 外部状態の変化通知。購読者の例外は隔離して問題報告に回す。 */
  readonly onChanged: () => void;
  /** 問題報告の受け口。受け口の例外は管理層を壊さない。 */
  readonly onIssue: (issue: PluginManagerIssue) => void;
}
