/**
 * companion 登録表と遷移規則の同期の検証。
 *
 * 遷移規則（共有契約の `PLUGIN_NAVIGATION_RULES`）は companion の `viewPath`
 * とは別に存在するため、登録済み companion の表示先が規則に含まれることを
 * ここで固定し、同期漏れを検出する。共通コードに種別分岐は持たない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import {
  buildPluginNavigationRules,
  PLUGIN_NAVIGATION_RULES,
} from "bridge-gui-contract/plugin-instance";
import {
  getPluginCompanion,
  listPluginCompanions,
  PluginCompanionRegistry,
} from "../src/main/plugin-companions.ts";

test("既定の登録表は同梱の二種別を登録順に載せる", () => {
  const kinds = listPluginCompanions().map((companion) => companion.kind);
  expect(kinds).toEqual(["text", "diagnostic"]);
});

test("登録済み companion の view パスは遷移規則に含まれる", () => {
  // 対象は既定の共有表（同梱 companion）のみである。試験用の非同梱
  // companion（memo など）は遷移規則に載せないため対象外とする。
  for (const companion of listPluginCompanions()) {
    const sampleUrl = companion.buildViewUrl(`plugin-${companion.kind}-1`);
    // 遷移規則の意味での許可: 全面拒否（`^*`）と空ページ以外に、
    // 子画面 URL の接頭辞に一致する範囲規則があること。
    const allowed = PLUGIN_NAVIGATION_RULES.some(
      (rule) => rule !== "^*" && rule.endsWith("/*") && sampleUrl.startsWith(rule.slice(0, -1)),
    );
    expect(allowed).toBe(true);
  }
});

test("許可 scope 集合は登録済み同梱 companion の view パス集合と一致する", () => {
  // 過剰許可（登録外の範囲規則）も不足（同期漏れ）も検出する。
  // 規則の全体一致で見て、包含だけでは見逃す余分な許可を落とさない。
  const viewPaths = listPluginCompanions().map((companion) => companion.viewPath);
  expect(PLUGIN_NAVIGATION_RULES).toEqual(buildPluginNavigationRules(viewPaths));
});

test("試験用の登録表は既定の共有表を汚さない", () => {
  const registry = new PluginCompanionRegistry();
  registry.register({
    kind: "stubx",
    label: "試験",
    viewPath: "views://plugin-stubx/index.html",
    buildViewUrl: (mountId: string) => `views://plugin-stubx/index.html#mount=${mountId}`,
    listDesired: () => [],
    readView: () => {
      throw new RangeError("未使用");
    },
    toSnapshot: (view) => view,
    pushMessageName: "stubxStateChanged",
    buildRequestHandlers: () => ({}),
  });
  expect(registry.get("stubx")?.pushMessageName).toBe("stubxStateChanged");
  // 既定の共有表には載らず、同梱の二種別のままである。
  expect(getPluginCompanion("stubx")).toBeUndefined();
  expect(listPluginCompanions().map((companion) => companion.kind)).toEqual(["text", "diagnostic"]);
});
