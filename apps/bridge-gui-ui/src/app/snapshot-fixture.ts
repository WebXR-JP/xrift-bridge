/**
 * 試験用の表示状態の組み立て。
 *
 * TestBed 試験で snapshot へ載せる表示状態を作る。比較コード本文・業務
 * payload・テキスト本文は含めない（件数・改訂番号のみ）。
 */
import type { ManagementSnapshot } from "bridge-gui-contract/management";

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
    plugins: { instances: [], assignments: [] },
    text: {
      localSessionId: null,
      instanceId: null,
      canSend: false,
      pendingId: null,
      lastResult: null,
      stats: { attempts: 0, acknowledged: 0, unknown: 0 },
    },
    pluginMounts: [],
    pluginMountFailures: [],
    ...overrides,
  };
}
