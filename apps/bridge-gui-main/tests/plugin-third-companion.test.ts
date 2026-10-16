/**
 * 第三の companion（text/diagnostic と異なる固有中継）の登録検証。
 *
 * 共通の対応付け・結線（coordinator・channel factory）に分岐を
 * 追加せず、登録表への登録だけで配置→結線→中継が通ることを
 * 確かめる。text/diagnostic と異なる要求名・イベント名・表示を持つ。
 * 試験用の登録表を使い、既定の共有表を汚さない。
 * 新 registrar 経路全体の検証は `third-plugin-registration.test.ts` が担い、
 * ここでは登録表直結の結線単位を固定する（役割分担であり、
 * 保証内容の重複削除ではない）。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import type { PluginRelayResult } from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
} from "bridge-gui-contract/plugin-instance";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import {
  PluginUiCoordinator,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  alphaDescriptor,
  firstFitPolicy,
  makeSession,
  setupFixture,
} from "./plugin-instance-manager-fakes.ts";

/** テスト専用 companion の種別トークン。既存種別と重ならない。 */
const MEMO_KIND = "memo";

/** テスト専用 companion の view パス。同梱しないため表に載せない。 */
const MEMO_VIEW_PATH = "views://plugin-memo/index.html";

/**
 * 静的登録の期待遷移規則。登録内容（memo の view パス）から導く。
 * main が照合する期待値と同じ作り方である。
 */
const EXPECTED_NAVIGATION_RULES = buildPluginNavigationRules([MEMO_VIEW_PATH]);

/** 検証用の偽子画面。 */
class FakeView implements PluginUiChildView {
  removed = false;
  loaded: string[] = [];
  constructor(
    readonly viewId: number,
    readonly hostWebviewId: number | undefined,
    readonly currentUrl: string | null,
    readonly renderer = "native",
    readonly sandbox = false,
    readonly preload: string | null = null,
    // 省略時は静的登録の期待規則と一致する正規値（実表現の配列）を載せる。
    readonly navigationRules: unknown = [...EXPECTED_NAVIGATION_RULES],
  ) {}
  loadPluginUrl(url: string): void {
    this.loaded.push(url);
  }
  removeView(): void {
    this.removed = true;
  }
}

/**
 * テスト専用のメモ endpoint 工場。text/diagnostic と異なる要求名
 * （`getMemoState`・`appendMemo`）とイベント名（`memoStateChanged`）を持つ。
 */
function createMemoEndpoint(
  ref: BoundPluginRef<unknown, unknown>,
  emission: PluginEmissionPort,
): PluginEndpoint {
  let disposed = false;
  return {
    async handleRequest(request): Promise<unknown> {
      if (disposed) {
        throw new Error("終了済みの endpoint である。");
      }
      if (request.method === "getMemoState") {
        const binding = ref.getBinding();
        return { instanceId: binding.instanceId, noteCount: 1 };
      }
      if (request.method === "appendMemo") {
        const params = request.params as { note: unknown };
        if (typeof params.note !== "string" || params.note.length === 0) {
          return { error: "note は空でない文字列であること。" };
        }
        emission.emit({ event: "memoStateChanged", payload: { noteCount: 2 } });
        return { count: 2 };
      }
      return { error: `未知の要求である: ${request.method}` };
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/** 検証用の組み立て。 */
function setupMemo(): {
  coordinator: PluginUiCoordinator;
  relays: Map<string, (request: unknown) => Promise<PluginRelayResult>>;
  pushes: Map<string, unknown[]>;
  instanceId: string;
  setView: (instanceId: string | null, viewGeneration: number) => void;
} {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  // `alpha` の所有を `memo` 種別の表示に流用する。到達は登録表の行だけを使う。
  const owned = manager.assign("alpha");
  const registry = new PluginCompanionRegistry();
  registry.register(
    { kind: "alpha", label: "合成", viewEntry: "index.html", viewPath: MEMO_VIEW_PATH },
    createMemoEndpoint,
  );
  const relays = new Map<string, (request: unknown) => Promise<PluginRelayResult>>();
  const pushes = new Map<string, unknown[]>();
  const factory: PluginUiChannelFactory = (_view, mountId, onRelay) => {
    relays.set(mountId, onRelay);
    const pushed: unknown[] = [];
    pushes.set(mountId, pushed);
    const channel: PluginUiChannel = {
      push: (event) => {
        pushed.push(event);
      },
    };
    return channel;
  };
  let view: { instanceId: string | null; viewGeneration: number } = {
    instanceId: null,
    viewGeneration: 0,
  };
  const coordinator = new PluginUiCoordinator(
    7,
    { notifyExternalChange: () => {} },
    factory,
    Date.now,
    registry,
    manager,
    () => ({ ...view }),
  );
  void MEMO_KIND;
  return {
    coordinator,
    relays,
    pushes,
    instanceId: owned.instanceId,
    setView: (instanceId: string | null, viewGeneration: number) => {
      view = { instanceId, viewGeneration };
    },
  };
}

test("登録だけで第三種別の配置・結線・中継が通る", async () => {
  const assembled = setupMemo();
  assembled.setView(assembled.instanceId, 1);
  expect(assembled.coordinator.syncNow()).toBe(true);
  const placements = assembled.coordinator.listPlacements();
  expect(placements).toHaveLength(1);
  const placement = placements[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.mountId).toBe("plugin-alpha-1");
  const view = new FakeView(11, 7, placement.initialUrl);
  expect(assembled.coordinator.handleTagCreated(view)).toBe(true);
  const relay = assembled.relays.get(placement.mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  // 第三種別の固有要求名で不透明中継が通る。
  const got = (await relay({ method: "getMemoState", params: {} })) as PluginRelayResult;
  expect(got.ok).toBe(true);
  expect(assembled.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
  const appended = (await relay({
    method: "appendMemo",
    params: { note: "メモ1" },
  })) as PluginRelayResult;
  expect(appended.ok).toBe(true);
  // 通知も同一マウントに素通しする。
  expect(assembled.pushes.get(placement.mountId)).toHaveLength(1);
});

test("第三種別の未知要求は値に載せ文字列選択の口は持たない", async () => {
  const assembled = setupMemo();
  assembled.setView(assembled.instanceId, 1);
  assembled.coordinator.syncNow();
  const placement = assembled.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  assembled.coordinator.handleTagCreated(new FakeView(11, 7, placement.initialUrl));
  const relay = assembled.relays.get(placement.mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  const unknown = (await relay({ method: "無い要求", params: {} })) as PluginRelayResult;
  expect(unknown.ok).toBe(true);
  const registry = new PluginCompanionRegistry();
  const surface = registry as unknown as Record<string, unknown>;
  expect(surface["dispatch"]).toBeUndefined();
  expect(surface["send"]).toBeUndefined();
  expect(buildPluginBlankUrl(placement.mountId)).toBe(placement.initialUrl);
});
