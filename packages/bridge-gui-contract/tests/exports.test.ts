import { expect, test } from "vite-plus/test";
import { selectNewer } from "bridge-gui-contract/management";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
  buildPluginViewUrl,
  firstResponseOf,
  isPluginViewRequest,
  isRelayEventShape,
  isRelayRequestShape,
  parsePluginMountId,
  PLUGIN_BLANK_PATH,
  PLUGIN_PENDING_TIMEOUT_MS,
  pluginMountKindOf,
} from "bridge-gui-contract/plugin-instance";

// 公開 subpath の実行時表面を固定する。名前付き import 自体が存在の保証に
// なり（欠ければ収集時に落ちる）、本体では種類と規則の一致だけを
// 確かめる。型だけの輸出は型検査（`test:types` と利用者の `tsc`）で固定し、
// 個々の振る舞いは利用者側（bridge-gui-main の tests）が新境界経由で検証する。

test("management の公開値が関数として取り出せる", () => {
  expect(typeof selectNewer).toBe("function");
});

test("plugin-instance の公開表面が欠けておらず規則生成が公開される", () => {
  expect(typeof buildPluginBlankUrl).toBe("function");
  expect(typeof buildPluginViewUrl).toBe("function");
  expect(typeof buildPluginNavigationRules).toBe("function");
  expect(typeof parsePluginMountId).toBe("function");
  expect(typeof pluginMountKindOf).toBe("function");
  expect(typeof isRelayRequestShape).toBe("function");
  expect(typeof isRelayEventShape).toBe("function");
  expect(typeof isPluginViewRequest).toBe("function");
  expect(typeof firstResponseOf).toBe("function");
  expect(typeof PLUGIN_BLANK_PATH).toBe("string");
  expect(typeof PLUGIN_PENDING_TIMEOUT_MS).toBe("number");
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

test("中継の外形判定は内容に立ち入らず外形だけを見る", () => {
  expect(isRelayRequestShape({ method: "getState", params: { a: 1 } })).toBe(true);
  expect(isRelayRequestShape({ method: "getState", params: undefined })).toBe(true);
  expect(isRelayRequestShape({ method: "", params: null })).toBe(false);
  expect(isRelayRequestShape({ method: 1, params: null })).toBe(false);
  expect(isRelayRequestShape({ method: "getState" })).toBe(false);
  expect(isRelayRequestShape(null)).toBe(false);
  expect(isRelayEventShape({ event: "changed", payload: [1, 2] })).toBe(true);
  expect(isRelayEventShape({ event: "", payload: null })).toBe(false);
  expect(isRelayEventShape({ event: "changed" })).toBe(false);
  expect(isRelayEventShape("changed")).toBe(false);
});

test("表示要求の外形判定は基準世代と対象の形だけを見る", () => {
  expect(isPluginViewRequest({ instanceId: "i1", baseViewGeneration: 0 })).toBe(true);
  expect(isPluginViewRequest({ instanceId: null, baseViewGeneration: 3 })).toBe(true);
  expect(isPluginViewRequest({ instanceId: "", baseViewGeneration: 0 })).toBe(false);
  expect(isPluginViewRequest({ instanceId: "i1", baseViewGeneration: -1 })).toBe(false);
  expect(isPluginViewRequest({ instanceId: "i1", baseViewGeneration: 1.5 })).toBe(false);
  expect(isPluginViewRequest({ instanceId: "i1" })).toBe(false);
  expect(isPluginViewRequest({ instanceId: "i1", viewGeneration: 0 })).toBe(false);
  expect(isPluginViewRequest(null)).toBe(false);
});

test("初期応答の状態は応答・同世代失敗・待ちを区別する", () => {
  const base = {
    mountId: "plugin-text-1",
    kind: "text",
    initialUrl: "views://plugin-host/blank.html#mount=plugin-text-1",
    phase: "bound" as const,
    viewGeneration: 2,
    pluginResponded: true,
    instanceId: "i1",
    localSessionId: "s1",
    portId: "text",
  };
  expect(firstResponseOf(base, [])).toBe("answered");
  const waiting = { ...base, pluginResponded: false };
  expect(firstResponseOf(waiting, [])).toBe("waiting");
  // 同世代の失敗表示がある場合は失敗であり、古い世代では待ちのままである。
  expect(
    firstResponseOf(waiting, [
      {
        kind: "text",
        reason: "期限超過",
        instanceId: "i1",
        localSessionId: "s1",
        viewGeneration: 2,
      },
    ]),
  ).toBe("failed");
  expect(
    firstResponseOf(waiting, [
      {
        kind: "text",
        reason: "期限超過",
        instanceId: "i1",
        localSessionId: "s1",
        viewGeneration: 1,
      },
    ]),
  ).toBe("waiting");
});
