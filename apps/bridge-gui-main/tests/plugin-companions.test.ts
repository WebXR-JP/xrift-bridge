/**
 * companion 登録表と遷移規則の配布の検証。
 *
 * 遷移規則の直書きは持たず、backend が登録済み companion の解決済み
 * view パス集合から生成し、snapshot（`getSnapshot` と `stateChanged` の
 * 両方）で配布する。ここでは登録→snapshot の経路で固定し、同期漏れを
 * 検出する。共通コードに種別分岐は持たない。
 * 登録表は backend ごとに生成し、共有 singleton は持たない。
 * 登録表に載るのは解決済み companion と endpoint 工場の組だけである。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { buildPluginNavigationRules } from "bridge-gui-contract/plugin-instance";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  registerNoPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";

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
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  const kinds = backend.companionRegistry.list().map((entry) => entry.companion.kind);
  expect(kinds).toEqual(["text", "diagnostic", "udp"]);
});

test("backend ごとに登録表を作り共有しない", async () => {
  const deps = {
    registerPlugins: registerBundledPlugins,
    resolvePluginViewPath: resolveBundledPluginViewPath,
  };
  const first = await GuiBackend.create({ port: 0 }, deps);
  const second = await GuiBackend.create({ port: 0 }, deps);
  backends.push(first, second);
  expect(first.companionRegistry).not.toBe(second.companionRegistry);
  expect(first.companionRegistry.list().map((entry) => entry.companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
  expect(second.companionRegistry.list().map((entry) => entry.companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
});

test("snapshot の遷移規則は登録済み companion の解決済み view パスから作る", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  // 過剰許可（登録外の範囲規則）も不足（同期漏れ）も検出する。
  // 規則の全体一致で見て、包含だけでは見逃す余分な許可を落とさない。
  const viewPaths = backend.companionRegistry.list().map((entry) => entry.companion.viewPath);
  expect(backend.getSnapshot().pluginNavigationRules).toEqual(
    buildPluginNavigationRules(viewPaths),
  );
});

test("snapshot の遷移規則が登録済み子画面の読込み先を許可する", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  const rules = backend.getSnapshot().pluginNavigationRules;
  // 対象は backend が生成した登録表（同梱 companion）のみである。試験用の非同梱
  // companion（stubx など）は遷移規則に載せないため対象外とする。
  for (const entry of backend.companionRegistry.list()) {
    const sampleUrl = `${entry.companion.viewPath}#mount=plugin-${entry.companion.kind}-1`;
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
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
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
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  const registry = new PluginCompanionRegistry();
  registry.register(
    {
      kind: "stubx",
      label: "試験",
      viewEntry: "index.html",
      viewPath: "views://plugin-stubx/index.html",
    },
    () => {
      throw new Error("未使用");
    },
  );
  expect(registry.getCompanion("stubx")?.viewPath).toBe("views://plugin-stubx/index.html");
  // backend の表には載らず、同梱の三種別のままである。
  expect(registry.getCompanion("stubx")?.kind).toBe("stubx");
  expect(backend.companionRegistry.getCompanion("stubx")).toBeUndefined();
  expect(backend.companionRegistry.list().map((entry) => entry.companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
  // 形式外・重複の登録は拒否する。
  expect(() =>
    registry.register(
      {
        kind: "形式外",
        label: "試験",
        viewEntry: "index.html",
        viewPath: "views://plugin-stubx/index.html",
      },
      () => {
        throw new Error("未使用");
      },
    ),
  ).toThrowError(Error);
  const again = registry.getEntry("stubx");
  if (again === undefined) throw new Error("行が無い。");
  expect(() => registry.register(again.companion, again.createEndpoint)).toThrowError(Error);
});

test("解決済み companion と endpoint 工場の組だけを載せる", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  for (const entry of backend.companionRegistry.list()) {
    expect(entry.companion.viewPath.length).toBeGreaterThan(0);
    expect(typeof entry.createEndpoint).toBe("function");
  }
  // 文字列で配送先を選ぶ共有 dispatcher は持たない。
  const surface = backend.companionRegistry as unknown as Record<string, unknown>;
  expect(surface["dispatch"]).toBeUndefined();
  expect(surface["send"]).toBeUndefined();
});
