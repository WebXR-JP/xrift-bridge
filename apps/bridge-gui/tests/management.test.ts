import { expect, test } from "vite-plus/test";
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import { selectNewer } from "bridge-gui-contract/management";

// テスト用の表示状態。検証対象は revision の採用規約のみである。
function snapshot(revision: number): ManagementSnapshot {
  return {
    revision,
    backend: "starting",
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
  };
}

test("初回は受信した表示状態を採用する", () => {
  expect(selectNewer(null, snapshot(0))).toEqual(snapshot(0));
});

test("新しい revision の表示状態を採用する", () => {
  const next = selectNewer(snapshot(1), snapshot(2));
  expect(next.revision).toBe(2);
});

test("同じ revision では現在の状態を保つ", () => {
  const current = snapshot(3);
  expect(selectNewer(current, snapshot(3))).toBe(current);
});

test("古い revision の応答では状態が戻らない", () => {
  const current = snapshot(3);
  expect(selectNewer(current, snapshot(1))).toBe(current);
});
