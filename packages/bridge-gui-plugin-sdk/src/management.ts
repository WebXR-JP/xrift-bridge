/**
 * プラグイン実装者が参照する管理記述子の公開契約。
 *
 * ホスト汎用管理層が駆動する記述子・候補 DTO・公開参照口・監視方式の
 * 型だけを置く。具体の送受信・表示内容は companion が宣言する記述子が
 * 駆動し、この層に種別分岐と汎用の任意 payload ディスパッチ表は持たない。
 *
 * ホスト内部の実装依存口（`PluginInstanceManager` 実装・
 * `PluginManagerSessions`・`PluginManagerClock`・
 * `PluginInstanceManagerDependencies`・`PluginManagerIssue`・
 * `PluginReleaseResult` 等）はここに置かない。具象プラグインの import・
 * 既定登録の副作用・Electrobun/Bun/Node 実体・ホストソースパス参照を
 * 持たず、`bridge-app-core/core` と `bridge-gui-contract/plugin-instance`
 * の型だけを参照する。
 *
 * @packageDocumentation
 */
import type {
  AssignmentInfo,
  PluginDefinition,
  PluginInstanceHandle,
  SessionCapability,
} from "bridge-app-core/core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";

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

/** 購読・周期監視の解除口。 */
export type Stop = () => void;

/**
 * 個体の監視方式。companion が宣言する。
 *
 * - `none`: 監視しない。
 * - `subscribe`: 個体の変化通知に載る。`start` は成功で解除口を返し、
 *   失敗なら登録資源を残さず throw する。
 * - `poll`: 周期的に指紋を比べて変化を検出する。初回値は開始時に取得し、
 *   失敗は割当て失敗として補償する。確定後の取得失敗は個体を解除せず
 *   問題報告に留め、次周期へ進む。
 *
 * @typeParam S - 状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 */
export type GuiPluginObservation<S, O> =
  | { readonly mode: "none" }
  | {
      readonly mode: "subscribe";
      /**
       * 変化通知の購読を始める。
       *
       * 開始時の同期 callback では未確定個体を公開しないよう、呼び出し側は
       * 確定前の通知を捨てる。失敗なら登録資源を残さず throw すること。
       *
       * @param handle - 監視対象の個体参照。
       * @param changed - 状態が変わったときの通知。例外を投げないこと。
       * @returns 購読解除口。
       */
      start(handle: PluginInstanceHandle<S, O>, changed: () => void): Stop;
    }
  | {
      readonly mode: "poll";
      /** 指紋照合の間隔（ミリ秒）。正の有限値であること。 */
      readonly intervalMs: number;
      /**
       * 状態の指紋を作る。等しければ通知しない。
       *
       * @param state - 個体の現在状態。
       * @returns 変化検出用の指紋文字列。
       */
      fingerprint(state: S): string;
    };

/**
 * プラグイン固有操作への限定到達口。main 側アダプターだけが使う。
 *
 * raw operations を保存せず、利用の都度この口を通す。操作名から任意
 * payload への汎用ディスパッチ表は作らない。操作口不足は `TypeError`、
 * 不明・種別外・失効は `RangeError` で示す。
 *
 * @typeParam O - プラグイン固有の操作口の型。
 */
export interface PluginOperationAccess<O> {
  /**
   * 所有中・確定済み・現割当て一致の個体の操作口を使う。
   *
   * @param instanceId - 操作対象の個体識別子。
   * @param use - 操作口と束縛情報を使う処理。
   * @returns `use` の戻り値。
   * @throws `TypeError` — 個体が操作口を提供しない場合。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  withOperations<R>(instanceId: string, use: (operations: O, binding: PluginBindingInfo) => R): R;
}

/**
 * companion が宣言する管理記述子。生成元・割当て方針・監視方式・表示射影・
 * 固有操作の構築を束ね、manager はこれに従って駆動する。
 *
 * @typeParam S - 状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 * @typeParam V - 限定表示の型。
 * @typeParam A - 公開する固有操作の構築結果の型。
 */
export interface GuiPluginManagementDescriptor<S, O, V extends InstanceBaseView, A> {
  /** companion の種別トークン。小文字始まりの英数字であること。 */
  readonly kind: string;
  /** 個体の生成元。 */
  readonly definition: PluginDefinition<S, O>;
  /** 割当て方針。 */
  readonly assignment: PluginAssignmentPolicy;
  /** 監視方式。 */
  readonly observation: GuiPluginObservation<S, O>;
  /**
   * 限定表示を作る。他個体・管理情報は載せない。
   *
   * @param input - 束縛情報と個体の現在状態。
   * @returns 子画面へ渡せる限定表示。
   */
  projectView(input: { readonly binding: PluginBindingInfo; readonly state: S }): V;
  /**
   * 公開する固有操作を組み立てる。到達は受け取った限定口だけを使う。
   *
   * @param access - プラグイン固有操作への限定到達口。
   * @returns 公開する固有操作。
   */
  buildOperations(access: PluginOperationAccess<O>): A;
}

/**
 * 種別ごとの公開参照口。`register` の戻り値で表示型・操作型を保持し、
 * 呼び側が型引数を主張する口は作らない。
 *
 * @typeParam V - 限定表示の型。
 * @typeParam A - 公開する固有操作の型。
 */
export interface GuiPluginAccess<V extends InstanceBaseView, A> {
  /** companion の種別トークン。 */
  readonly kind: string;
  /**
   * 確定済みで現割当て一致の束縛だけを返す。
   *
   * @returns 束縛情報の一覧。
   */
  listBindings(): readonly PluginBindingInfo[];
  /**
   * 束縛を1件返す。所有中・確定済み・現割当て一致でなければ拒否する。
   *
   * @param instanceId - 照合する個体識別子。
   * @returns 束縛情報。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  requireBinding(instanceId: string): PluginBindingInfo;
  /**
   * 限定表示を読む。読み取りに回収の副作用を付けない。
   *
   * @param instanceId - 照合する個体識別子。
   * @returns 子画面へ渡せる限定表示。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  readView(instanceId: string): V;
  /** 記述子が組み立てた固有操作。 */
  readonly operations: A;
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
