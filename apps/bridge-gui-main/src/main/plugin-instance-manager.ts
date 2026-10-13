/**
 * 汎用プラグイン・インスタンス管理層の所有表と駆動。
 *
 * companion の管理記述子（生成元・割当て方針・監視方式・表示射影・固有操作）
 * に従い、生成・割当て・監視・回収・限定参照を行う。種別分岐と汎用の任意
 * payload ディスパッチ表は持たない。
 *
 * 割当ての順序は固定である。検査 → 候補・現割当て取得と選択 → 選択検証と
 * 初期化予約 → `createInstance` → `initializing` 記録 → `core.assign` →
 * 監視開始 → 失効印・core 現割当ての再確認 → `active` 確定と通知。
 * 回収は共通経路で行う。`releasing` 化と参照・callback の無効化 → 監視解除 →
 * 所有記録と完全一致する core 割当てがあれば `unassign` → `removeInstance` →
 * 記録削除 → 通知。比較は `localSessionId`・`instanceId`・`portId` の三識別子
 * で行い、同セッションの別割当てには触らない。途中失敗で後続を止めない。
 *
 * `instanceId` からと `localSessionId` からの写像は同じ記録オブジェクトを
 * 指す。回収着手の記録を外部呼び出しの前に行い、二重回収を防ぐ。callback は
 * 同一記録オブジェクトかつ `active` のときだけ通知し、停止後の古い callback
 * は無視する。読み取りに回収の副作用は付けず、core 割当ての無音取消しは
 * `reconcile()` で回収する。自動再試行はせず、失敗は `cleanupFailed` と
 * 問題報告に残す。`close()` は同期・冪等であり、core 自体は閉じない。
 *
 * @packageDocumentation
 */
import type { PluginDefinition, PluginInstanceHandle } from "bridge-app-core/core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { isPluginKind } from "bridge-gui-plugin-sdk/management";
import type {
  GuiPluginAccess,
  GuiPluginManagementDescriptor,
  GuiPluginObservation,
  OwnedPluginInstanceInfo,
  PluginAssignmentCandidate,
  PluginAssignmentPolicy,
  PluginAssignmentRequest,
  PluginBindingInfo,
  PluginOperationAccess,
  Stop,
} from "bridge-gui-plugin-sdk/management";
import type {
  PluginInstanceManagerDependencies,
  PluginManagerIssue,
  PluginReleaseResult,
} from "./plugin-instance-management.ts";

/**
 * 型を消した記述子。登録時に具象型の到達を閉包へ包み、駆動は消した型で行う。
 *
 * 具象の状態・操作・表示の値自体は消さず、境界の閉包でだけ型を主張する。
 */
interface ErasedDescriptor {
  /** companion の種別トークン。 */
  readonly kind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 個体の生成元。 */
  readonly definition: PluginDefinition<unknown, unknown>;
  /** 割当て方針。 */
  readonly assignment: PluginAssignmentPolicy;
  /** 監視方式。 */
  readonly observation: GuiPluginObservation<unknown, unknown>;
}

/** 所有の内部記録。公開形に監視解除口・指紋・失効印・回収着手印を足す。 */
interface OwnedRecord {
  /** companion の種別トークン。 */
  readonly kind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
  /** 所有の段階。 */
  phase: OwnedPluginInstanceInfo["phase"];
  /** 個体参照。型付き handle を消して持つ。 */
  readonly handle: PluginInstanceHandle<unknown, unknown>;
  /** 監視解除口。未監視なら `null`。 */
  stopObservation: Stop | null;
  /** ポーリングの前回指紋。未取得なら `null`。 */
  lastFingerprint: string | null;
  /** 初期化中の終了通知を受けたら真。割当て手続きが補償する。 */
  revoked: boolean;
  /** 回収に着手したら真。外部呼び出しの前に立てる。 */
  reclaimStarted: boolean;
}

/**
 * 記録から束縛情報の写しを作る。
 *
 * @param record - 写す所有記録。
 * @returns 公開用の束縛情報。
 */
function toBinding(record: OwnedRecord): PluginBindingInfo {
  return {
    kind: record.kind,
    pluginId: record.pluginId,
    instanceId: record.instanceId,
    localSessionId: record.localSessionId,
    portId: record.portId,
  };
}

/**
 * 記録から所有の公開形の写しを作る。
 *
 * @param record - 写す所有記録。
 * @returns 公開用の所有情報。
 */
function toOwned(record: OwnedRecord): OwnedPluginInstanceInfo {
  return { ...toBinding(record), phase: record.phase };
}

/**
 * 二つの capability が同じ組合せか判定する。
 *
 * 値の import を足さず、輸送上の種別と方向の一致だけを見る。
 *
 * @param accepts - 接続口が受け入れる組合せ。
 * @param capability - 候補セッションの組合せ。
 * @returns 受け入れる組合せに含まれれば真。
 */
function acceptsCapability(
  accepts: readonly { readonly kind: string; readonly direction: string }[],
  capability: { readonly kind: string; readonly direction: string },
): boolean {
  return accepts.some(
    (candidate) =>
      candidate.kind === capability.kind && candidate.direction === capability.direction,
  );
}

/**
 * 汎用プラグイン・インスタンス管理層。所有表の操作はすべて同期である。
 *
 * 生成は `register` で受けた記述子だけを使う。`requireBinding` のような
 * 呼び側が型引数を主張する口は作らず、表示型・操作型は `register` の
 * 戻り値で保つ。`unregister` は持たず、表を使い捨てる。
 */
export class PluginInstanceManager {
  private readonly descriptors = new Map<string, ErasedDescriptor>();
  private readonly byInstance = new Map<string, OwnedRecord>();
  private readonly bySession = new Map<string, OwnedRecord>();
  private sessionsUnsubscribe: Stop | null = null;
  private closed = false;

  /**
   * @param dependencies - core・セッション・時計・通知の注入口。
   */
  constructor(private readonly dependencies: PluginInstanceManagerDependencies) {
    this.sessionsUnsubscribe = dependencies.sessions.onEnded((localSessionId) => {
      this.handleSessionEnded(localSessionId);
    });
  }

  /**
   * 管理記述子を登録し、種別ごとの公開参照口を返す。
   *
   * 登録は最初の `assign` より前に済ませる。重複・形式外の種別は拒否する。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @typeParam V - 限定表示の型。
   * @typeParam A - 公開する固有操作の型。
   * @param descriptor - companion が宣言する管理記述子。
   * @returns 種別の公開参照口。表示型・操作型を保つ。
   * @throws `Error` — 終了済み・種別が形式外・登録済み・記述子が欠けた場合。
   */
  register<S, O, V extends InstanceBaseView, A>(
    descriptor: GuiPluginManagementDescriptor<S, O, V, A>,
  ): GuiPluginAccess<V, A> {
    if (this.closed) {
      throw new Error("管理層は終了済みのため登録を受け付けない。");
    }
    if (!isPluginKind(descriptor.kind)) {
      throw new Error("管理記述子の種別トークンが形式外である。");
    }
    if (this.descriptors.has(descriptor.kind)) {
      throw new Error(`管理記述子は登録済みである: ${descriptor.kind}`);
    }
    if (
      descriptor.definition === null ||
      descriptor.definition === undefined ||
      descriptor.assignment === null ||
      descriptor.assignment === undefined ||
      descriptor.observation === null ||
      descriptor.observation === undefined ||
      typeof descriptor.projectView !== "function" ||
      typeof descriptor.buildOperations !== "function"
    ) {
      throw new Error("管理記述子が必要な項目を欠いている。");
    }
    const kind = descriptor.kind;
    // ADR: 型消しは駆動表の保持のためであり、値の到達は閉包で保つ。
    // `PluginInstance<S, O>` の到達は戻り値の共変で `unknown` に載るため、
    // 生成元の主張は要らない。以下も同様に境界の閉包だけで主張する。
    const definition: PluginDefinition<unknown, unknown> = descriptor.definition;
    const observation = this.eraseObservation(descriptor.observation);
    this.descriptors.set(kind, {
      kind,
      pluginId: descriptor.definition.pluginId,
      definition,
      assignment: descriptor.assignment,
      observation,
    });
    const access: PluginOperationAccess<O> = {
      withOperations: <R>(
        instanceId: string,
        use: (operations: O, binding: PluginBindingInfo) => R,
      ): R => {
        // ADR: `as` を使う理由は、消した操作値を使う処理を同じ記述子の
        // 操作型へ戻すためである。根拠は、実行時の値が当該個体の操作口
        // そのものであり、保存せず利用の都度渡すことである。
        const useErased = use as (operations: unknown, binding: PluginBindingInfo) => R;
        return this.withOperationsInternal(kind, instanceId, useErased);
      },
    };
    const operations: A = descriptor.buildOperations(access);
    return {
      kind,
      listBindings: () => this.listBindings(kind),
      requireBinding: (instanceId: string) => this.requireBinding(kind, instanceId),
      readView: (instanceId: string) => this.readViewInternal(descriptor, kind, instanceId),
      operations,
    };
  }

  /**
   * 監視方式の型を消す。購読の開始口と指紋関数の到達は閉包で保つ。
   *
   * @typeParam S - 状態の型。
   * @typeParam O - プラグイン固有の操作口の型。
   * @param observation - 記述子が宣言する監視方式。
   * @returns 型を消した監視方式。
   */
  private eraseObservation<S, O>(
    observation: GuiPluginManagementDescriptor<S, O, InstanceBaseView, unknown>["observation"],
  ): GuiPluginObservation<unknown, unknown> {
    if (observation.mode === "none") {
      return { mode: "none" };
    }
    if (observation.mode === "subscribe") {
      const start = observation.start;
      return {
        mode: "subscribe",
        start: (handle, changed) => {
          // ADR: `as` を使う理由は、消した個体参照を同じ記述子の監視へ戻す
          // ためである。根拠は、参照が当該記述子の生成元から作られたもので
          // あり、所有記録と対になることである。
          const typed = handle as PluginInstanceHandle<S, O>;
          return start(typed, changed);
        },
      };
    }
    const fingerprint = observation.fingerprint;
    return {
      mode: "poll",
      intervalMs: observation.intervalMs,
      fingerprint: (state) => {
        // ADR: `as` を使う理由は、消した状態値を同じ記述子の指紋関数へ戻す
        // ためである。根拠は、値が当該個体の `getState` の戻り値そのもので
        // あることである。
        const typed = state as S;
        return fingerprint(typed);
      },
    };
  }

  /**
   * 割当てを行う。要望に従い候補から選び、確定するまで公開しない。
   *
   * 選択結果は検証し、不正な割当て先では生成前に `RangeError` で拒否する。
   * 上限の算入には `initializing` と `cleanupFailed` を含める。
   *
   * @param kind - 割り当てる種別トークン。登録済みであること。
   * @param request - 割当ての要望。省略時は自動選択。
   * @returns 確定した束縛情報。
   * @throws `RangeError` — 未登録種別・要望不正・候補不足・選択結果不正・
   * 上限超過・初期化中の失効の場合。
   * @throws `Error` — 終了済みの場合。
   */
  assign(kind: string, request: PluginAssignmentRequest = { mode: "auto" }): PluginBindingInfo {
    if (this.closed) {
      throw new Error("管理層は終了済みのため割当てを受け付けない。");
    }
    const descriptor = this.descriptors.get(kind);
    if (descriptor === undefined) {
      throw new RangeError("未登録の種別である。");
    }
    if (request.mode === "session" && request.localSessionId.length === 0) {
      throw new RangeError("割当て対象の識別子は空でないこと。");
    }
    const ownedOfKind = [...this.byInstance.values()].filter((record) => record.kind === kind);
    if (
      descriptor.assignment.maxInstances !== null &&
      ownedOfKind.length >= descriptor.assignment.maxInstances
    ) {
      throw new RangeError("個体数の上限を超える。");
    }
    const candidates = this.buildCandidates();
    const bindings: PluginBindingInfo[] = ownedOfKind.map(toBinding);
    const target = descriptor.assignment.select({ request, candidates, bindings });
    this.assertSelectable(descriptor, request, candidates, target, ownedOfKind.length);
    // ADR: 初期化予約は上限の再確認で行う。`select` が副作用なしのため、
    // 選択前後で所有数は変わらず、検証と生成の間も同期的で割り込まない。
    const handle = this.dependencies.core.createInstance(descriptor.definition);
    const record: OwnedRecord = {
      kind,
      pluginId: descriptor.pluginId,
      instanceId: handle.instanceId,
      localSessionId: target.localSessionId,
      portId: target.portId,
      phase: "initializing",
      handle,
      stopObservation: null,
      lastFingerprint: null,
      revoked: false,
      reclaimStarted: false,
    };
    this.byInstance.set(record.instanceId, record);
    this.bySession.set(record.localSessionId, record);
    try {
      this.dependencies.core.assign(record.localSessionId, record.instanceId, record.portId);
    } catch (error) {
      this.compensateFailedInit(record);
      throw error;
    }
    try {
      this.startObservation(descriptor, record);
    } catch (error) {
      this.compensateFailedInit(record);
      throw error;
    }
    // ADR: 失効印と現割当ての両方を見る。終了通知の到達順によらず、
    // 初期化中の取消しを確定にしない。
    if (record.revoked || !this.matchesCoreAssignment(record)) {
      this.compensateFailedInit(record);
      throw new RangeError("割当て対象が初期化中に失効した。");
    }
    record.phase = "active";
    this.emitChanged(null);
    return toBinding(record);
  }

  /**
   * 個体を解放する。初回は回収し、二重解除は `released:false` とする。
   *
   * 所有中でない種別の解除は `RangeError` とする。回収失敗を `{ok:true}` に
   * 潰さず、問題を残す。
   *
   * @param kind - 解放する種別トークン。登録済みであること。
   * @param instanceId - 解放する個体識別子。
   * @returns 解放結果。
   * @throws `RangeError` — 未登録種別・種別不一致・識別子不正の場合。
   */
  unassign(kind: string, instanceId: string): PluginReleaseResult {
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new RangeError("instanceId は空でない文字列であること。");
    }
    if (!this.descriptors.has(kind)) {
      throw new RangeError("未登録の種別である。");
    }
    const record = this.byInstance.get(instanceId);
    if (record === undefined) {
      return { released: false, issues: [] };
    }
    if (record.kind !== kind) {
      throw new RangeError("束縛した個体の種別と要求が一致しない。");
    }
    if (record.reclaimStarted || record.phase === "releasing" || record.phase === "cleanupFailed") {
      return { released: false, issues: [] };
    }
    if (record.phase === "initializing") {
      // ADR: 初期化中の解放要求は失効印に留め、手続きの補償に任せる。
      // 二重回収を避け、割当て側の例外を正とする。
      record.revoked = true;
      return { released: false, issues: [] };
    }
    const issues = this.reclaimRecord(record);
    return { released: true, issues };
  }

  /**
   * 確定済みで現割当て一致の束縛だけを返す。
   *
   * @param kind - 照合する種別トークン。登録済みであること。
   * @returns 束縛情報の一覧。
   * @throws `RangeError` — 未登録種別の場合。
   */
  listBindings(kind: string): readonly PluginBindingInfo[] {
    if (!this.descriptors.has(kind)) {
      throw new RangeError("未登録の種別である。");
    }
    const assignments = this.dependencies.core.listAssignments();
    const sessions = this.dependencies.sessions.list();
    const result: PluginBindingInfo[] = [];
    for (const record of this.byInstance.values()) {
      if (record.kind !== kind || record.phase !== "active") {
        continue;
      }
      if (this.isCurrentlyBound(record, assignments, sessions)) {
        result.push(toBinding(record));
      }
    }
    return result;
  }

  /**
   * 束縛を1件返す。所有中・確定済み・現割当て一致でなければ拒否する。
   * 読み取りに回収の副作用は付けない。
   *
   * @param kind - 照合する種別トークン。登録済みであること。
   * @param instanceId - 照合する個体識別子。
   * @returns 束縛情報。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  requireBinding(kind: string, instanceId: string): PluginBindingInfo {
    return toBinding(this.verifyActive(kind, instanceId));
  }

  /**
   * 所有の公開形の一覧を返す。段階の絞り込みはしない。
   *
   * @returns 所有情報の写しの一覧。
   */
  listOwned(): readonly OwnedPluginInstanceInfo[] {
    return [...this.byInstance.values()].map(toOwned);
  }

  /**
   * core 現割当ての無音取消しを回収する。読み取りでは回収しない分を、
   * 明示の照合で片付ける。
   */
  reconcile(): void {
    if (this.closed) {
      return;
    }
    let assignments: ReturnType<PluginInstanceManagerDependencies["core"]["listAssignments"]>;
    let sessions: ReturnType<PluginInstanceManagerDependencies["sessions"]["list"]>;
    try {
      assignments = this.dependencies.core.listAssignments();
      sessions = this.dependencies.sessions.list();
    } catch {
      // ADR: 取得失敗では何も変えない。失効の有無が不明なため、
      // 回収の誤作動より現状維持を優先する。
      return;
    }
    for (const record of [...this.byInstance.values()]) {
      if (record.phase !== "active" || record.reclaimStarted) {
        continue;
      }
      if (!this.isCurrentlyBound(record, assignments, sessions)) {
        this.reclaimRecord(record);
      }
    }
  }

  /**
   * 管理層を閉じる。同期・冪等である。
   *
   * 受付停止・終了通知の購読解除・所有個体の回収を行う。core・server 自体は
   * 閉じない。完全回収を保証したとは報告せず、残った `cleanupFailed` は
   * ホストの `core.close()` に委ねる。
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const unsubscribe = this.sessionsUnsubscribe;
    this.sessionsUnsubscribe = null;
    if (unsubscribe !== null) {
      try {
        unsubscribe();
      } catch (cause) {
        this.reportIssue({ stage: "event-unsubscribe", binding: null, cause });
      }
    }
    for (const record of [...this.byInstance.values()]) {
      if (record.reclaimStarted || record.phase === "cleanupFailed") {
        continue;
      }
      if (record.phase === "initializing") {
        // ADR: 初期化中の終了は失効印に留め、手続きの補償に任せる。
        // 同期手続きのため到達しないが、再入でも二重回収しない。
        record.revoked = true;
        continue;
      }
      if (record.phase === "releasing") {
        continue;
      }
      this.reclaimRecord(record);
    }
  }

  /**
   * 限定表示を読む。所有中・確定済み・現割当て一致でなければ拒否する。
   *
   * @typeParam S - 状態の型。
   * @typeParam V - 限定表示の型。
   * @param descriptor - 登録済みの管理記述子。
   * @param kind - 照合する種別トークン。
   * @param instanceId - 照合する個体識別子。
   * @returns 子画面へ渡せる限定表示。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  private readViewInternal<S, O, V extends InstanceBaseView, A>(
    descriptor: GuiPluginManagementDescriptor<S, O, V, A>,
    kind: string,
    instanceId: string,
  ): V {
    const record = this.verifyActive(kind, instanceId);
    // ADR: `as` を使う理由は、消した状態値を同じ記述子の射影へ戻すためである。
    // 根拠は、参照が当該記述子の生成元から作られたものであることである。
    const state = record.handle.getState() as S;
    return descriptor.projectView({ binding: toBinding(record), state });
  }

  /**
   * 操作口を使う。所有中・確定済み・現割当て一致でなければ拒否する。
   *
   * @typeParam R - 利用処理の戻り値の型。
   * @param kind - 照合する種別トークン。
   * @param instanceId - 照合する個体識別子。
   * @param use - 操作口と束縛情報を使う処理。
   * @returns `use` の戻り値。
   * @throws `TypeError` — 個体が操作口を提供しない場合。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  private withOperationsInternal<R>(
    kind: string,
    instanceId: string,
    use: (operations: unknown, binding: PluginBindingInfo) => R,
  ): R {
    const record = this.verifyActive(kind, instanceId);
    const operations: unknown = record.handle.getOperations?.();
    if (operations === undefined) {
      throw new TypeError("操作口が無い。");
    }
    return use(operations, toBinding(record));
  }

  /**
   * 所有中・確定済み・現割当て一致の記録を取り出す。
   *
   * @param kind - 照合する種別トークン。
   * @param instanceId - 照合する個体識別子。
   * @returns 検証済みの所有記録。
   * @throws `RangeError` — 不明・種別外・失効・現割当て不一致の場合。
   */
  private verifyActive(kind: string, instanceId: string): OwnedRecord {
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new RangeError("instanceId は空でない文字列であること。");
    }
    if (!this.descriptors.has(kind)) {
      throw new RangeError("未登録の種別である。");
    }
    const record = this.byInstance.get(instanceId);
    if (record === undefined) {
      throw new RangeError("所有していない個体である。");
    }
    if (record.kind !== kind) {
      throw new RangeError("束縛した個体の種別と要求が一致しない。");
    }
    if (record.phase !== "active") {
      throw new RangeError("確定済みの個体ではない。");
    }
    const assignments = this.dependencies.core.listAssignments();
    const sessions = this.dependencies.sessions.list();
    if (!this.isCurrentlyBound(record, assignments, sessions)) {
      throw new RangeError("現割当てと一致しない。");
    }
    return record;
  }

  /**
   * 記録が現割当てと一致するか判定する。回収の副作用は付けない。
   *
   * @param record - 判定する所有記録。
   * @param assignments - core 現割当ての一覧。
   * @param sessions - 生存セッションの公開情報の一覧。
   * @returns 三識別子が完全一致し対象セッションが生存すれば真。
   */
  private isCurrentlyBound(
    record: OwnedRecord,
    assignments: readonly {
      readonly localSessionId: string;
      readonly instanceId: string;
      readonly portId: string;
    }[],
    sessions: readonly { readonly localSessionId: string; readonly alive: boolean }[],
  ): boolean {
    const matched = assignments.some(
      (assignment) =>
        assignment.localSessionId === record.localSessionId &&
        assignment.instanceId === record.instanceId &&
        assignment.portId === record.portId,
    );
    if (!matched) {
      return false;
    }
    const session = sessions.find(
      (candidate) => candidate.localSessionId === record.localSessionId,
    );
    return session !== undefined && session.alive;
  }

  /**
   * 所有記録と完全一致する core 割当てがあるか判定する。
   *
   * @param record - 判定する所有記録。
   * @returns 三識別子が完全一致すれば真。
   */
  private matchesCoreAssignment(record: OwnedRecord): boolean {
    let assignments: readonly {
      readonly localSessionId: string;
      readonly instanceId: string;
      readonly portId: string;
    }[];
    try {
      assignments = this.dependencies.core.listAssignments();
    } catch {
      // ADR: 取得不能時は不一致とみなし、`unassign` を行わない。失効の有無が
      // 不明な状態での解除は同セッションの別割当てを触る恐れがあり、現状維持を
      // 優先する。挙動の他の変更はしない。
      return false;
    }
    return assignments.some(
      (assignment) =>
        assignment.localSessionId === record.localSessionId &&
        assignment.instanceId === record.instanceId &&
        assignment.portId === record.portId,
    );
  }

  /**
   * 候補の一覧を作る。core 現在値を付加し、所有外の割当ても含める。
   *
   * @returns 割当て候補の一覧。
   */
  private buildCandidates(): PluginAssignmentCandidate[] {
    const assignments = this.dependencies.core.listAssignments();
    const bySession = new Map(
      assignments.map((assignment) => [assignment.localSessionId, assignment] as const),
    );
    return this.dependencies.sessions.list().map((session) => ({
      ...session,
      assignment: bySession.get(session.localSessionId) ?? null,
    }));
  }

  /**
   * 選択結果を検証する。候補に存在・生存・未割当て・接続口の存在と適合・
   * 要望との一致・上限超過の有無を見る。
   *
   * @param descriptor - 割当て対象の記述子。
   * @param request - 割当ての要望。
   * @param candidates - 割当て候補の一覧。
   * @param target - 方針が選んだ割当て先。
   * @param ownedCount - 当該種別の所有数（全段階）。
   * @throws `RangeError` — 選択結果が不正・上限超過の場合。
   */
  private assertSelectable(
    descriptor: ErasedDescriptor,
    request: PluginAssignmentRequest,
    candidates: readonly PluginAssignmentCandidate[],
    target: { readonly localSessionId: string; readonly portId: string },
    ownedCount: number,
  ): void {
    const candidate = candidates.find((entry) => entry.localSessionId === target.localSessionId);
    if (candidate === undefined) {
      throw new RangeError("候補に無い割当て先である。");
    }
    if (!candidate.alive) {
      throw new RangeError("生存していない割当て先である。");
    }
    if (candidate.assignment !== null) {
      throw new RangeError("既に割り当て済みの割当て先である。");
    }
    const port = descriptor.definition.ports.find((entry) => entry.portId === target.portId);
    if (port === undefined) {
      throw new RangeError("定義に無い接続口である。");
    }
    if (!acceptsCapability(port.accepts, candidate.capability)) {
      throw new RangeError("接続口の適合に合わない割当て先である。");
    }
    if (request.mode === "session" && target.localSessionId !== request.localSessionId) {
      throw new RangeError("指定した候補と割当て先が一致しない。");
    }
    if (
      descriptor.assignment.maxInstances !== null &&
      ownedCount >= descriptor.assignment.maxInstances
    ) {
      throw new RangeError("個体数の上限を超える。");
    }
  }

  /**
   * 監視を始める。開始時の同期 callback では未確定個体を公開しない。
   *
   * @param descriptor - 割当て対象の記述子。
   * @param record - 監視する所有記録（`initializing`）。
   * @throws 監視の開始・初回指紋の取得に失敗した場合。そのまま投げる。
   */
  private startObservation(descriptor: ErasedDescriptor, record: OwnedRecord): void {
    const observation = descriptor.observation;
    if (observation.mode === "none") {
      return;
    }
    if (observation.mode === "subscribe") {
      const changed = (): void => {
        // ADR: 同一記録オブジェクトかつ `active` のときだけ通知する。
        // 開始時の同期 callback と停止後の古い callback は捨てる。
        if (this.byInstance.get(record.instanceId) !== record) {
          return;
        }
        if (record.phase !== "active") {
          return;
        }
        this.emitChanged(toBinding(record));
      };
      record.stopObservation = observation.start(record.handle, changed);
      return;
    }
    if (!Number.isFinite(observation.intervalMs) || observation.intervalMs <= 0) {
      throw new RangeError("監視間隔は正の有限値であること。");
    }
    const initial = record.handle.getState();
    record.lastFingerprint = observation.fingerprint(initial);
    const tick = (): void => {
      if (this.byInstance.get(record.instanceId) !== record) {
        return;
      }
      if (record.phase !== "active") {
        return;
      }
      let current: unknown;
      try {
        current = record.handle.getState();
      } catch (cause) {
        // ADR: 確定後の指紋取得失敗は個体を解除せず、問題報告に留める。
        this.reportIssue({ stage: "poll", binding: toBinding(record), cause });
        return;
      }
      let next: string;
      try {
        next = observation.fingerprint(current);
      } catch (cause) {
        this.reportIssue({ stage: "poll", binding: toBinding(record), cause });
        return;
      }
      if (next !== record.lastFingerprint) {
        record.lastFingerprint = next;
        this.emitChanged(toBinding(record));
      }
    };
    record.stopObservation = this.dependencies.clock.every(observation.intervalMs, tick);
  }

  /**
   * 初期化に失敗した記録を補償する。監視解除・割当て解除・生成分回収を
   * 順に行い、記録を残さない。確定前のため変化通知は送らない。
   *
   * @param record - 補償する所有記録（`initializing`）。
   */
  private compensateFailedInit(record: OwnedRecord): void {
    const binding = toBinding(record);
    if (record.stopObservation !== null) {
      const stop = record.stopObservation;
      record.stopObservation = null;
      try {
        stop();
      } catch (cause) {
        this.reportIssue({ stage: "observation-stop", binding, cause });
      }
    }
    if (this.matchesCoreAssignment(record)) {
      try {
        this.dependencies.core.unassign(record.localSessionId);
      } catch (cause) {
        this.reportIssue({ stage: "unassign", binding, cause });
      }
    }
    try {
      this.dependencies.core.removeInstance(record.instanceId);
    } catch (cause) {
      this.reportIssue({ stage: "remove-instance", binding, cause });
    }
    if (this.byInstance.get(record.instanceId) === record) {
      this.byInstance.delete(record.instanceId);
    }
    if (this.bySession.get(record.localSessionId) === record) {
      this.bySession.delete(record.localSessionId);
    }
  }

  /**
   * 共通の回収経路。`releasing` 化と参照・callback の無効化 → 監視解除 →
   * 完全一致する core 割当てがあれば `unassign` → `removeInstance` →
   * 記録削除 → 通知。途中失敗で後続を止めない。
   *
   * @param record - 回収する所有記録。
   * @returns 回収の過程で起きた問題の一覧。
   */
  private reclaimRecord(record: OwnedRecord): PluginManagerIssue[] {
    // ADR: 回収着手は外部呼び出しの前に記録する。`unassign` の同期終了通知で
    // 同一個体が再入しても再回収しない。
    record.reclaimStarted = true;
    record.phase = "releasing";
    const issues: PluginManagerIssue[] = [];
    const binding = toBinding(record);
    if (record.stopObservation !== null) {
      const stop = record.stopObservation;
      record.stopObservation = null;
      try {
        stop();
      } catch (cause) {
        issues.push({ stage: "observation-stop", binding, cause });
      }
    }
    if (this.matchesCoreAssignment(record)) {
      try {
        this.dependencies.core.unassign(record.localSessionId);
      } catch (cause) {
        issues.push({ stage: "unassign", binding, cause });
      }
    }
    try {
      this.dependencies.core.removeInstance(record.instanceId);
    } catch (cause) {
      issues.push({ stage: "remove-instance", binding, cause });
      // ADR: 自動再試行はしない。`cleanupFailed` として残し、再利用しない。
      // 最終回収はホストの `core.close()` に委ねる。
      record.phase = "cleanupFailed";
      for (const issue of issues) {
        this.reportIssue(issue);
      }
      const notification = this.emitChanged(binding);
      if (notification !== null) {
        issues.push(notification);
        this.reportIssue(notification);
      }
      return issues;
    }
    if (this.byInstance.get(record.instanceId) === record) {
      this.byInstance.delete(record.instanceId);
    }
    if (this.bySession.get(record.localSessionId) === record) {
      this.bySession.delete(record.localSessionId);
    }
    for (const issue of issues) {
      this.reportIssue(issue);
    }
    const notification = this.emitChanged(binding);
    if (notification !== null) {
      issues.push(notification);
      this.reportIssue(notification);
    }
    return issues;
  }

  /**
   * セッション終了を受ける。初期化中なら失効印に留め、手続きの補償に任せる。
   *
   * @param localSessionId - 終了した生存セッションのローカル識別子。
   */
  private handleSessionEnded(localSessionId: string): void {
    const record = this.bySession.get(localSessionId);
    if (record === undefined || record.reclaimStarted) {
      return;
    }
    if (record.phase === "initializing") {
      record.revoked = true;
      return;
    }
    if (record.phase !== "active") {
      return;
    }
    this.reclaimRecord(record);
  }

  /**
   * 変化を通知する。購読者の例外は問題報告に回す。
   *
   * @param binding - 変化の対象。特定できない場合は `null`。
   * @returns 通知に失敗した場合の問題。成功なら `null`。
   */
  private emitChanged(binding: PluginBindingInfo | null): PluginManagerIssue | null {
    try {
      this.dependencies.onChanged();
    } catch (cause) {
      return { stage: "notification", binding, cause };
    }
    return null;
  }

  /**
   * 問題を報告する。受け口の例外で管理層を壊さない。
   *
   * @param issue - 報告する問題。
   */
  private reportIssue(issue: PluginManagerIssue): void {
    try {
      this.dependencies.onIssue(issue);
    } catch {
      // 受け口の例外で後始末を壊さない。
    }
  }
}
