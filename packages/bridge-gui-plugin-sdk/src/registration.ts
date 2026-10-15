/**
 * 登録単位・registrar の公開型。
 *
 * 登録単位は管理記述子・companion 宣言・endpoint 工場の三つの組であり、
 * 起動時の静的登録で endpoint 工場を登録し、マウント時に個体へ束縛した
 * endpoint を生成する。実装（管理層・登録表本体）はホストが所有し、
 * ここには置かない。
 *
 * @packageDocumentation
 */
import type { BoundPluginRef, GuiPluginManagementDescriptor } from "./management.ts";
import type {
  PluginCompanionDeclaration,
  PluginEmissionPort,
  PluginEndpoint,
  PluginEndpointFactory,
} from "./companion.ts";

/**
 * プラグイン1件分の登録単位。管理記述子・companion 宣言・endpoint 工場の組である。
 *
 * companion 宣言は表示名と相対 entry だけを持ち、解決済み view パスは
 * 持たない。endpoint 工場は backend を capture せず、引数の限定口だけを
 * 使う。共有の具象 endpoint インスタンス・既定引数・共有 singleton は
 * 持たない。型消去は endpoint 工場の閉包内に限定する。
 *
 * @typeParam S - 状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 */
export interface GuiPluginRegistration<S, O> {
  /** 生成元・割当て方針の宣言。 */
  readonly management: GuiPluginManagementDescriptor<S, O>;
  /** 表示名・相対 entry の宣言。 */
  readonly companion: PluginCompanionDeclaration;
  /**
   * 束縛個体用の endpoint を組み立てる。
   *
   * @param ref - ホストが選んだ一個体に限定した参照口。
   * @param emission - その表示期間の子にだけ送る口。
   * @returns 束縛個体用の endpoint。
   */
  readonly createEndpoint: PluginEndpointFactory<S, O>;
}

/**
 * 管理層への記述子登録口の最小面。registrar 注入で使う。
 */
export interface GuiPluginManagementRegistrar {
  /**
   * 管理記述子を登録する。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @param descriptor - companion が宣言する管理記述子。
   * @throws 記述子の重複・形式外の場合。そのまま投げる。
   */
  register<S, O>(descriptor: GuiPluginManagementDescriptor<S, O>): void;
}

/**
 * companion 登録表への登録口の最小面。registrar 注入で使う。
 */
export interface GuiPluginCompanionRegistrar {
  /**
   * companion 宣言を登録する。view パスの解決はホストが行う。
   *
   * @param declaration - 登録する companion の宣言。
   * @throws 宣言の重複・形式外の場合。そのまま投げる。
   */
  register(declaration: PluginCompanionDeclaration): void;
}

/**
 * endpoint 工場の登録口の最小面。registrar 注入で使う。
 */
export interface GuiPluginEndpointRegistrar {
  /**
   * endpoint 工場を登録する。マウント時に個体へ束縛した endpoint を生成する。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @param kind - companion の種別トークン。記述子・宣言と一致すること。
   * @param factory - 束縛個体用の endpoint 工場。
   * @throws 種別不一致・重複の場合。そのまま投げる。
   */
  register<S, O>(
    kind: string,
    factory: (ref: BoundPluginRef<S, O>, emission: PluginEmissionPort) => PluginEndpoint,
  ): void;
}

/**
 * backend へ注入する登録関数の受け口。生 backend・管理層全体ではなく、
 * 登録に要る口だけを持つ。
 *
 * 1件の `registerPlugin` 呼び出しが「管理記述子・companion 宣言・endpoint
 * 工場」の三つを登録する。記述子・宣言・工場の種別の一致は呼び出し側
 * （backend）が検査する。共有の具象 endpoint インスタンス・既定引数・
 * 共有 singleton は持たない。
 */
export interface GuiPluginRegistrar {
  /**
   * プラグイン1件を登録する。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @param registration - 管理記述子・companion 宣言・endpoint 工場の組。
   * @throws 記述子の重複・形式外・種別不一致の場合。そのまま投げる。
   */
  registerPlugin<S, O>(registration: GuiPluginRegistration<S, O>): void;
}

/**
 * プラグインの登録関数。同梱の選択と登録順の宣言であり、登録済み
 * インスタンスや registry singleton を持たない。呼ぶたびに新しい
 * 記述子・宣言・工場閉包を作るため、複数 backend で使い回せる。
 */
export type GuiPluginRegisterFunction = (registrar: GuiPluginRegistrar) => void;
