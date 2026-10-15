/**
 * UDP の GUI 登録口（`./gui`）。
 *
 * 管理記述子・companion 宣言・endpoint 工場の三つの組だけを持ち、子画面固有
 * 契約の定義は `gui-contract`、通信契約は `contract`、本体は `plugin` が持つ。
 * ここでは再定義せず、公開 entry（`bridge-plugin-udp/gui`）越しにホストの
 * composition root だけが参照する。
 *
 * endpoint 工場は引数の限定口（一個体に限定した参照口・その表示期間の子に
 * だけ送る口）だけを使い、対象識別子を引数に取る到達口・管理 backend・
 * 全個体一覧は持たない。子の破棄（`dispose()`）でプラグイン本体・Session・
 * UDP ソケットは終了しない。失効時は `onRevoked` でソケットを解放する
 * 既存挙動を本体が維持する。
 *
 * @packageDocumentation
 */
import { UDP_PORT_ID, udpPlugin } from "./plugin.ts";
import type { UdpPluginOperations, UdpPluginState, UdpStartParams } from "./plugin.ts";
import { UDP_SESSION_ID } from "./contract.ts";
import {
  UDP_MOUNT_KIND,
  UDP_RELAY_EVENT_STATE,
  UDP_RELAY_METHOD_GET_STATE,
  UDP_RELAY_METHOD_START,
  UDP_RELAY_METHOD_STOP,
  UDP_VIEW_ENTRY,
  isUdpStartRelayParams,
  type UdpCompanionSnapshot,
} from "./gui-contract.ts";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import type {
  PluginCompanionDeclaration,
  PluginEmissionPort,
  PluginEndpoint,
} from "bridge-gui-plugin-sdk/companion";
import type { GuiPluginRegistration } from "bridge-gui-plugin-sdk/registration";
import type { PluginRelayRequest } from "bridge-gui-contract/plugin-instance";

/**
 * 本体の状態と束縛の要約から表示用 DTO を組み立てる。
 *
 * 改訂番号は本体が所有する値を引き継ぐだけであり、ここでは進めない。
 *
 * @param state - 本体の現在状態の写し。
 * @param binding - ホストが選んだ個体の束縛情報。
 * @returns 子へ送る表示用 DTO。
 */
function toSnapshot(
  state: UdpPluginState,
  binding: {
    readonly instanceId: string;
    readonly localSessionId: string;
    readonly portId: string;
  },
): UdpCompanionSnapshot {
  return {
    revision: state.revision,
    instanceId: binding.instanceId,
    localSessionId: binding.localSessionId,
    portId: binding.portId,
    phase: state.phase,
    requestedBind: state.requestedBind,
    boundAddress: state.boundAddress,
    canStart: state.canStart,
    isRunning: state.isRunning,
    stats: state.stats,
    lastError: state.lastError,
  };
}

/**
 * UDP の GUI 登録単位。管理記述子・companion 宣言・endpoint 工場の組である。
 *
 * 候補は生存・未割当て・`sessionId===UDP_SESSION_ID`・reliable/bidirectional
 * である。`mode:"session"` は適格候補から指定個体を選び、`mode:"auto"` は
 * 唯一候補のみ（先頭選択・一括割当てはしない）。
 */
export const udpGuiRegistration: GuiPluginRegistration<UdpPluginState, UdpPluginOperations> = {
  management: {
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
  },
  companion: {
    kind: UDP_MOUNT_KIND,
    label: "UDP",
    viewEntry: UDP_VIEW_ENTRY,
  } satisfies PluginCompanionDeclaration,
  createEndpoint(
    ref: BoundPluginRef<UdpPluginState, UdpPluginOperations>,
    emission: PluginEmissionPort,
  ): PluginEndpoint {
    let disposed = false;
    // 高頻度通知（受信ごとの統計更新）を最新値へ集約するための標識であり、
    // 状態ポーリングではない。本体の `onStateChanged` を購読し、同一
    // マイクロタスク内の変化は一度の `readState()`・一度の `emit` に束ねる。
    let scheduled = false;
    const flush = (): void => {
      scheduled = false;
      if (disposed) return;
      // 失効後は参照口が `RangeError` を投げる。ここでは握りつぶし、
      // 失効の判定はホスト自身の照合に委ねる（投げ直して失効扱いにしない）。
      let snapshot: UdpCompanionSnapshot;
      try {
        snapshot = toSnapshot(ref.readState(), ref.getBinding());
      } catch {
        return;
      }
      emission.emit({ event: UDP_RELAY_EVENT_STATE, payload: snapshot });
    };
    const unsubscribe = ref.withOperations((operations) =>
      operations.onStateChanged(() => {
        if (disposed || scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
      }),
    );
    return {
      async handleRequest(request: PluginRelayRequest): Promise<unknown> {
        // 反射呼出し（`operations[method]` 等）はしない。閉じた三分岐だけを持つ。
        if (request.method === UDP_RELAY_METHOD_GET_STATE) {
          return toSnapshot(ref.readState(), ref.getBinding());
        }
        if (request.method === UDP_RELAY_METHOD_START) {
          if (!isUdpStartRelayParams(request.params)) {
            return {
              ok: false,
              reason: "invalid-config",
              message: "start の引数は {bind, allowNonLoopback} の組みであること。",
            };
          }
          // ADR: `as` を使う理由は、中継の不透明な params の外形をこの endpoint が
          // 固定するためである。根拠は、`isUdpStartRelayParams` で外形を確認した
          // ことである。引数の詳細検証は委譲先（本体の操作口）が行い、失敗は
          // 理由付きの結果で返す。
          const params = request.params as unknown as UdpStartParams;
          return ref.withOperations((operations) => operations.start(params));
        }
        if (request.method === UDP_RELAY_METHOD_STOP) {
          return ref.withOperations((operations) => operations.stop());
        }
        return {
          ok: false,
          reason: "unknown-method",
          message: `UDP の要求名が不明である: ${request.method}`,
        };
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        try {
          unsubscribe();
        } catch {
          // 購読解除の失敗は二重解放にしない（冪等）。
        }
      },
    };
  },
};
