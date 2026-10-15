/**
 * companion 登録表と遷移規則の配布の検証。
 *
 * 遷移規則の直書きは持たず、backend が登録済み companion の解決済み
 * view パス集合から生成し、snapshot（`getSnapshot` と `stateChanged` の
 * 両方）で配布する。ここでは登録→snapshot の経路で固定し、同期漏れを
 * 検出する。共通コードに種別分岐は持たない。
 * 登録表は backend ごとに生成し、共有 singleton は持たない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { buildPluginNavigationRules } from "bridge-gui-contract/plugin-instance";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import { GuiBackend } from "../src/main/backend.ts";
import { registerBundledPlugins, registerNoPlugins } from "../src/composition/bundled-plugins.ts";

const backends: GuiBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

test("backend ごとの登録表は同梱の三種別を登録順に載せる", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  const kinds = backend.companionRegistry.list().map((companion) => companion.kind);
  expect(kinds).toEqual(["text", "diagnostic", "udp"]);
});

test("backend ごとに登録表を作り共有しない", async () => {
  const first = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  const second = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(first, second);
  expect(first.companionRegistry).not.toBe(second.companionRegistry);
  expect(first.companionRegistry.list().map((companion) => companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
  expect(second.companionRegistry.list().map((companion) => companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
});

test("snapshot の遷移規則は登録済み companion の解決済み view パスから作る", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  // 過剰許可（登録外の範囲規則）も不足（同期漏れ）も検出する。
  // 規則の全体一致で見て、包含だけでは見逃す余分な許可を落とさない。
  const viewPaths = backend.companionRegistry.list().map((companion) => companion.viewPath);
  expect(backend.getSnapshot().pluginNavigationRules).toEqual(
    buildPluginNavigationRules(viewPaths),
  );
});

test("snapshot の遷移規則が登録済み子画面の読込み先を許可する", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  const rules = backend.getSnapshot().pluginNavigationRules;
  // 対象は backend が生成した登録表（同梱 companion）のみである。試験用の非同梱
  // companion（stubx など）は遷移規則に載せないため対象外とする。
  for (const companion of backend.companionRegistry.list()) {
    const sampleUrl = `${companion.viewPath}#mount=plugin-${companion.kind}-1`;
    // 遷移規則の意味での許可: 全面拒否（`^*`）と空ページ以外に、
    // 子画面 URL の接頭辞に一致する範囲規則があること。
    const allowed = rules.some(
      (rule) => rule !== "^*" && rule.endsWith("/*") && sampleUrl.startsWith(rule.slice(0, -1)),
    );
    expect(allowed).toBe(true);
  }
});

test("空構成の snapshot の遷移規則は基底だけを持つ", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerNoPlugins });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  expect(backend.getSnapshot().pluginNavigationRules).toEqual(buildPluginNavigationRules([]));
});

test("状態通知でも同じ遷移規則を配布する", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  const seen: Array<readonly string[]> = [];
  const unsubscribe = backend.onStateChanged(({ snapshot }) => {
    seen.push(snapshot.pluginNavigationRules);
  });
  try {
    backend.notifyExternalChange();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  } finally {
    unsubscribe();
  }
  // `getSnapshot` と `stateChanged` の両方で同じ規則が配布される。
  expect(seen.length).toBeGreaterThan(0);
  for (const rules of seen) {
    expect([...rules]).toEqual([...backend.getSnapshot().pluginNavigationRules]);
  }
});

test("試験用の登録表は backend の表を汚さない", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  const registry = new PluginCompanionRegistry();
  registry.register({
    kind: "stubx",
    label: "試験",
    viewPath: "views://plugin-stubx/index.html",
    listDesired: () => [],
    readView: () => {
      throw new RangeError("未使用");
    },
    toSnapshot: (view) => view,
    pushMessageName: "stubxStateChanged",
    buildRequestHandlers: () => ({}),
  });
  expect(registry.get("stubx")?.pushMessageName).toBe("stubxStateChanged");
  // backend の表には載らず、同梱の三種別のままである。
  expect(backend.companionRegistry.get("stubx")).toBeUndefined();
  expect(backend.companionRegistry.list().map((companion) => companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
  // 形式外・重複の登録は拒否する。
  expect(() =>
    registry.register({
      kind: "形式外",
      label: "試験",
      viewPath: "views://plugin-stubx/index.html",
      listDesired: () => [],
      readView: () => {
        throw new RangeError("未使用");
      },
      toSnapshot: (view) => view,
      pushMessageName: "stubxStateChanged",
      buildRequestHandlers: () => ({}),
    }),
  ).toThrowError(Error);
  expect(() => registry.register(registry.get("stubx")!)).toThrowError(Error);
});
