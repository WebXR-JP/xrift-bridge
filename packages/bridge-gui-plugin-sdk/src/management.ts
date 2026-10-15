/**
 * プラグイン実装者が参照する管理記述子の公開契約。
 *
 * ホスト汎用管理層が駆動する記述子・候補 DTO・束縛個体限定の参照口の
 * 型だけを置く。表示内容の射影・監視方式・固有操作の汎用表は持たない。
 * 状態の解釈・表示用 DTO の組立て・変化の購読はプラグイン本体側の
 * endpoint factory と GUI アダプターが行い、ホストは関与しない。
 *
 * ホスト内部の実装依存口（`PluginInstanceManager` 実装・
 * `PluginManagerSessions`・`PluginManagerClock`・
 * `PluginInstanceManagerDependencies`・`PluginManagerIssue`・
 * `PluginReleaseResult` 等）はここに置かない。具象プラグインの import・
 * 既定登録の副作用・Electrobun/Bun/Node 実体・ホストソースパス参照を
 * 持たず、`bridge-app-core/core` の型だけを参照する。
 *
 * @packageDocumentation
 */
import type { AssignmentInfo, PluginDefinition, SessionCapability } from "bridge-app-core/core";

/**
 * 個体の束縛情報。所有の公開形であり、種別・由来・割当ての三識別子を持つ。
 */
export interface PluginBindingInfo {
  /** companion の種別トークン。小文字始まりの英数字である。 */
  readonly kind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
}

/**
 * 所有の段階。
 *
 * - `initializing`: 割当て手続き中。公開口には出さず、終了通知は失効印に留める。
 * - `active`: 確定済み。読み取り・操作の対象になる。
 * - `releasing`: 回収手続き中。参照・callback を無効化する。
 * - `cleanupFailed`: 回収に失敗して残った。以後の再利用はせず、最終回収は
 *   ホストの `core.close()` に委ねる。
 */
export type PluginOwnershipPhase = "initializing" | "active" | "releasing" | "cleanupFailed";

/**
 * 所有の公開形。束縛情報に段階を付けたもの。
 */
export interface OwnedPluginInstanceInfo extends PluginBindingInfo {
  /** 所有の段階。 */
  readonly phase: PluginOwnershipPhase;
}

/**
 * 割当て候補の元になる生存セッションの公開情報。
 */
export interface PluginSessionMetadata {
  /** 生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 属する接続の識別子。 */
  readonly connectionId: string;
  /** セッションの論理名。 */
  readonly sessionId: string;
  /** 輸送上の適合（種別と方向の組合せ）。 */
  readonly capability: SessionCapability;
  /** 生存していれば真。 */
  readonly alive: boolean;
}

/**
 * 割当て候補。core 現在値から付加した現割当て（所有外の割当てを含む）を持つ。
 */
export interface PluginAssignmentCandidate extends PluginSessionMetadata {
  /** 当該セッションの現割当て。未割当てなら `null`。 */
  readonly assignment: AssignmentInfo | null;
}

/**
 * 割当ての要望。候補の選び方だけを指定し、識別子の直指定はしない。
 *
 * - `auto`: 方針に従い候補から選ぶ。
 * - `session`: 指定の生存セッションへ割り当てる。方針の選択結果が
 *   指定と一致しなければ拒否する。
 */
export type PluginAssignmentRequest =
  | { readonly mode: "auto" }
  | { readonly mode: "session"; readonly localSessionId: string };

/**
 * 方針が選んだ割当て先。manager が候補・生存・未割当て・接続口の適合を
 * 検証してから生成に進む。
 */
export interface PluginAssignmentTarget {
  /** 割り当てる生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 割り当てる接続口の識別子。定義で宣言済みであること。 */
  readonly portId: string;
}

/**
 * 割当て方針。companion が宣言する同期・副作用なしの選択関数と上限を持つ。
 *
 * 候補不足・曖昧の場合は `RangeError` を投げる。manager は選択結果を
 * 検証し、不正な割当て先では生成前に `RangeError` で拒否する。
 * 上限の算入には `initializing` と `cleanupFailed` を含める。
 */
export interface PluginAssignmentPolicy {
  /**
   * 同時所有の上限。`null` は上限なし。
   */
  readonly maxInstances: number | null;
  /**
   * 割当て先を選ぶ。同期・副作用なしであること。
   *
   * @param input - 要望・候補・当該種別の所有中束縛の一覧。
   * @returns 検証前の割当て先。
   * @throws `RangeError` — 候補不足・曖昧の場合。
   */
  select(input: {
    readonly request: PluginAssignmentRequest;
    readonly candidates: readonly PluginAssignmentCandidate[];
    readonly bindings: readonly PluginBindingInfo[];
  }): PluginAssignmentTarget;
}

/**
 * ホストが選んだ一個体に限定した参照口。endpoint 工場へ渡す。
 *
 * 状態を読む・その個体の操作口を利用する・束縛メタデータを読む、の三つだけ
 * を持つ。対象識別子を引数に取る到達口・管理 backend・全個体一覧は渡さない。
 * 各利用時に所有段階・現割当てを照合する。変化の購読は本体が公開する手段
 * （操作口・状態が運ぶ購読口など）をアダプターが直接使い、ホストは関与しない。
 *
 * 型消去は endpoint 工場の閉包内に限定し、ホストは状態の型・内容を解釈しない。
 *
 * @typeParam S - プラグイン本体の状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 */
export interface BoundPluginRef<S, O> {
  /**
   * 束縛メタデータを読む。
   *
   * @returns ホストが選んだ個体の束縛情報。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合（ホスト自身の照合）。
   */
  getBinding(): PluginBindingInfo;
  /**
   * 個体の現在状態を読む。読み取りは改訂を進めない。
   *
   * 改訂番号の所有者はプラグイン本体であり、状態変更時に進める。
   * GUI アダプターは引き継ぐだけで、子は新しい状態のみ採用する。
   *
   * @returns 表示に使える現在の状態の写し。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合（ホスト自身の照合）。
   */
  readState(): S;
  /**
   * 所有中・確定済み・現割当て一致の個体の操作口を使う。
   *
   * raw operations を保存せず、利用の都度この口を通す。操作名から任意
   * payload への汎用ディスパッチ表は作らず、反射的呼出しはしない。
   *
   * @param use - 操作口と束縛情報を使う処理。
   * @returns `use` の戻り値。
   * @throws `TypeError` — 個体が操作口を提供しない場合。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合（ホスト自身の照合）。
   */
  withOperations<R>(use: (operations: O, binding: PluginBindingInfo) => R): R;
}

/**
 * companion が宣言する管理記述子。生成元・割当て方針だけを束ね、manager は
 * これに従って駆動する。
 *
 * 表示内容の射影・監視方式・固有操作の汎用表は持たない。状態の解釈と通知は
 * endpoint 工場が組み立てる GUI アダプターの責務である。
 *
 * @typeParam S - 状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 */
export interface GuiPluginManagementDescriptor<S, O> {
  /** companion の種別トークン。小文字始まりの英数字であること。 */
  readonly kind: string;
  /** 個体の生成元。 */
  readonly definition: PluginDefinition<S, O>;
  /** 割当て方針（選択関数と上限）。 */
  readonly assignment: PluginAssignmentPolicy;
}

/**
 * 種別トークンの形式。小文字始まりの英数字であること。
 */
const KIND_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * 種別トークンか判定する。管理層の登録と companion 登録表で同じ規約を使う。
 *
 * @param value - 検査する未知値。
 * @returns 小文字始まりの英数字なら真。
 */
export function isPluginKind(value: unknown): value is string {
  return typeof value === "string" && KIND_PATTERN.test(value);
}
