/**
 * プラグイン基盤（インスタンス管理・割当て・失効）。
 *
 * `BridgeServer` の管理境界（生存セッションの一覧・取得・管理通知）を受け取り、
 * プラグイン定義からのインスタンス生成、接続口の適合判定、割当て・解除、
 * 失効処理を担う。GUI ライブラリは参照しない。診断などデータ内容の解釈は
 * 持たず、適合は輸送上の `kind`・`direction` の一致だけで判定する。
 *
 * 割当ては一対一（一つのセッションに一つの割当て、一つの接続口に一つの
 * セッション）とする。解除・インスタンス削除・終了は、操作口の失効と購読
 * 解除を先に行ってから対象 Session を中断する。Session の終了で割当てと
 * 操作口を失効させるが、インスタンス自体は自動削除しない。
 *
 * 未割当ての `reliable` セッションにデータが届いた場合は、理由付きで
 * そのセッションを中断する（基盤の責務）。`latest` の記録はサーバー側の
 * 既存機能のままとし、ここでは触らない。
 *
 * @packageDocumentation
 */
import type {
  BridgeServer,
  BridgeSessionInfo,
  LocalSessionId,
  ManagementEvent,
  ServerSession,
} from "bridge-server";
import { wrapServerSession, type RevocableAssignedSession } from "./assigned-session.ts";
import {
  capabilityEquals,
  type PluginDefinition,
  type PluginInstance,
  type PluginInstanceHandle,
  type SessionCapability,
} from "./plugin.ts";

/**
 * 割当て（ローカルのセッション識別子からインスタンス識別子と接続口識別子への対応）。
 *
 * 再接続・同名セッションへの自動継承はしない。
 */
export interface AssignmentInfo {
  /** 割り当てた生存セッションのローカル識別子。 */
  readonly localSessionId: LocalSessionId;
  /** 割当て先インスタンスの識別子。 */
  readonly instanceId: string;
  /** 割当て先接続口の識別子。 */
  readonly portId: string;
}

/** プラグイン基盤の操作口。 */
export interface BridgeAppCore {
  /**
   * プラグイン定義から新しいインスタンスを生成する。
   *
   * @param definition - 生成元のプラグイン定義。
   * @returns 生成したインスタンスへの参照。
   * @throws `RangeError` — 基盤終了済みの場合。
   */
  createInstance<S>(definition: PluginDefinition<S>): PluginInstanceHandle<S>;
  /**
   * 生存セッションをインスタンスの接続口に割り当てる。
   *
   * 接続口の適合・一対一を検査し、割当てを確定してから `attach` を同期で
   * 呼ぶ。`attach` が失敗した場合は失効・解除・中断してから例外を投げ直す。
   *
   * @param localSessionId - 割り当てる生存セッションのローカル識別子。
   * @param instanceId - 割当て先インスタンスの識別子。
   * @param portId - 割当て先接続口の識別子。
   * @throws `RangeError` — 不明 ID・不適合・二重割当て・終了済みの場合。
   */
  assign(localSessionId: LocalSessionId, instanceId: string, portId: string): void;
  /**
   * 割当てを外す。操作口の失効と購読解除を先に行ってから対象 Session を中断する。
   *
   * @param localSessionId - 外す割当てのローカル識別子。
   * @throws `RangeError` — 不明な割当て・終了済みの場合。
   */
  unassign(localSessionId: LocalSessionId): void;
  /**
   * インスタンスを削除する。配下の割当てはすべて失効・中断してから破棄する。
   *
   * @param instanceId - 削除するインスタンスの識別子。
   * @throws `RangeError` — 不明なインスタンス・終了済みの場合。
   */
  removeInstance(instanceId: string): void;
  /**
   * 現在の割当て一覧の写し。
   *
   * @returns 割当て情報の配列。
   */
  listAssignments(): readonly AssignmentInfo[];
  /**
   * 基盤を終了する。全割当ての失効・中断、全インスタンスの破棄、
   * 管理通知の購読解除を行う。冪等である。
   */
  close(): void;
}

/** `createBridgeAppCore` が使うサーバー管理境界。 */
export type BridgeServerPort = Pick<
  BridgeServer,
  "listSessions" | "getSession" | "onManagementEvent"
>;

/** インスタンスの内部記録。 */
interface InstanceRecord {
  readonly definition: PluginDefinition<unknown>;
  readonly instance: PluginInstance<unknown>;
}

/** 割当ての内部記録。 */
interface AssignmentRecord {
  readonly localSessionId: LocalSessionId;
  readonly instanceId: string;
  readonly portId: string;
  readonly wrapper: RevocableAssignedSession;
  readonly raw: ServerSession;
}

/**
 * プラグイン基盤を生成する。
 *
 * 生成時に管理通知の購読と既存セッションの初期走査を行い、以後は
 * 開始・終了通知で追随する。
 *
 * @param server - サーバーの管理境界（一覧・取得・管理通知）。
 * @returns プラグイン基盤の操作口。
 */
export function createBridgeAppCore(server: BridgeServerPort): BridgeAppCore {
  let closed = false;
  let nextInstanceSeq = 1;
  const instances = new Map<string, InstanceRecord>();
  const assignments = new Map<LocalSessionId, AssignmentRecord>();
  // ADR: 接続口の一対一は `instanceId` と `portId` の組で数える。`portId` 単独では
  // 別インスタンスの同名接続口と衝突するため、合成キーで保持する。
  const portUse = new Map<string, LocalSessionId>();
  const watcherUnsubs = new Map<LocalSessionId, () => void>();

  /**
   * 未割当て reliable の監視を外す。
   *
   * @param localSessionId - 監視を外すセッションのローカル識別子。
   */
  function unwatch(localSessionId: LocalSessionId): void {
    const unsubscribe = watcherUnsubs.get(localSessionId);
    if (unsubscribe === undefined) return;
    watcherUnsubs.delete(localSessionId);
    try {
      unsubscribe();
    } catch {
      // 購読解除の失敗は監視終了を止めない。
    }
  }

  /**
   * 未割当ての reliable セッションを見張る。
   *
   * 割当て済みなら何もせず、未割当てのままデータが届いたら理由付きで
   * そのセッションを中断する。割当ての有無は配送時点で判定する。
   *
   * @param info - 見張る生存セッションの公開情報。
   */
  function watchUnassignedReliable(info: BridgeSessionInfo): void {
    if (info.kind !== "reliable") return;
    if (watcherUnsubs.has(info.localSessionId)) return;
    const raw = server.getSession(info.localSessionId);
    if (raw === undefined || raw.kind !== "reliable") return;
    const localSessionId = info.localSessionId;
    const unsubscribe = raw.onMessage(() => {
      if (closed) return;
      if (assignments.has(localSessionId)) return;
      // ADR: GUI 操作待ちの無制限保留や黙った破棄はしない。当該 Session のみ
      // 中断し、他 Session と Connection は維持する（中断は Session 単位）。
      try {
        raw.abort(new Error("未割当ての reliable セッションにデータが届いたため中断する。"));
      } catch {
        // 中断の失敗は無視する。
      }
    });
    watcherUnsubs.set(localSessionId, unsubscribe);
  }

  /**
   * 割当て記録を外して操作口を失効させる（Session の中断はしない）。
   *
   * Session 終了時の後始末用であり、既にない場合は何もしない。
   *
   * @param localSessionId - 外す割当てのローカル識別子。
   */
  function revokeAssignmentOnly(localSessionId: LocalSessionId): void {
    const record = assignments.get(localSessionId);
    if (record === undefined) return;
    assignments.delete(localSessionId);
    portUse.delete(portKey(record.instanceId, record.portId));
    record.wrapper.revoke();
  }

  /**
   * 管理通知を処理する。購読者の例外は隔離する。
   *
   * @param event - サーバーの管理通知。
   */
  function handleManagementEvent(event: ManagementEvent): void {
    if (closed) return;
    try {
      if (event.kind === "session-started") {
        watchUnassignedReliable(event.session);
      } else if (event.kind === "session-ended") {
        // ADR: 終了した Session は中断せず、割当てと操作口の失効だけを行う。
        // インスタンス自体は自動削除しない。
        unwatch(event.session.localSessionId);
        revokeAssignmentOnly(event.session.localSessionId);
      }
    } catch {
      // 内部処理の失敗でサーバーの通知配送を壊さない。
    }
  }

  const managementUnsub = server.onManagementEvent(handleManagementEvent);
  // ADR: 購読前の既存セッションは一覧で初期走査する。以後の増減は通知で追随し、
  // 識別子で重複を除く（監視の二重登録は `watcherUnsubs` で防ぐ）。
  for (const info of server.listSessions()) {
    watchUnassignedReliable(info);
  }

  return {
    createInstance<S>(definition: PluginDefinition<S>): PluginInstanceHandle<S> {
      if (closed) throw new RangeError("基盤は終了済みである。");
      const instanceId = `instance-${nextInstanceSeq++}`;
      const instance = definition.create();
      instances.set(instanceId, { definition, instance });
      return {
        instanceId,
        pluginId: definition.pluginId,
        getState: () => instance.getState(),
      };
    },

    assign(localSessionId: LocalSessionId, instanceId: string, portId: string): void {
      if (closed) throw new RangeError("基盤は終了済みである。");
      const record = instances.get(instanceId);
      if (record === undefined) throw new RangeError(`不明なインスタンスである: ${instanceId}`);
      const port = record.definition.ports.find((candidate) => candidate.portId === portId);
      if (port === undefined) throw new RangeError(`不明な接続口である: ${portId}`);
      const raw = server.getSession(localSessionId);
      if (raw === undefined || !raw.isAlive) {
        throw new RangeError(`不明または終了済みのセッションである: ${localSessionId}`);
      }
      // ADR: 型で絞り込めない生の組合せは値で合法化し、想定外は `RangeError` にする。
      const rawKind: string = raw.kind;
      const rawDirection: string = raw.direction;
      let capability: SessionCapability;
      if (rawKind === "reliable" && rawDirection === "bidirectional") {
        capability = { kind: "reliable", direction: "bidirectional" };
      } else if (rawKind === "latest" && rawDirection === "to_server") {
        capability = { kind: "latest", direction: "to_server" };
      } else if (rawKind === "latest" && rawDirection === "to_client") {
        capability = { kind: "latest", direction: "to_client" };
      } else {
        throw new RangeError("合法な組合せではないセッションである。");
      }
      const accepted = port.accepts.some((candidate) => capabilityEquals(candidate, capability));
      if (!accepted) throw new RangeError("接続口の適合に合わないセッションである。");
      if (assignments.has(localSessionId)) {
        throw new RangeError(`既に割り当て済みのセッションである: ${localSessionId}`);
      }
      const key = portKey(instanceId, portId);
      if (portUse.has(key)) throw new RangeError(`既に割当て済みの接続口である: ${portId}`);
      const info = server
        .listSessions()
        .find((candidate) => candidate.localSessionId === localSessionId);
      if (info === undefined)
        throw new RangeError(`公開情報のないセッションである: ${localSessionId}`);
      const wrapper = wrapServerSession(raw, info);
      const assignment: AssignmentRecord = {
        localSessionId,
        instanceId,
        portId,
        wrapper,
        raw,
      };
      assignments.set(localSessionId, assignment);
      portUse.set(key, localSessionId);
      try {
        // ADR: `attach` は同期で確定する。割当て記録を先に置くことで、失敗時は
        // 失効・解除・中断を一括で行える。
        record.instance.attach(portId, wrapper.session);
      } catch (error) {
        assignments.delete(localSessionId);
        portUse.delete(key);
        wrapper.revoke();
        try {
          raw.abort(new Error("割当ての確定に失敗したため Session を中断する。"));
        } catch {
          // 中断の失敗は無視する。
        }
        throw error;
      }
    },

    unassign(localSessionId: LocalSessionId): void {
      if (closed) throw new RangeError("基盤は終了済みである。");
      const assignment = assignments.get(localSessionId);
      if (assignment === undefined) throw new RangeError(`不明な割当てである: ${localSessionId}`);
      // ADR: 操作口の失効と購読解除を先に行ってから対象 Session を中断する。
      // 失効後の配送スナップショットから購読者を呼ばない。
      assignments.delete(localSessionId);
      portUse.delete(portKey(assignment.instanceId, assignment.portId));
      assignment.wrapper.revoke();
      try {
        assignment.raw.abort(new Error("割当てを解除したため Session を中断する。"));
      } catch {
        // 中断の失敗は無視する。
      }
    },

    removeInstance(instanceId: string): void {
      if (closed) throw new RangeError("基盤は終了済みである。");
      const record = instances.get(instanceId);
      if (record === undefined) throw new RangeError(`不明なインスタンスである: ${instanceId}`);
      // ADR: 配下の割当てはすべて失効・中断してから本体を破棄する。
      for (const assignment of [...assignments.values()]) {
        if (assignment.instanceId !== instanceId) continue;
        assignments.delete(assignment.localSessionId);
        portUse.delete(portKey(assignment.instanceId, assignment.portId));
        assignment.wrapper.revoke();
        try {
          assignment.raw.abort(new Error("インスタンスを削除したため Session を中断する。"));
        } catch {
          // 中断の失敗は無視する。
        }
      }
      instances.delete(instanceId);
      record.instance.dispose();
    },

    listAssignments(): readonly AssignmentInfo[] {
      return [...assignments.values()].map((assignment) => ({
        localSessionId: assignment.localSessionId,
        instanceId: assignment.instanceId,
        portId: assignment.portId,
      }));
    },

    close(): void {
      if (closed) return;
      closed = true;
      try {
        managementUnsub();
      } catch {
        // 購読解除の失敗は終了を止めない。
      }
      for (const localSessionId of [...watcherUnsubs.keys()]) {
        unwatch(localSessionId);
      }
      for (const assignment of [...assignments.values()]) {
        assignments.delete(assignment.localSessionId);
        portUse.delete(portKey(assignment.instanceId, assignment.portId));
        assignment.wrapper.revoke();
        try {
          assignment.raw.abort(new Error("基盤を終了したため Session を中断する。"));
        } catch {
          // 中断の失敗は無視する。
        }
      }
      for (const instanceId of [...instances.keys()]) {
        const record = instances.get(instanceId);
        instances.delete(instanceId);
        try {
          record?.instance.dispose();
        } catch {
          // ADR: 終了時の破棄失敗は他の破棄を止めない。
        }
      }
    },
  };
}

/**
 * 接続口の一対一を数える合成キーを作る。
 *
 * @param instanceId - インスタンスの識別子。
 * @param portId - 接続口の識別子。
 * @returns 割当て表のキー。
 */
function portKey(instanceId: string, portId: string): string {
  return `${instanceId}\u0000${portId}`;
}
