/**
 * 実プラグイン子画面の表示要求駆動の対応付け・中継・回収の検証。
 *
 * 偽の子画面・偽チャネル・偽 manager で対応付けの振る舞いだけを確かめ、
 * Electrobun の SDK 呼び出しは適合層に隔離したまま触らない。
 * 表示要求への追随、生成照合、不透明中継と最初の正常応答、期限、失効・失敗時の
 * 回収、失敗の局所化と再試行、残存なしを保証する。本文・応答値は記録に残さない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import type { PluginRelayEvent, PluginRelayResult } from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
  buildPluginViewUrl,
  parsePluginMountId,
  pluginMountKindOf,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import {
  PluginUiCoordinator,
  type PluginRelayHandler,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  alphaDescriptor,
  firstFitPolicy,
  makeSession,
  setupFixture,
} from "./plugin-instance-manager-fakes.ts";

/** 検証用の偽子画面。破棄と読込みの事実だけを残す。 */
class FakeView implements PluginUiChildView {
  removed = false;
  loaded: string[] = [];
  loadFails = false;
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
    if (this.loadFails) {
      throw new Error("読込み失敗");
    }
    this.loaded.push(url);
  }
  removeView(): void {
    this.removed = true;
  }
}

/** 検証用の偽 endpoint。要求名 `ping` に不透明値で応答する。 */
class FakeEndpoint implements PluginEndpoint {
  disposed = false;
  disposeCalls = 0;
  constructor(
    private readonly ref: BoundPluginRef<unknown, unknown>,
    private readonly emission: PluginEmissionPort,
    private readonly onRequest?: (method: string) => void,
  ) {}
  async handleRequest(request: { method: string; params: unknown }): Promise<unknown> {
    if (this.disposed) {
      throw new Error("終了済みの endpoint である。");
    }
    this.onRequest?.(request.method);
    if (request.method === "ping") {
      // 所有段階・現割当ての照合は参照口が行う。
      this.ref.getBinding();
      return { pong: true };
    }
    if (request.method === "fail-business") {
      return { error: "業務の失敗である。" };
    }
    if (request.method === "throw-unexpected") {
      throw new Error("想定外の失敗である。");
    }
    return { error: `未知の要求である: ${request.method}` };
  }
  notify(payload: unknown): void {
    this.emission.emit({ event: "state-changed", payload });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeCalls += 1;
  }
}

/**
 * 静的登録の期待遷移規則。`setup` の登録内容（alpha の view パス）から導く。
 * main が照合する期待値と同じ作り方である。
 */
const EXPECTED_NAVIGATION_RULES = buildPluginNavigationRules(["views://plugin-alpha/index.html"]);

/** 検証用の組み立て。 */
interface MountFixture {
  coordinator: PluginUiCoordinator;
  manager: PluginInstanceManager;
  notified: { count: number };
  pushes: Map<string, PluginRelayEvent[]>;
  relays: Map<string, PluginRelayHandler>;
  endpoints: Map<string, FakeEndpoint>;
  setNow: (value: number) => void;
  setView: (instanceId: string | null, viewGeneration: number) => void;
  instanceId: string;
}

/** 検証用の対応付けを作る。表示要求は差し替え可能である。 */
function setup(): MountFixture {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  const binding = manager.assign("alpha");
  const registry = new PluginCompanionRegistry();
  const endpoints = new Map<string, FakeEndpoint>();
  registry.register(
    {
      kind: "alpha",
      label: "合成",
      viewEntry: "index.html",
      viewPath: "views://plugin-alpha/index.html",
    },
    (ref, emission) => {
      const endpoint = new FakeEndpoint(ref, emission);
      // 束縛個体ごとに最新を残す。表示期間ごとの作り直しで置き換わる。
      endpoints.set(binding.instanceId, endpoint);
      return endpoint;
    },
  );
  const notified = { count: 0 };
  const pushes = new Map<string, PluginRelayEvent[]>();
  const relays = new Map<string, PluginRelayHandler>();
  const factory: PluginUiChannelFactory = (_view, mountId, onRelay) => {
    relays.set(mountId, onRelay);
    const pushed: PluginRelayEvent[] = [];
    pushes.set(mountId, pushed);
    const channel: PluginUiChannel = {
      push: (event) => {
        pushed.push(event);
      },
    };
    return channel;
  };
  let nowMs = 0;
  let view: { instanceId: string | null; viewGeneration: number } = {
    instanceId: null,
    viewGeneration: 0,
  };
  const coordinator = new PluginUiCoordinator(
    7,
    { notifyExternalChange: () => void (notified.count += 1) },
    factory,
    () => nowMs,
    registry,
    manager,
    () => ({ ...view }),
  );
  return {
    coordinator,
    manager,
    notified,
    pushes,
    relays,
    endpoints,
    setNow: (value: number) => {
      nowMs = value;
    },
    setView: (instanceId: string | null, viewGeneration: number) => {
      view = { instanceId, viewGeneration };
    },
    instanceId: binding.instanceId,
  };
}

/** 配置を1件作り、タグ生成で結線する。 */
function placeAndBind(fixture: MountFixture, generation = 1): string {
  fixture.setView(fixture.instanceId, generation);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const placements = fixture.coordinator.listPlacements();
  expect(placements).toHaveLength(1);
  const placement = placements[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.viewGeneration).toBe(generation);
  expect(placement.pluginResponded).toBe(false);
  const view = new FakeView(11, 7, placement.initialUrl);
  expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
  expect(placement.mountId).toBe(fixture.coordinator.listPlacements()[0]?.mountId);
  return placement.mountId;
}

test("実プラグインの識別子は往復し他名前空間と混ざらない", () => {
  const url = buildPluginViewUrl("views://plugin-alpha/index.html", "plugin-alpha-3");
  expect(parsePluginMountId(url)).toBe("plugin-alpha-3");
  expect(pluginMountKindOf("plugin-alpha-3")).toBe("alpha");
  expect(parsePluginMountId(buildPluginBlankUrl("plugin-alpha-3"))).toBe("plugin-alpha-3");
  expect(parsePluginMountId("views://plugin-host/blank.html#mount=spike-1")).toBeNull();
  expect(parsePluginMountId(null)).toBeNull();
  expect(pluginMountKindOf("spike-1")).toBeNull();
  expect(parsePluginMountId("views://plugin-host/blank.html#mount=plugin-unknown-1")).toBe(
    "plugin-unknown-1",
  );
  expect(pluginMountKindOf("plugin-unknown-1")).toBe("unknown");
});

test("表示要求が無ければ配置を作らない", () => {
  const fixture = setup();
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listPlacements()).toHaveLength(0);
});

test("表示要求で配置を作りタグ生成で結線する", () => {
  const fixture = setup();
  fixture.setView(fixture.instanceId, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(1);
  expect(fixture.notified.count).toBeGreaterThan(0);
  const placements = fixture.coordinator.listPlacements();
  const placement = placements[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.mountId).toBe("plugin-alpha-1");
  expect(placement.kind).toBe("alpha");
  expect(placement.initialUrl).toBe(buildPluginBlankUrl("plugin-alpha-1"));
  expect(placement.phase).toBe("pending");
  expect(placement.instanceId).toBe(fixture.instanceId);
  expect(placement.localSessionId).toBe("local-1");
  // 変化が無ければ通知を重ねない。
  const notified = fixture.notified.count;
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.notified.count).toBe(notified);
  // タグ生成で結線する。
  const view = new FakeView(11, 7, placement.initialUrl);
  expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
  expect(view.loaded).toEqual([
    buildPluginViewUrl("views://plugin-alpha/index.html", placement.mountId),
  ]);
  expect(view.removed).toBe(false);
  expect(fixture.coordinator.listPlacements()[0]?.phase).toBe("bound");
});

test("親違いと他名前空間の生成に触らない", () => {
  const fixture = setup();
  const foreign = new FakeView(11, 99, buildPluginBlankUrl("plugin-alpha-1"));
  expect(fixture.coordinator.handleTagCreated(foreign)).toBe(false);
  expect(foreign.removed).toBe(false);
  const spike = new FakeView(12, 7, "views://plugin-host/blank.html#mount=spike-1");
  expect(fixture.coordinator.handleTagCreated(spike)).toBe(false);
  expect(spike.removed).toBe(false);
  expect(fixture.coordinator.size).toBe(0);
});

test("中継要求を endpoint へ素通しし最初の正常応答で応答済みにする", async () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture);
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  // 外形破損は内容検査ではなく中継失敗に落とす。
  const bad = (await relay({ method: "", params: {} })) as PluginRelayResult;
  expect(bad.ok).toBe(false);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(false);
  // 業務エラーは不透明値として正常応答に載る。
  const business = (await relay({ method: "fail-business", params: {} })) as PluginRelayResult;
  expect(business.ok).toBe(true);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
});

test("子からの初回要求到達と最初の正常応答を区別する", async () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture);
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  // 外形破損の到達では応答済みにしない。
  await relay({ method: "", params: {} });
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(false);
  await relay({ method: "ping", params: {} });
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
});

test("同一表示期間の snapshot 更新では再生成しない", () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture);
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.listPlacements()[0]?.mountId).toBe(mountId);
});

test("期限超過を失敗表示に回し再配置しない", async () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture);
  expect(fixture.coordinator.size).toBe(1);
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  const failures = fixture.coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.kind).toBe("alpha");
  expect(failures[0]?.instanceId).toBe(fixture.instanceId);
  expect(failures[0]?.viewGeneration).toBe(1);
  expect(failures[0]?.reason).toContain("時間内に完了しませんでした");
  // 現表示要求が残っていても明示の再試行まで再配置しない。
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  // endpoint は終了し、旧子への応答は付け替えない。
  const endpoint = fixture.endpoints.get(fixture.instanceId);
  expect(endpoint?.disposed).toBe(true);
  void mountId;
});

test("失敗後に同一個体の新世代で成功すると旧失敗は剪定される", async () => {
  // 旧世代の失敗を残すと、成功表示の後もタブ警告が残り続け、失敗表示が
  // 世代ごとに増える。新しい表示期間の採用時に旧世代分を剪定する。
  const fixture = setup();
  placeAndBind(fixture, 1);
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  fixture.coordinator.syncNow();
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  // 同一個体の新しい表示期間では旧世代の失敗を残さない。
  const mountId = placeAndBind(fixture, 2);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  await relay({ method: "ping", params: {} });
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
});

test("新世代でも失敗した場合は旧世代を残さず最新のみ保つ", () => {
  // 失敗が世代をまたいで積み上がらないこと（個体ごとに最新のみ）。
  const fixture = setup();
  placeAndBind(fixture, 1);
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  fixture.coordinator.syncNow();
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  placeAndBind(fixture, 2);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  fixture.setNow(2 * (PLUGIN_PENDING_TIMEOUT_MS + 1));
  fixture.coordinator.syncNow();
  const failures = fixture.coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.instanceId).toBe(fixture.instanceId);
  expect(failures[0]?.viewGeneration).toBe(2);
});

test("最初の正常応答があれば期限超過で回収しない", async () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture);
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  await relay({ method: "ping", params: {} });
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.size).toBe(1);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
});

test("個体限定の再試行は世代を維持して作り直す", async () => {
  const fixture = setup();
  placeAndBind(fixture, 1);
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  fixture.coordinator.syncNow();
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.retryFailed(fixture.instanceId)).toEqual({ ok: true });
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  expect(fixture.coordinator.size).toBe(1);
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  // 識別子は使い回さず、世代は維持する。
  expect(placement.mountId).toBe("plugin-alpha-2");
  expect(placement.viewGeneration).toBe(1);
});

test("未知の個体の再試行は例外にせず何も変えない", () => {
  const fixture = setup();
  placeAndBind(fixture, 1);
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  fixture.coordinator.syncNow();
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  const before = fixture.coordinator.listPlacements().map((placement) => placement.mountId);
  expect(fixture.coordinator.retryFailed("instance-unknown")).toEqual({ ok: true });
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.listPlacements().map((placement) => placement.mountId)).toEqual(
    before,
  );
  expect(fixture.coordinator.retryFailed("")).toEqual({ ok: true });
  expect(fixture.coordinator.retryFailed(null)).toEqual({ ok: true });
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
});

test("無し要求で破棄する", () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture, 1);
  const endpoint = fixture.endpoints.get(fixture.instanceId);
  fixture.setView(null, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  // 通常の終了は失敗表示に回さない。
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  expect(endpoint?.disposed).toBe(true);
  void mountId;
});

test("世代の進行で旧子破棄・新子生成する", () => {
  const fixture = setup();
  const first = placeAndBind(fixture, 1);
  fixture.setView(fixture.instanceId, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const placements = fixture.coordinator.listPlacements();
  expect(placements).toHaveLength(1);
  expect(placements[0]?.mountId).not.toBe(first);
  expect(placements[0]?.viewGeneration).toBe(2);
  expect(placements[0]?.phase).toBe("pending");
});

test("束縛の失効時は表示中の子も破棄する", () => {
  const fixture = setup();
  placeAndBind(fixture, 1);
  fixture.manager.unassign("alpha", fixture.instanceId);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  // 失効の破棄は失敗表示に回さない。
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
});

test("失効後の要求は中継失敗に落とす", async () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture, 1);
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  fixture.manager.unassign("alpha", fixture.instanceId);
  const result = (await relay({ method: "ping", params: {} })) as PluginRelayResult;
  expect(result.ok).toBe(false);
  if (result.ok === false) {
    expect(result.error.code).toBe("unmounted");
  }
});

test("通知は同一マウント生存時のみ素通しする", async () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture, 1);
  const endpoint = fixture.endpoints.get(fixture.instanceId);
  if (endpoint === undefined) throw new Error("endpoint が無い。");
  endpoint.notify({ count: 1 });
  expect(fixture.pushes.get(mountId)).toHaveLength(1);
  // 破棄後は届けない。
  fixture.setView(null, 2);
  fixture.coordinator.syncNow();
  endpoint.notify({ count: 2 });
  expect(fixture.pushes.get(mountId)).toHaveLength(1);
});

test("結線の失敗をそのマウントに局所化する", () => {
  const fixture = setup();
  fixture.setView(fixture.instanceId, 1);
  fixture.coordinator.syncNow();
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  view.loadFails = true;
  expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  expect(view.removed).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
});

test("全破棄で購読・表示の残存を残さない", () => {
  const fixture = setup();
  const mountId = placeAndBind(fixture, 1);
  const endpoint = fixture.endpoints.get(fixture.instanceId);
  expect(fixture.coordinator.resetAll("試験")).toEqual({ ok: true });
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listPlacements()).toHaveLength(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  expect(endpoint?.disposed).toBe(true);
  void mountId;
});

test("退役後の遅延生成を回収する", () => {
  const fixture = setup();
  fixture.setView(fixture.instanceId, 1);
  fixture.coordinator.syncNow();
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  fixture.coordinator.resetAll("試験");
  // 配置待ちの破棄後に届いた遅延生成は回収する。
  const late = new FakeView(11, 7, placement.initialUrl);
  expect(fixture.coordinator.handleTagCreated(late)).toBe(true);
  expect(late.removed).toBe(true);
  expect(late.loaded).toHaveLength(0);
  expect(fixture.coordinator.size).toBe(0);
});

test("重複する生成を回収する", () => {
  const fixture = setup();
  fixture.setView(fixture.instanceId, 1);
  fixture.coordinator.syncNow();
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  fixture.coordinator.handleTagCreated(new FakeView(11, 7, placement.initialUrl));
  const duplicated = new FakeView(12, 7, placement.initialUrl);
  expect(fixture.coordinator.handleTagCreated(duplicated)).toBe(true);
  expect(duplicated.removed).toBe(true);
  expect(duplicated.loaded).toHaveLength(0);
  expect(fixture.coordinator.size).toBe(1);
});
