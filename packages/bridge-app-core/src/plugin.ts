/**
 * プラグイン定義と接続口の型。
 *
 * プラグインは名前付きの接続口を宣言し、各接続口は受け入れる合法な
 * `kind`・`direction` の組合せを列挙する。二つの独立した集合にはしない。
 * 方向はワールド・サーバー基準であり、プラグイン基準に読み替えない。
 * データ内容の互換性は capability では保証せず、検証・応答相関は
 * プラグインの責務とする。
 *
 * @packageDocumentation
 */
import type { AssignedSession } from "./assigned-session.ts";

/**
 * セッションの輸送上の適合（種別と方向の組合せ）。
 *
 * 現在利用可能な組合せは `reliable`・`bidirectional`（PC 側は送受信可能）、
 * `latest`・`to_server`（PC 側は受信のみ）、`latest`・`to_client`
 * （PC 側は送信のみ。サーバー起点作成をしない範囲では利用不可）である。
 */
export type SessionCapability =
  | { readonly kind: "reliable"; readonly direction: "bidirectional" }
  | { readonly kind: "latest"; readonly direction: "to_server" }
  | { readonly kind: "latest"; readonly direction: "to_client" };

/**
 * プラグインの名前付き接続口。
 *
 * 一つの接続口に割り当てられるセッションは一つだけである。
 */
export interface PluginPort {
  /** 接続口の識別子。インスタンス内で一意である。 */
  readonly portId: string;
  /** 受け入れる合法な組合せの列挙。 */
  readonly accepts: readonly SessionCapability[];
}

/**
 * プラグインの定義（レシピ）。
 *
 * 複数インスタンスを生成でき、UI の有無・形状はここでは表さない。
 *
 * @typeParam S - {@link PluginInstance.getState} が返す UI 非依存の状態の型。
 */
export interface PluginDefinition<S> {
  /** プラグインの識別子。 */
  readonly pluginId: string;
  /** 宣言する接続口の一覧。 */
  readonly ports: readonly PluginPort[];
  /**
   * 新しいインスタンスを生成する。
   *
   * @returns 割当て前のインスタンス。
   */
  create(): PluginInstance<S>;
}

/**
 * プラグインのインスタンス（本体機能）。
 *
 * 受け取る操作口は割当て期間だけ有効であり、解除・削除・終了で失効する。
 * 失効後の送信は拒否され、購読登録は例外になる。
 *
 * @typeParam S - {@link getState} が返す UI 非依存の状態の型。
 */
export interface PluginInstance<S> {
  /**
   * 接続口にセッションを割り当てて利用を開始する。同期で確定する。
   *
   * @param portId - 定義で宣言した接続口の識別子。
   * @param session - 割当て期間だけ有効な操作口。生の Session ではない。
   * @throws `RangeError` — 不明な接続口や受け入れられない操作口の場合。
   */
  attach(portId: string, session: AssignedSession): void;
  /**
   * UI 非依存の状態を取得する。
   *
   * @returns 表示に使える現在の状態の写し。
   */
  getState(): S;
  /** インスタンスを破棄する。以後の `attach` は受け付けない。 */
  dispose(): void;
}

/**
 * 生成済みインスタンスへの参照。
 *
 * @typeParam S - {@link PluginInstance.getState} が返す状態の型。
 */
export interface PluginInstanceHandle<S> {
  /** インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /**
   * UI 非依存の状態を取得する。
   *
   * @returns 表示に使える現在の状態の写し。
   */
  getState(): S;
}

/**
 * 二つの capability が同じ組合せか判定する。
 *
 * @param a - 比較する一方。
 * @param b - 比較するもう一方。
 * @returns 種別と方向がともに一致すれば真。
 */
export function capabilityEquals(a: SessionCapability, b: SessionCapability): boolean {
  return a.kind === b.kind && a.direction === b.direction;
}
