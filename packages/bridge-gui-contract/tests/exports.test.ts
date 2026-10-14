import { expect, test } from "vite-plus/test";
import { selectNewer } from "bridge-gui-contract/management";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
  buildPluginViewUrl,
  parsePluginMountId,
  PLUGIN_BLANK_PATH,
  PLUGIN_INITIAL_FETCH_ATTEMPTS,
  PLUGIN_INITIAL_FETCH_RETRY_MS,
  PLUGIN_PENDING_TIMEOUT_MS,
  pluginMountKindOf,
  selectNewerInstanceSnapshot,
} from "bridge-gui-contract/plugin-instance";

// 公開 subpath の実行時表面を固定する。名前付き import 自体が存在の保証に
// なり（欠ければ収集時に落ちる）、本体では種類と規則の一致だけを
// 確かめる。型だけの輸出は型検査（`test:types` と利用者の `tsc`）で固定し、
// 個々の振る舞いは利用者側（bridge-gui-main の tests）が新境界経由で検証する。

test("management の公開値が関数として取り出せる", () => {
  expect(typeof selectNewer).toBe("function");
});

test("plugin-instance の公開表面が欠けておらず規則生成が公開される", () => {
  expect(typeof selectNewerInstanceSnapshot).toBe("function");
  expect(typeof buildPluginBlankUrl).toBe("function");
  expect(typeof buildPluginViewUrl).toBe("function");
  expect(typeof buildPluginNavigationRules).toBe("function");
  expect(typeof parsePluginMountId).toBe("function");
  expect(typeof pluginMountKindOf).toBe("function");
  expect(typeof PLUGIN_BLANK_PATH).toBe("string");
  expect(typeof PLUGIN_PENDING_TIMEOUT_MS).toBe("number");
  expect(typeof PLUGIN_INITIAL_FETCH_ATTEMPTS).toBe("number");
  expect(typeof PLUGIN_INITIAL_FETCH_RETRY_MS).toBe("number");
  // 遷移規則の直書き定数は持たず、登録由来の生成だけを公開する。
  // タグに載せる値は backend の snapshot 配布で受け取る。
  expect(
    buildPluginNavigationRules([
      "views://plugin-text/index.html",
      "views://plugin-diagnostic/index.html",
    ]),
  ).toEqual([
    "^*",
    "views://plugin-host/*",
    "views://plugin-text/*",
    "views://plugin-diagnostic/*",
  ]);
});
