/**
 * インスタンス管理層の検証用偽物。偽 core・偽セッションと
 * 合成プラグイン2種（`alpha`・`beta`）の記述子を置く。
 *
 * 具象プラグイン（text/diagnostic）の import は置かない。試験本体の
 * `*.test.ts` から使い、単体では実行しない。
 */
import type {
  AssignmentInfo,
  BridgeAppCore,
  PluginDefinition,
  PluginInstance,
  PluginInstanceHandle,
  SessionCapability,
} from "bridge-app-core/core";
import type { AssignedSession } from "bridge-app-core/core";
import type {
  GuiPluginManagementDescriptor,
  PluginAssignmentCandidate,
  PluginAssignmentPolicy,
  PluginAssignmentRequest,
  PluginBindingInfo,
  PluginSessionMetadata,
} from "bridge-gui-plugin-sdk/management";
import type {
  PluginInstanceManagerDependencies,
  PluginManagerIssue,
} from "../src/main/plugin-instance-management.ts";

/** 輸送上の適合の雛形。接続口の適合判定に使う。 */
export const RELIABLE_BIDI: SessionCapability = { kind: "reliable", direction: "bidirectional" };

/**
 * 検証用の生存セッション公開情報を作る。
 *
 * @param localSessionId - ローカル識別子。
 * @param connectionId - 属する接続の識別子。
 * @param sessionId - 論理名。
 * @param capability - 輸送上の適合。
 * @param alive - 生存していれば真。
 * @returns 公開情報。
 */
export function makeSession(
  localSessionId: string,
  connectionId: string,
  sessionId = "session",
  capability: SessionCapability = RELIABLE_BIDI,
  alive = true,
): PluginSessionMetadata {
  return { localSessionId, connectionId, sessionId, capability, alive };
}

/**
 * 検証用の偽 core。操作途中の throw と同期 callback の注入ができる。
 *
 * 割当ての一対一は簡易に保ち、適合の厳密な判定は管理層に任せる。
 * インスタンスの有無と割当ての有無だけを見る。
 */
export class FakeCore implements Pick<
  BridgeAppCore,
  "createInstance" | "assign" | "unassign" | "removeInstance" | "listAssignments"
> {
  /** 生成中のインスタンス。表示用ではなく検証用である。 */
  readonly instances = new Map<string, PluginInstance<unknown, unknown>>();
  /** 現割当て（ローカル識別子→割当て先）。 */
  readonly assignments = new Map<string, { instanceId: string; portId: string }>();
  /** 呼び出し記録。回数の検証に使う。 */
  readonly calls: string[] = [];
  /** `createInstance` で投げる失敗。`null` なら成功する。 */
  failCreate: unknown = null;
  /** `assign` で投げる失敗。`null` なら成功する。 */
  failAssign: unknown = null;
  /** `unassign` で投げる失敗。`null` なら成功する。 */
  failUnassign: unknown = null;
  /** `removeInstance` で投げる失敗。`null` なら成功する。 */
  failRemove: unknown = null;
  /** `listAssignments` で投げる失敗。`null` なら成功する。 */
  failList: unknown = null;
  /** `assign` の記録後に同期で呼ぶ処理。終了通知の模擬に使う。 */
  onAssignSync: (() => void) | null = null;
  /** `unassign` の記録後に同期で呼ぶ処理。再入の終了通知の模擬に使う。 */
  onUnassignSync: (() => void) | null = null;
  /** 管理層が `close` 相当を呼ばないことの確認用。呼ぶ口自体が無い。 */
  closedByManager = false;
  private sequence = 1;

  createInstance<S, O>(definition: PluginDefinition<S, O>): PluginInstanceHandle<S, O> {
    this.calls.push("createInstance");
    if (this.failCreate !== null) {
      throw this.failCreate;
    }
    const instanceId = `instance-${this.sequence++}`;
    const instance = definition.create();
    // ADR: `as` を使う理由は、検証用の保持表を種別を問わない形にするためである。
    // 根拠は、試験で生成元と参照を対にして組み立てることである。
    this.instances.set(instanceId, instance as PluginInstance<unknown, unknown>);
    return {
      instanceId,
      pluginId: definition.pluginId,
      getState: () => instance.getState(),
      getOperations: () => instance.getOperations?.(),
    };
  }

  assign(localSessionId: string, instanceId: string, portId: string): void {
    this.calls.push(`assign:${localSessionId}:${instanceId}:${portId}`);
    if (this.failAssign !== null) {
      throw this.failAssign;
    }
    if (!this.instances.has(instanceId)) {
      throw new RangeError("不明なインスタンスである。");
    }
    if (this.assignments.has(localSessionId)) {
      throw new RangeError("既に割り当て済みのセッションである。");
    }
    this.assignments.set(localSessionId, { instanceId, portId });
    this.onAssignSync?.();
  }

  unassign(localSessionId: string): void {
    this.calls.push(`unassign:${localSessionId}`);
    if (!this.assignments.has(localSessionId)) {
      throw new RangeError("不明な割当てである。");
    }
    if (this.failUnassign !== null) {
      throw this.failUnassign;
    }
    this.assignments.delete(localSessionId);
    this.onUnassignSync?.();
  }

  removeInstance(instanceId: string): void {
    this.calls.push(`removeInstance:${instanceId}`);
    if (this.failRemove !== null) {
      throw this.failRemove;
    }
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      throw new RangeError("不明なインスタンスである。");
    }
    for (const [key, assignment] of this.assignments) {
      if (assignment.instanceId === instanceId) {
        this.assignments.delete(key);
      }
    }
    this.instances.delete(instanceId);
    try {
      instance.dispose();
    } catch {
      // 破棄の失敗は検証を止めない。
    }
  }

  listAssignments(): readonly AssignmentInfo[] {
    if (this.failList !== null) {
      throw this.failList;
    }
    return [...this.assignments].map(([localSessionId, assignment]) => ({
      localSessionId,
      instanceId: assignment.instanceId,
      portId: assignment.portId,
    }));
  }

  /**
   * 通知なしに割当てを消す。無音取消しの再現に使う。
   *
   * @param localSessionId - 消す割当てのローカル識別子。
   */
  revokeSilently(localSessionId: string): void {
    this.assignments.delete(localSessionId);
  }

  /**
   * よその割当てを上書きする。同セッションの別割当ての再現に使う。
   *
   * @param localSessionId - 上書きするローカル識別子。
   * @param instanceId - よその個体識別子。
   * @param portId - よその接続口識別子。
   */
  plantForeign(localSessionId: string, instanceId: string, portId: string): void {
    this.assignments.set(localSessionId, { instanceId, portId });
  }

  /**
   * 呼び出し記録の件数を数える。
   *
   * @param prefix - 呼び出し記録の接頭辞。
   * @returns 一致した件数。
   */
  countCalls(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}

/**
 * 検証用の偽セッション。終了通知を同期に送れる。
 */
export class FakeSessions {
  /** 公開情報の一覧。試験で差し替える。 */
  entries: PluginSessionMetadata[] = [];
  private readonly listeners = new Set<(localSessionId: string) => void>();
  /** 購読解除の回数。終了処理の検証に使う。 */
  stops = 0;

  list(): readonly PluginSessionMetadata[] {
    return [...this.entries];
  }

  onEnded(listener: (localSessionId: string) => void): () => void {
    this.listeners.add(listener);
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      this.listeners.delete(listener);
      this.stops += 1;
    };
  }

  /**
   * 終了通知を同期に送る。
   *
   * @param localSessionId - 終了した生存セッションのローカル識別子。
   */
  emitEnded(localSessionId: string): void {
    for (const listener of [...this.listeners]) {
      listener(localSessionId);
    }
  }

  /**
   * 生存印を変える。
   *
   * @param localSessionId - 対象のローカル識別子。
   * @param alive - 生存していれば真。
   */
  setAlive(localSessionId: string, alive: boolean): void {
    this.entries = this.entries.map((entry) =>
      entry.localSessionId === localSessionId ? { ...entry, alive } : entry,
    );
  }
}

/** 合成 `alpha` の状態。計数だけを持つ。 */
export interface AlphaState {
  /** 計数値。 */
  readonly count: number;
}

/** 合成 `alpha` の操作口。計数の加算だけを持つ。 */
export interface AlphaOperations {
  /**
   * 計数に加える。
   *
   * @param delta - 加える値。
   * @returns 加算後の計数値。
   */
  add(delta: number): number;
}

/**
 * 検証用の `alpha` 個体。
 */
export class FakeAlphaInstance implements PluginInstance<AlphaState, AlphaOperations> {
  private count = 0;
  private attachedPort: string | null = null;
  private disposed = false;

  attach(portId: string, _session: AssignedSession): void {
    if (portId !== "main") {
      throw new RangeError("不明な接続口である。");
    }
    this.attachedPort = portId;
  }

  get attached(): boolean {
    return this.attachedPort !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getState(): AlphaState {
    return { count: this.count };
  }

  getOperations(): AlphaOperations {
    return {
      add: (delta: number) => {
        this.count += delta;
        return this.count;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** 合成 `beta` の状態。短い表示名だけを持つ。 */
export interface BetaState {
  /** 表示名。 */
  readonly label: string;
}

/** 合成 `beta` の操作口。表示名の書換えだけを持つ。 */
export interface BetaOperations {
  /**
   * 表示名を書き換える。
   *
   * @param next - 次の表示名。
   */
  rename(next: string): void;
}

/** 検証用の `beta` 個体。 */
export class FakeBetaInstance implements PluginInstance<BetaState, BetaOperations> {
  private label = "";
  private disposed = false;

  attach(portId: string, _session: AssignedSession): void {
    if (portId !== "main") {
      throw new RangeError("不明な接続口である。");
    }
  }

  getState(): BetaState {
    return { label: this.label };
  }

  getOperations(): BetaOperations {
    return {
      rename: (next: string) => {
        this.label = next;
      },
    };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** `alpha` の生成元。接続口 `main` で確実配送の双方向だけを受ける。 */
export const alphaDefinition: PluginDefinition<AlphaState, AlphaOperations> = {
  pluginId: "alpha",
  ports: [{ portId: "main", accepts: [RELIABLE_BIDI] }],
  create: () => new FakeAlphaInstance(),
};

/** `beta` の生成元。`alpha` と異なる状態・操作を持つ。 */
export const betaDefinition: PluginDefinition<BetaState, BetaOperations> = {
  pluginId: "beta",
  ports: [{ portId: "main", accepts: [RELIABLE_BIDI] }],
  create: () => new FakeBetaInstance(),
};

/**
 * 先着の未割当て候補を選ぶ方針を作る。
 *
 * @param maxInstances - 同時所有の上限。`null` は上限なし。
 * @returns 割当て方針。
 */
export function firstFitPolicy(maxInstances: number | null): PluginAssignmentPolicy {
  return {
    maxInstances,
    select: (input: {
      readonly request: PluginAssignmentRequest;
      readonly candidates: readonly PluginAssignmentCandidate[];
      readonly bindings: readonly PluginBindingInfo[];
    }) => {
      void input.bindings;
      const request = input.request;
      if (request.mode === "session") {
        const found = input.candidates.find(
          (candidate) => candidate.localSessionId === request.localSessionId,
        );
        if (found === undefined || !found.alive || found.assignment !== null) {
          throw new RangeError("指定した候補が使えない。");
        }
        return { localSessionId: found.localSessionId, portId: "main" };
      }
      const found = input.candidates.find(
        (candidate) => candidate.alive && candidate.assignment === null,
      );
      if (found === undefined) {
        throw new RangeError("割当て候補が無い。");
      }
      return { localSessionId: found.localSessionId, portId: "main" };
    },
  };
}

/**
 * 未割当て生存が一件だけのときに選ぶ方針を作る。複数・ゼロでは拒否する。
 *
 * @param maxInstances - 同時所有の上限。`null` は上限なし。
 * @returns 割当て方針。
 */
export function uniquePolicy(maxInstances: number | null): PluginAssignmentPolicy {
  return {
    maxInstances,
    select: (input: {
      readonly request: PluginAssignmentRequest;
      readonly candidates: readonly PluginAssignmentCandidate[];
      readonly bindings: readonly PluginBindingInfo[];
    }) => {
      void input.bindings;
      void input.request;
      const free = input.candidates.filter(
        (candidate) => candidate.alive && candidate.assignment === null,
      );
      if (free.length !== 1) {
        throw new RangeError("一意な割当て候補が無い。");
      }
      const only = free[0];
      if (only === undefined) {
        throw new RangeError("一意な割当て候補が無い。");
      }
      return { localSessionId: only.localSessionId, portId: "main" };
    },
  };
}

/**
 * `alpha` の管理記述子を作る。
 *
 * @param options - 割当て方針。
 * @returns 管理記述子。
 */
export function alphaDescriptor(options: {
  readonly assignment: PluginAssignmentPolicy;
}): GuiPluginManagementDescriptor<AlphaState, AlphaOperations> {
  return {
    kind: "alpha",
    definition: alphaDefinition,
    assignment: options.assignment,
  };
}

/**
 * `beta` の管理記述子を作る。
 *
 * @param options - 割当て方針。
 * @returns 管理記述子。
 */
export function betaDescriptor(options: {
  readonly assignment: PluginAssignmentPolicy;
}): GuiPluginManagementDescriptor<BetaState, BetaOperations> {
  return {
    kind: "beta",
    definition: betaDefinition,
    assignment: options.assignment,
  };
}

/** 検証用の組み立て。 */
export interface ManagerFixture {
  /** 偽 core。 */
  readonly core: FakeCore;
  /** 偽セッション。 */
  readonly sessions: FakeSessions;
  /** 変化通知の回数。 */
  readonly changed: { count: number; failNext: boolean };
  /** 問題報告の一覧。 */
  readonly issues: PluginManagerIssue[];
  /** 依存注入口。 */
  readonly dependencies: PluginInstanceManagerDependencies;
}

/**
 * 検証用の組み立てを作る。
 *
 * @param entries - 生存セッションの公開情報の初期値。
 * @returns 検証用の組み立て。
 */
export function setupFixture(entries: readonly PluginSessionMetadata[] = []): ManagerFixture {
  const core = new FakeCore();
  const sessions = new FakeSessions();
  sessions.entries = [...entries];
  const changed = { count: 0, failNext: false };
  const issues: PluginManagerIssue[] = [];
  const dependencies: PluginInstanceManagerDependencies = {
    core,
    sessions,
    onChanged: () => {
      if (changed.failNext) {
        changed.failNext = false;
        throw new Error("通知に失敗した。");
      }
      changed.count += 1;
    },
    onIssue: (issue) => {
      issues.push(issue);
    },
  };
  return { core, sessions, changed, issues, dependencies };
}
