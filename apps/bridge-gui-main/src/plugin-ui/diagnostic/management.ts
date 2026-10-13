/**
 * 診断 companion が所有する管理記述子。
 *
 * 生成元・割当て方針・監視方式・表示射影の宣言をここに束ね、汎用管理層
 * （`PluginInstanceManager`）がこれに従って駆動する。種別分岐は持たず、
 * 候補不足・曖昧の場合は `RangeError` で示す。固有操作は持たない。
 *
 * @packageDocumentation
 */
import { DIAGNOSTIC_PORT_ID, diagnosticPlugin, TEXT_SESSION_ID } from "bridge-app-core";
import type { DiagnosticStats } from "bridge-app-core";
import type { GuiPluginManagementDescriptor } from "bridge-gui-plugin-sdk/management";
import { DIAGNOSTIC_MOUNT_KIND } from "./contract.ts";
import type { DiagnosticInstanceView } from "./contract.ts";

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
