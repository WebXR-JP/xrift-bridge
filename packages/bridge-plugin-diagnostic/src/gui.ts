/**
 * 診断の GUI companion の登録口（`./gui`）。
 *
 * 管理記述子と companion factory の対応付けだけを持ち、子画面固有契約の
 * 定義は `gui-contract`、本体は `index` が持つ。ここでは再定義せず、
 * 公開 entry（`bridge-plugin-diagnostic/gui`）越しにホストの composition
 * root だけが参照する。
 *
 * @packageDocumentation
 */
import { DIAGNOSTIC_PORT_ID, diagnosticPlugin } from "./index.ts";
import type { DiagnosticStats } from "./index.ts";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import type {
  GuiPluginAccess,
  GuiPluginManagementDescriptor,
} from "bridge-gui-plugin-sdk/management";
import type {
  CompanionRequestEnv,
  PluginCompanionDeclaration,
} from "bridge-gui-plugin-sdk/companion";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { DIAGNOSTIC_MOUNT_KIND, DIAGNOSTIC_VIEW_ENTRY } from "./gui-contract.ts";
import type { DiagnosticInstanceSnapshot, DiagnosticInstanceView } from "./gui-contract.ts";

/**
 * 診断統計の変化検出の間隔（ミリ秒）。
 *
 * 診断プラグインに状態購読が無いため、管理層が統計の指紋を比べて
 * 変化を検出する周期である。
 */
export const DEFAULT_DIAGNOSTIC_POLL_MS = 500;

/** 診断の公開する固有操作。診断は操作を持たない。 */
export type DiagnosticManagementOperations = Record<string, never>;

/**
 * 診断の管理記述子。`definition: diagnosticPlugin`、`maxInstances: null`。
 *
 * 候補は生存・未割当て・reliable/bidirectional・`sessionId!==TEXT_SESSION_ID`
 * である。`mode:"session"` は適格候補から指定個体を選び、`mode:"auto"` は
 * 唯一候補のみ（先頭選択・一括割当てはしない）。監視は周期照合（500ms、
 * 指紋は診断統計二項目のみ）で行う。
 */
export const diagnosticManagement: GuiPluginManagementDescriptor<
  DiagnosticStats,
  void,
  DiagnosticInstanceView,
  DiagnosticManagementOperations
> = {
  kind: DIAGNOSTIC_MOUNT_KIND,
  definition: diagnosticPlugin,
  assignment: {
    maxInstances: null,
    select({ request, candidates }) {
      const eligible = candidates.filter(
        (candidate) =>
          candidate.alive &&
          candidate.assignment === null &&
          candidate.sessionId !== TEXT_SESSION_ID &&
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
  observation: {
    mode: "poll",
    intervalMs: DEFAULT_DIAGNOSTIC_POLL_MS,
    fingerprint(state) {
      return `${state.diagnosticEcho}/${state.diagnosticPing}`;
    },
  },
  projectView({ binding, state }) {
    return {
      instanceId: binding.instanceId,
      pluginId: binding.pluginId,
      portId: binding.portId,
      localSessionId: binding.localSessionId,
      stats: state,
    };
  },
  buildOperations() {
    return {};
  },
};

/**
 * 診断 companion を組み立てる。`GuiPluginAccess` を capture する。
 *
 * 解決前の宣言（振る舞いと相対 entrypoint）だけを返し、解決済み view パス・
 * 子画面 URL の組み立ては持たない。composition が静的 manifest と照合して
 * 解決済みを付与し、登録表に載せる。
 *
 * @param access - 管理層が返す種別の公開参照口。
 * @returns 診断 companion の解決前の宣言。送信操作は持たない。
 */
export function createDiagnosticCompanion(
  access: GuiPluginAccess<DiagnosticInstanceView, DiagnosticManagementOperations>,
): PluginCompanionDeclaration {
  return {
    kind: DIAGNOSTIC_MOUNT_KIND,
    label: "診断",
    viewEntry: DIAGNOSTIC_VIEW_ENTRY,
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
      const typed = view as DiagnosticInstanceView;
      const snapshot: DiagnosticInstanceSnapshot = { ...typed, revision };
      return snapshot;
    },
    pushMessageName: "diagnosticStateChanged",
    buildRequestHandlers(mountId: string, env: CompanionRequestEnv) {
      return {
        getDiagnosticState: () => {
          const snapshot = env.readSnapshot(DIAGNOSTIC_MOUNT_KIND, mountId);
          // ADR: `as` を使う理由は上記と同様であり、対応付けが同一種別の
          // 記述子で読んだ表示を返すためである。
          const typed = snapshot as DiagnosticInstanceSnapshot;
          env.markReady(mountId);
          return typed;
        },
      };
    },
  };
}
