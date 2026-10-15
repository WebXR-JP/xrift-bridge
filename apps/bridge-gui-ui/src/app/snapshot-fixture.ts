/**
 * 試験用の表示状態の組み立て。
 *
 * TestBed 試験で snapshot へ載せる表示状態を作る。比較コード本文・業務
 * payload・テキスト本文は含めない（件数・改訂番号のみ）。
 */
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import { buildPluginNavigationRules } from "bridge-gui-contract/plugin-instance";

/**
 * 試験用の表示状態を作る。
 *
 * @param overrides - 既定値（改訂番号 1・受付停止中・空一覧）への上書き。
 * @returns 試験用の表示状態。
 */
export function makeSnapshot(overrides?: Partial<ManagementSnapshot>): ManagementSnapshot {
  return {
    revision: 1,
    backend: "ready",
    endpoint: null,
    admission: { accepting: false },
    pending: [],
    connections: [],
    sessions: [],
    plugins: { kinds: [], instances: [], assignments: [] },
    pluginMounts: [],
    pluginMountFailures: [],
    pluginView: { instanceId: null, viewGeneration: 0 },
    pluginNavigationRules: buildPluginNavigationRules([
      "views://plugin-text/index.html",
      "views://plugin-diagnostic/index.html",
    ]),
    ...overrides,
  };
}
