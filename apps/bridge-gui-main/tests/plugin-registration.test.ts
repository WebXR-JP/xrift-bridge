/**
 * プラグイン登録の集約（registrar 注入・composition root）の検証。
 *
 * backend が具象を知らず、注入された登録関数で管理記述子・companion 宣言・
 * endpoint 工場を登録すること、種別表が登録内容から生成されること、登録途中の
 * 失敗では部分登録を公開せず資源を回収することを確かめる。実サーバーの生成は
 * 空きポート自動選択で行い、待受の回収だけは番号再利用で確かめる。
 * 第三種別の追加可能性自体は `third-plugin-registration.test.ts` が担い、
 * ここでは空構成・同梱順・失敗時の回収を固定する（役割分担であり、
 * 保証内容の重複削除ではない）。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  registerNoPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import { textGuiRegistration } from "bridge-plugin-text/gui";
import { alphaDescriptor, firstFitPolicy } from "./plugin-instance-manager-fakes.ts";

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

/** 試験用の backend 依存口。同梱の選択と解決口を渡す。 */
function bundledDeps(): {
  registerPlugins: typeof registerBundledPlugins;
  resolvePluginViewPath: typeof resolveBundledPluginViewPath;
} {
  return {
    registerPlugins: registerBundledPlugins,
    resolvePluginViewPath: resolveBundledPluginViewPath,
  };
}

test("空構成では種別を持たず未知種別の割当てを拒否する", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerNoPlugins });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  expect(backend.startupError).toBeNull();
  expect(backend.companionRegistry.list()).toHaveLength(0);
  expect(backend.getSnapshot().plugins.kinds).toEqual([]);
  // 登録が無いため同梱種別も未知扱いである。
  expect(() => backend.assignPlugin({ pluginKind: "text" })).toThrowError(RangeError);
});

test("同梱登録は text→diagnostic→udp の順で種別表を作る", async () => {
  const backend = await GuiBackend.create({ port: 0 }, bundledDeps());
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  expect(backend.companionRegistry.list().map((entry) => entry.companion.kind)).toEqual([
    "text",
    "diagnostic",
    "udp",
  ]);
  // 種別表は composition root の別途列挙ではなく登録内容から生成される。
  expect(backend.getSnapshot().plugins.kinds).toEqual([
    { pluginKind: "text", pluginId: "text", label: "テキスト", maxInstances: 1 },
    { pluginKind: "diagnostic", pluginId: "diagnostic", label: "診断", maxInstances: null },
    { pluginKind: "udp", pluginId: "udp", label: "UDP", maxInstances: null },
  ]);
});

test("種別表は未知の登録内容から生成される", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: (registrar) => {
        registrar.registerPlugin({
          management: alphaDescriptor({ assignment: firstFitPolicy(2) }),
          companion: { kind: "alpha", label: "アルファ", viewEntry: "index.html" },
          createEndpoint: () => {
            throw new Error("未使用");
          },
        });
      },
      resolvePluginViewPath: () => "views://plugin-alpha/index.html",
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  // backend が種別を知らなくても表示名・上限まで登録内容で決まる。
  expect(backend.getSnapshot().plugins.kinds).toEqual([
    { pluginKind: "alpha", pluginId: "alpha", label: "アルファ", maxInstances: 2 },
  ]);
  expect(backend.companionRegistry.getCompanion("alpha")?.label).toBe("アルファ");
  // 管理層にも汎用経路で載っている（候補が無いため割当ては拒否される）。
  expect(() => backend.assignPlugin({ pluginKind: "alpha" })).toThrowError(RangeError);
  expect(() => backend.assignPlugin({ pluginKind: "text" })).toThrowError(RangeError);
});

test("同じ登録関数を使い回しても backend ごとに独立する", async () => {
  const first = await GuiBackend.create({ port: 0 }, bundledDeps());
  const second = await GuiBackend.create({ port: 0 }, bundledDeps());
  backends.push(first, second);
  expect(first.getSnapshot().backend).toBe("ready");
  expect(second.getSnapshot().backend).toBe("ready");
  expect(first.companionRegistry).not.toBe(second.companionRegistry);
  // 登録行も backend ごとに作り直され、共有しない。
  const firstText = first.companionRegistry.getEntry("text");
  const secondText = second.companionRegistry.getEntry("text");
  expect(firstText).toBeDefined();
  expect(secondText).toBeDefined();
  expect(firstText).not.toBe(secondText);
  expect(first.getSnapshot().plugins.kinds).toEqual(second.getSnapshot().plugins.kinds);
});

test("登録途中の失敗では部分登録を公開せず待受を回収する", async () => {
  // 空きポートの番号だけを使い捨ての backend で得る。
  const probe = await GuiBackend.create({ port: 0 }, bundledDeps());
  backends.push(probe);
  const endpoint = probe.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const port = new URL(endpoint.url).port;
  await probe.close();

  const failing = await GuiBackend.create(
    { port: Number(port) },
    {
      registerPlugins: (registrar) => {
        registerBundledPlugins(registrar);
        throw new Error("登録の失敗");
      },
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(failing);
  expect(failing.getSnapshot().backend).toBe("failed");
  expect(failing.startupError).not.toBeNull();
  // 先に登録した text も公開されず、種別表も空のままである。
  expect(failing.companionRegistry.getCompanion("text")).toBeUndefined();
  expect(failing.companionRegistry.list()).toHaveLength(0);
  expect(failing.getSnapshot().plugins.kinds).toEqual([]);
  await failing.close();
  // 待受が残っていれば番号の再利用は失敗する。回収の証拠である。
  const reopened = await GuiBackend.create({ port: Number(port) }, bundledDeps());
  backends.push(reopened);
  expect(reopened.getSnapshot().backend).toBe("ready");
  expect(new URL(reopened.getSnapshot().endpoint?.url ?? "").port).toBe(port);
});

test("種別の不一致では失敗状態になり何も公開しない", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: (registrar) => {
        registrar.registerPlugin({
          management: textGuiRegistration.management,
          companion: { ...textGuiRegistration.companion, kind: "other" },
          createEndpoint: textGuiRegistration.createEndpoint,
        });
      },
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("failed");
  expect(backend.startupError).not.toBeNull();
  expect(backend.companionRegistry.list()).toHaveLength(0);
  expect(backend.getSnapshot().plugins.kinds).toEqual([]);
  await backend.close();
});

test("重複登録では失敗状態になり何も公開しない", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: (registrar) => {
        registerBundledPlugins(registrar);
        registerBundledPlugins(registrar);
      },
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("failed");
  expect(backend.startupError).not.toBeNull();
  expect(backend.companionRegistry.list()).toHaveLength(0);
  expect(backend.getSnapshot().plugins.kinds).toEqual([]);
  await backend.close();
});

test("解決口が無ければ companion 宣言のある登録を拒否する", async () => {
  const backend = await GuiBackend.create({ port: 0 }, { registerPlugins: registerBundledPlugins });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("failed");
  expect(backend.startupError).not.toBeNull();
  expect(backend.companionRegistry.list()).toHaveLength(0);
  await backend.close();
});
