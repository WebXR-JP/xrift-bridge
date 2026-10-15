/**
 * UDP の GUI companion の登録口（`./gui`）。
 *
 * 管理記述子と companion factory の対応付けだけを持ち、子画面固有契約の
 * 定義は `gui-contract`、通信契約は `contract`、本体は `plugin` が持つ。
 * ここでは再定義せず、公開 entry（`bridge-plugin-udp/gui`）越しに
 * ホストの composition root だけが参照する。
 *
 * @packageDocumentation
 */
import { UDP_PORT_ID, udpPlugin } from "./plugin.ts";
import type {
  UdpControlResult,
  UdpPluginOperations,
  UdpPluginState,
  UdpStartParams,
} from "./plugin.ts";
import { UDP_SESSION_ID } from "./contract.ts";
import type {
  GuiPluginAccess,
  GuiPluginManagementDescriptor,
  PluginOperationAccess,
} from "bridge-gui-plugin-sdk/management";
import type {
  CompanionRequestEnv,
  PluginCompanionDeclaration,
} from "bridge-gui-plugin-sdk/companion";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { UDP_MOUNT_KIND, UDP_VIEW_ENTRY } from "./gui-contract.ts";
import type { UdpInstanceSnapshot, UdpInstanceView } from "./gui-contract.ts";

/**
 * UDP の公開する固有操作。
 *
 * raw operations を保存せず、利用の都度限定口を通す。
 */
export interface UdpManagementOperations {
  /**
   * 束縛個体の UDP 受信を開始する。
   *
   * @param instanceId - 操作対象の個体識別子。
   * @param params - bind 設定と非 loopback 確認（詳細検証はプラグインが行う）。
   * @returns 成功または理由付きの失敗。
   * @throws `RangeError` — 不明・失効・現割当て不一致の場合（同期的）。
   */
  startUdp(instanceId: string, params: unknown): Promise<UdpControlResult>;
  /**
   * 束縛個体の UDP 受信を停止する。
   *
   * @param instanceId - 操作対象の個体識別子。
   * @returns 成功または理由付きの失敗。
   * @throws `RangeError` — 不明・失効・現割当て不一致の場合（同期的）。
   */
  stopUdp(instanceId: string): Promise<UdpControlResult>;
}

/**
 * UDP の管理記述子。`definition: udpPlugin`、`maxInstances: null`。
 *
 * 候補は生存・未割当て・`sessionId===UDP_SESSION_ID`・reliable/bidirectional
 * である。`mode:"session"` は適格候補から指定個体を選び、`mode:"auto"` は
 * 唯一候補のみ（先頭選択・一括割当てはしない）。監視は周期照合（500ms、
 * 指紋は段階・bind・統計）で行う（状態購読は操作の有無に関わらず持たない）。
 */
export const udpManagement: GuiPluginManagementDescriptor<
  UdpPluginState,
  UdpPluginOperations,
  UdpInstanceView,
  UdpManagementOperations
> = {
  kind: UDP_MOUNT_KIND,
  definition: udpPlugin,
  assignment: {
    maxInstances: null,
    select({ request, candidates }) {
      const eligible = candidates.filter(
        (candidate) =>
          candidate.alive &&
          candidate.assignment === null &&
          candidate.sessionId === UDP_SESSION_ID &&
          candidate.capability.kind === "reliable" &&
          candidate.capability.direction === "bidirectional",
      );
      if (request.mode === "session") {
        const target = eligible.find(
          (candidate) => candidate.localSessionId === request.localSessionId,
        );
        if (target === undefined) {
          throw new RangeError("UDP割当ての対象が無い。");
        }
        return { localSessionId: target.localSessionId, portId: UDP_PORT_ID };
      }
      if (eligible.length === 0) {
        throw new RangeError("UDP割当ての候補が無い。");
      }
      if (eligible.length > 1) {
        throw new RangeError("UDP割当ての候補が複数ある。");
      }
      const target = eligible[0];
      if (target === undefined) {
        throw new RangeError("UDP割当ての候補が無い。");
      }
      return { localSessionId: target.localSessionId, portId: UDP_PORT_ID };
    },
  },
  observation: {
    mode: "poll",
    intervalMs: 500,
    fingerprint(state) {
      // ADR: 指紋は子画面の表示内容（段階・bind・統計・異常）だけから作る。
      // 構築順を固定した配列の JSON であり、順序の揺れで誤検出しない。
      return JSON.stringify([
        state.phase,
        state.requestedBind,
        state.boundAddress,
        state.stats,
        state.lastError,
        state.canStart,
        state.isRunning,
      ]);
    },
  },
  projectView({ binding, state }) {
    return {
      instanceId: binding.instanceId,
      pluginId: binding.pluginId,
      portId: binding.portId,
      localSessionId: binding.localSessionId,
      phase: state.phase,
      requestedBind: state.requestedBind,
      boundAddress: state.boundAddress,
      canStart: state.canStart,
      isRunning: state.isRunning,
      stats: state.stats,
      lastError: state.lastError,
    };
  },
  buildOperations(access: PluginOperationAccess<UdpPluginOperations>): UdpManagementOperations {
    return {
      startUdp(instanceId: string, params: unknown): Promise<UdpControlResult> {
        // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
        // 根拠は、要求表の `startUdp` が bind 設定だけを渡すことである。引数の
        // 詳細検証は委譲先（固有操作）が行い、失敗は理由付きの結果で返す。
        const body = params as UdpStartParams;
        return access.withOperations(instanceId, (operations) => operations.start(body));
      },
      stopUdp(instanceId: string): Promise<UdpControlResult> {
        return access.withOperations(instanceId, (operations) => operations.stop());
      },
    };
  },
};

/**
 * プレーンオブジェクトか判定する。
 *
 * @param value - 判定する値。
 * @returns 配列でないオブジェクトであれば真。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * UDP companion を組み立てる。`GuiPluginAccess` を capture する。
 *
 * 解決前の宣言（振る舞いと相対 entrypoint）だけを返し、解決済み view パス・
 * 子画面 URL の組み立ては持たない。composition が静的 manifest と照合して
 * 解決済みを付与し、登録表に載せる。
 *
 * @param access - 管理層が返す種別の公開参照口。
 * @returns UDP companion の解決前の宣言。
 */
export function createUdpCompanion(
  access: GuiPluginAccess<UdpInstanceView, UdpManagementOperations>,
): PluginCompanionDeclaration {
  return {
    kind: UDP_MOUNT_KIND,
    label: "UDP",
    viewEntry: UDP_VIEW_ENTRY,
    listDesired() {
      return access.listBindings().map((binding) => ({
        instanceId: binding.instanceId,
        localSessionId: binding.localSessionId,
        portId: binding.portId,
      }));
    },
    readView(instanceId: string): InstanceBaseView {
      return access.readView(instanceId);
    },
    toSnapshot(view: InstanceBaseView, revision: number): unknown {
      // ADR: `as` を使う理由は、同じ companion の `readView` が作った表示に
      // 改訂番号だけを付けるためである。根拠は、対応付けが同一種別の記述子で
      // 読み・付番を対にすることである。
      const typed = view as UdpInstanceView;
      const snapshot: UdpInstanceSnapshot = { ...typed, revision };
      return snapshot;
    },
    send(instanceId: string, params: unknown): Promise<unknown> {
      // ADR: 汎用の任意 payload ディスパッチ表は作らず、閉じた操作名
      // （`start`・`stop`）の二分岐だけを持つ。未知値は `RangeError` で
      // 拒否し、引数の詳細検証は委譲先（固有操作）が行う。
      if (!isRecord(params)) {
        throw new RangeError("UDP の操作引数は {action, ...} の組みであること。");
      }
      const action = (params as { action?: unknown }).action;
      if (action === "start") {
        // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
        // 根拠は、`startUdp` 要求表が bind 引数だけを包むことである。
        const body = (params as { params?: unknown }).params;
        return access.operations.startUdp(instanceId, body);
      }
      if (action === "stop") {
        return access.operations.stopUdp(instanceId);
      }
      throw new RangeError("UDP の操作名が不明である。");
    },
    pushMessageName: "udpStateChanged",
    buildRequestHandlers(mountId: string, env: CompanionRequestEnv) {
      return {
        getUdpState: () => {
          const snapshot = env.readSnapshot(UDP_MOUNT_KIND, mountId);
          // ADR: `as` を使う理由は上記と同様であり、対応付けが同一種別の
          // 記述子で読んだ表示を返すためである。
          const typed = snapshot as UdpInstanceSnapshot;
          env.markReady(mountId);
          return typed;
        },
        startUdp: (params: UdpStartParams) => {
          const result = env.send(UDP_MOUNT_KIND, mountId, { action: "start", params });
          // ADR: `as` を使う理由は上記と同様であり、委譲先の解決型を保つためである。
          return result as Promise<UdpControlResult>;
        },
        stopUdp: () => {
          const result = env.send(UDP_MOUNT_KIND, mountId, { action: "stop" });
          // ADR: `as` を使う理由は上記と同様であり、委譲先の解決型を保つためである。
          return result as Promise<UdpControlResult>;
        },
      };
    },
  };
}
