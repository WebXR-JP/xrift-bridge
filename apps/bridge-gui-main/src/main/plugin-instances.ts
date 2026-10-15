/**
 * 所有段階・現割当てを各利用時に照合する束縛個体限定の参照口の実装。
 *
 * 所有の実体は `PluginInstanceManager` が持ち、ここでは照合付きの参照口の
 * 組立てだけを担う。対象識別子を引数に取る到達口・管理 backend・全個体一覧は
 * 渡さない。失効時の `RangeError` はホスト自身の照合結果であり、プラグインが
 * 投げた例外とは区別する。型消去は endpoint 工場の閉包内に限定し、ホストは
 * 状態の型・内容を解釈しない。
 *
 * @packageDocumentation
 */
import type { BoundPluginRef, PluginBindingInfo } from "bridge-gui-plugin-sdk/management";

/**
 * 参照口が使う管理層の最小口。所有中・確定済み・現割当て一致の確認と
 * 状態・操作口の読取りだけを求める。
 */
export interface BoundRefHooks {
  /**
   * 束縛情報を読む。
   *
   * @returns ホストが選んだ個体の束縛情報。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合。
   */
  readBinding(): PluginBindingInfo;
  /**
   * 個体の現在状態を読む。
   *
   * @returns 現在状態の写し。型の解釈は呼び出し側の閉包が行う。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合。
   */
  readStateValue(): unknown;
  /**
   * 個体の操作口を使う。
   *
   * @param use - 操作口と束縛情報を使う処理。
   * @returns `use` の戻り値。
   * @throws `TypeError` — 個体が操作口を提供しない場合。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合。
   */
  useOperationsValue<R>(use: (operations: unknown, binding: PluginBindingInfo) => R): R;
}

/**
 * 照合付きの参照口を作る。保存した raw operations を持たず、利用の都度
 * 受け口を通す。
 *
 * @typeParam S - プラグイン本体の状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 * @param hooks - 管理層が提供する照合付きの読取り口。
 * @returns ホストが選んだ一個体に限定した参照口。
 */
export function createBoundPluginRef<S, O>(hooks: BoundRefHooks): BoundPluginRef<S, O> {
  return {
    getBinding(): PluginBindingInfo {
      return hooks.readBinding();
    },
    readState(): S {
      // ADR: `as` を使う理由は、消した状態値を同じ記述子の型へ戻すためである。
      // 根拠は、値が当該個体の `getState` の戻り値そのものであり、保存せず
      // 利用の都度読むことである。
      return hooks.readStateValue() as S;
    },
    withOperations<R>(use: (operations: O, binding: PluginBindingInfo) => R): R {
      // ADR: `as` を使う理由は、消した操作値を同じ記述子の操作型へ戻すためである。
      // 根拠は、実行時の値が当該個体の操作口そのものであり、保存せず利用の
      // 都度渡すことである。
      const erased = use as (operations: unknown, binding: PluginBindingInfo) => R;
      return hooks.useOperationsValue(erased);
    },
  };
}
