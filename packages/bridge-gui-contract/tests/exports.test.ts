import { expect, test } from "vite-plus/test";
import { selectNewer } from "bridge-gui-contract/management";
import {
  buildPluginBlankUrl,
  buildPluginDiagnosticUrl,
  buildPluginTextUrl,
  parsePluginMountId,
  PLUGIN_BLANK_PATH,
  PLUGIN_DIAGNOSTIC_VIEW_PATH,
  PLUGIN_INITIAL_FETCH_ATTEMPTS,
  PLUGIN_INITIAL_FETCH_RETRY_MS,
  PLUGIN_NAVIGATION_RULES,
  PLUGIN_NAVIGATION_RULES_ATTRIBUTE,
  PLUGIN_PENDING_TIMEOUT_MS,
  pluginMountKindOf,
  PLUGIN_TEXT_VIEW_PATH,
  selectNewerInstanceSnapshot,
  TEXT_SEND_REQUEST_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";
import {
  buildBlankUrl,
  buildSpikeUrl,
  parseMountId,
  SPIKE_BLANK_PATH,
  SPIKE_NAVIGATION_RULES,
  SPIKE_NAVIGATION_RULES_ATTRIBUTE,
  SPIKE_VIEW_PATH,
} from "bridge-gui-contract/plugin-spike";

// 公開 subpath の実行時表面を固定する。名前付き import 自体が存在の保証に
// なり（欠ければ収集時に落ちる）、本体では種類と規則・属性値の一致だけを
// 確かめる。型だけの輸出は型検査（`test:types` と利用者の `tsc`）で固定し、
// 個々の振る舞いは利用者側（bridge-gui の tests）が新境界経由で検証する。

test("management の公開値が関数として取り出せる", () => {
  expect(typeof selectNewer).toBe("function");
});

test("plugin-instance の公開表面が欠けておらず規則と属性値が一致する", () => {
  expect(typeof selectNewerInstanceSnapshot).toBe("function");
  expect(typeof buildPluginBlankUrl).toBe("function");
  expect(typeof buildPluginTextUrl).toBe("function");
  expect(typeof buildPluginDiagnosticUrl).toBe("function");
  expect(typeof parsePluginMountId).toBe("function");
  expect(typeof pluginMountKindOf).toBe("function");
  expect(typeof PLUGIN_BLANK_PATH).toBe("string");
  expect(typeof PLUGIN_TEXT_VIEW_PATH).toBe("string");
  expect(typeof PLUGIN_DIAGNOSTIC_VIEW_PATH).toBe("string");
  expect(typeof PLUGIN_NAVIGATION_RULES_ATTRIBUTE).toBe("string");
  expect(typeof TEXT_SEND_REQUEST_TIMEOUT_MS).toBe("number");
  expect(typeof PLUGIN_PENDING_TIMEOUT_MS).toBe("number");
  expect(typeof PLUGIN_INITIAL_FETCH_ATTEMPTS).toBe("number");
  expect(typeof PLUGIN_INITIAL_FETCH_RETRY_MS).toBe("number");
  // タグに載せる属性値は規則の直列化と一致する（不一致では子画面の遷移許可がずれる）。
  expect(JSON.parse(PLUGIN_NAVIGATION_RULES_ATTRIBUTE)).toEqual([...PLUGIN_NAVIGATION_RULES]);
});

test("plugin-spike の公開表面が欠けておらず規則と属性値が一致する", () => {
  expect(typeof buildBlankUrl).toBe("function");
  expect(typeof buildSpikeUrl).toBe("function");
  expect(typeof parseMountId).toBe("function");
  expect(typeof SPIKE_BLANK_PATH).toBe("string");
  expect(typeof SPIKE_VIEW_PATH).toBe("string");
  expect(typeof SPIKE_NAVIGATION_RULES_ATTRIBUTE).toBe("string");
  // タグに載せる属性値は規則の直列化と一致する（不一致では子画面の遷移許可がずれる）。
  expect(JSON.parse(SPIKE_NAVIGATION_RULES_ATTRIBUTE)).toEqual([...SPIKE_NAVIGATION_RULES]);
});
