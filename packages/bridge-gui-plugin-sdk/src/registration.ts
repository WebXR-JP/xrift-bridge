/**
 * 登録単位・registrar の公開型。
 *
 * ③b の登録フロー（registrar 注入・composition root）の口の型を置く。
 * `GuiPluginRegistration` が1件分の登録単位であり、`GuiPluginRegistrar` が
 * backend へ注入する登録関数の受け口である。実装（`PluginInstanceManager`・
 * `PluginCompanionRegistry` 本体）はホストが所有し、ここには置かない。
 *
 * @packageDocumentation
 */
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import type { GuiPluginAccess, GuiPluginManagementDescriptor } from "./management.ts";
import type { PluginCompanion } from "./companion.ts";

/**
 * プラグイン1件分の登録単位。管理記述子と companion 組み立ての組である。
 *
 * companion は backend を capture した factory で作り、backend を引数で
 * 受け取らない。共有の具象 companion インスタンス・既定引数・共有 singleton
 * は持たない。
 *
 * @typeParam S - 状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 * @typeParam V - 限定表示の型。
 * @typeParam A - 公開する固有操作の構築結果の型。
 */
export interface GuiPluginRegistration<S, O, V extends InstanceBaseView, A> {
  /** 生成元・割当て方針・監視方式・表示射影・固有操作の宣言。 */
  readonly management: GuiPluginManagementDescriptor<S, O, V, A>;
  /**
   * companion を組み立てる。管理層が返す種別の公開参照口を capture する。
   *
   * @param access - 管理層が返す種別の公開参照口。
   * @returns 登録する companion の記述子。
   */
  readonly createCompanion: (access: GuiPluginAccess<V, A>) => PluginCompanion;
}

/**
 * 管理層への記述子登録口の最小面。③b の registrar 注入で使う。
 */
export interface GuiPluginManagementRegistrar {
  /**
   * 管理記述子を登録し、種別ごとの公開参照口を返す。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @typeParam V - 限定表示の型。
   * @typeParam A - 公開する固有操作の構築結果の型。
   * @param descriptor - companion が宣言する管理記述子。
   * @returns 種別の公開参照口。表示型・操作型を保つ。
   */
  register<S, O, V extends InstanceBaseView, A>(
    descriptor: GuiPluginManagementDescriptor<S, O, V, A>,
  ): GuiPluginAccess<V, A>;
}

/**
 * companion 登録表への登録口の最小面。③b の registrar 注入で使う。
 */
export interface GuiPluginCompanionRegistrar {
  /**
   * companion を登録する。
   *
   * @param companion - 登録する companion の記述子。
   */
  register(companion: PluginCompanion): void;
}

/**
 * backend へ注入する登録関数の受け口。生 backend・管理層全体ではなく、
 * 登録に要る口だけを持つ。
 *
 * 1件の `registerPlugin` 呼び出しが「管理記述子を登録して公開参照口を得る」
 * と「その参照口を受ける companion factory を登録する」の両方を行い、
 * 記述子の種別と companion の種別の一致は呼び出し側（backend）が検査する。
 * 共有の具象 companion インスタンス・既定引数・共有 singleton は持たない。
 */
export interface GuiPluginRegistrar {
  /**
   * プラグイン1件を登録する。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @typeParam V - 限定表示の型。
   * @typeParam A - 公開する固有操作の構築結果の型。
   * @param registration - 管理記述子と companion 組み立ての組。
   * @throws 記述子の重複・形式外・種別不一致の場合。そのまま投げる。
   */
  registerPlugin<S, O, V extends InstanceBaseView, A>(
    registration: GuiPluginRegistration<S, O, V, A>,
  ): void;
}

/**
 * プラグインの登録関数。同梱の選択と登録順の宣言であり、登録済み
 * インスタンスや registry singleton を持たない。呼ぶたびに新しい
 * companion・公開参照口を作るため、複数 backend で使い回せる。
 */
export type GuiPluginRegisterFunction = (registrar: GuiPluginRegistrar) => void;
