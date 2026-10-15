/**
 * 診断の GUI 登録単位（`./gui`）。
 *
 * 管理記述子・companion 宣言・endpoint 工場の組だけを持ち、子画面固有契約の
 * 定義は `gui-contract`、本体は `index` が持つ。ここでは再定義せず、
 * 公開 entry（`bridge-plugin-diagnostic/gui`）越しにホストの composition
 * root だけが参照する。
 *
 * endpoint は束縛個体に限定した参照口だけを使い、不透明な要求を処理する。
 * 要求名の反射呼出しはせず、未知 `method`・不正 `params` は不透明なエラー値
 * として返す（投げない）。表示用 DTO は本体の現在状態と束縛情報から組み立て、
 * 本体の状態購読で変化を追う。ポーリング・キュー・再配信・最新状態キャッシュ
 * は持たない。
 *
 * @packageDocumentation
 */
import { DIAGNOSTIC_PORT_ID, diagnosticPlugin } from "./index.ts";
import type { DiagnosticOperations, DiagnosticStats } from "./index.ts";
import { isDiagnosticSessionId } from "./contract.ts";
import type {
  BoundPluginRef,
  GuiPluginManagementDescriptor,
} from "bridge-gui-plugin-sdk/management";
import type {
  PluginCompanionDeclaration,
  PluginEmissionPort,
  PluginEndpoint,
} from "bridge-gui-plugin-sdk/companion";
import type { GuiPluginRegistration } from "bridge-gui-plugin-sdk/registration";
import type { PluginRelayRequest } from "bridge-gui-contract/plugin-instance";
import {
  DIAGNOSTIC_MOUNT_KIND,
  DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED,
  DIAGNOSTIC_RELAY_METHOD_GET_STATE,
  DIAGNOSTIC_VIEW_ENTRY,
  isDiagnosticGetStateParams,
  type DiagnosticInstanceView,
  type DiagnosticRelayError,
} from "./gui-contract.ts";

/**
 * 束縛個体の表示用 DTO を組み立てる。
 *
 * @param ref - ホストが選んだ一個体に限定した参照口。
 * @returns 子へ送る限定表示。改訂番号は本体の値を引き継ぐだけである。
 * @throws `RangeError` — 所有外・失効・現割当て不一致の場合（ホスト自身の照合）。
 */
function toDiagnosticView(
  ref: BoundPluginRef<DiagnosticStats, DiagnosticOperations>,
): DiagnosticInstanceView {
  const binding = ref.getBinding();
  const state = ref.readState();
  return {
    instanceId: binding.instanceId,
    pluginId: binding.pluginId,
    portId: binding.portId,
    localSessionId: binding.localSessionId,
    stats: {
      diagnosticEcho: state.diagnosticEcho,
      diagnosticPing: state.diagnosticPing,
    },
    revision: state.revision,
  };
}

/**
 * 診断の登録単位。管理記述子・companion 宣言・endpoint 工場の組である。
 *
 * 候補は生存・未割当て・reliable/bidirectional・診断の論理名
 * （`DIAGNOSTIC_SESSION_IDS` に含まれるもの）である。`mode:"session"` は適格候補から指定個体を選び、`mode:"auto"` は
 * 唯一候補のみ（先頭選択・一括割当てはしない）。監視は本体の状態購読
 * （`onStateChanged`）で行い、ポーリングは持たない。
 */
export const diagnosticGuiRegistration: GuiPluginRegistration<
  DiagnosticStats,
  DiagnosticOperations
> = {
  management: {
    kind: DIAGNOSTIC_MOUNT_KIND,
    definition: diagnosticPlugin,
    assignment: {
      maxInstances: null,
      select({ request, candidates }) {
        const eligible = candidates.filter(
          (candidate) =>
            candidate.alive &&
            candidate.assignment === null &&
            isDiagnosticSessionId(candidate.sessionId) &&
            candidate.capability.kind === "reliable" &&
            candidate.capability.direction === "bidirectional",
        );
        if (request.mode === "session") {
          const target = eligible.find(
            (candidate) => candidate.localSessionId === request.localSessionId,
          );
          if (target === undefined) {
            throw new RangeError("診断割当ての対象が無い。");
          }
          return { localSessionId: target.localSessionId, portId: DIAGNOSTIC_PORT_ID };
        }
        if (eligible.length === 0) {
          throw new RangeError("診断割当ての候補が無い。");
        }
        if (eligible.length > 1) {
          throw new RangeError("診断割当ての候補が複数ある。");
        }
        const target = eligible[0];
        if (target === undefined) {
          throw new RangeError("診断割当ての候補が無い。");
        }
        return { localSessionId: target.localSessionId, portId: DIAGNOSTIC_PORT_ID };
      },
    },
  } satisfies GuiPluginManagementDescriptor<DiagnosticStats, DiagnosticOperations>,
  companion: {
    kind: DIAGNOSTIC_MOUNT_KIND,
    label: "診断",
    viewEntry: DIAGNOSTIC_VIEW_ENTRY,
  } satisfies PluginCompanionDeclaration,
  createEndpoint(
    ref: BoundPluginRef<DiagnosticStats, DiagnosticOperations>,
    emission: PluginEmissionPort,
  ): PluginEndpoint {
    // ADR: 購読は本体の `onStateChanged` だけを使い、ポーリング・汎用監視機構は
    // 作らない。購読口は操作口（`withOperations`）経由で都度取り、本体側の失効
    // 照合に従う。raw operations は保存しない。
    const unsubscribe = ref.withOperations((operations) =>
      operations.onStateChanged(() => {
        let view: DiagnosticInstanceView;
        try {
          view = toDiagnosticView(ref);
        } catch {
          // 失効後の通知は送らない。子の破棄で本体は終了しない。
          return;
        }
        emission.emit({ event: DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED, payload: view });
      }),
    );
    let disposed = false;
    return {
      async handleRequest(request: PluginRelayRequest): Promise<unknown> {
        // ADR: 要求名の反射呼出し（`operations[method]` 等）はしない。未知の要求は
        // 投げず不透明なエラー値として返す。投げた例外は想定外の失敗として
        // 中継失敗に落とす（`RangeError` も束縛失効とは解釈しない）。
        if (request.method !== DIAGNOSTIC_RELAY_METHOD_GET_STATE) {
          const error: DiagnosticRelayError = {
            ok: false,
            code: "unknown-method",
            message: "未知の要求である。",
          };
          return error;
        }
        if (!isDiagnosticGetStateParams(request.params)) {
          const error: DiagnosticRelayError = {
            ok: false,
            code: "bad-params",
            message: "引数の形状が不正である。",
          };
          return error;
        }
        return toDiagnosticView(ref);
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        try {
          unsubscribe();
        } catch {
          // 購読解除の失敗は終了を止めない。
        }
      },
    };
  },
};
