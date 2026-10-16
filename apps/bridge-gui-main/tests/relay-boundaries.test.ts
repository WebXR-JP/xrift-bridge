/**
 * 中継の境界・不変条件の独立検証。
 *
 * 配送先の固定・世代／マウント分離・業務エラーと失効の分離・寿命と資源・
 * 透明性を、偽子画面・偽 endpoint・偽 core だけで観測する。判定は
 * `PluginUiCoordinator` と `PluginInstanceManager` の実装を通した実測だけを
 * 根拠とし、builder の自己申告には依存しない。Electrobun の SDK 呼び出し・
 * native 画素観測・実入力は行わない（非目標）。
 *
 * @packageDocumentation
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { PluginRelayEvent, PluginRelayRequest } from "bridge-gui-contract/plugin-instance";
import {
  buildPluginNavigationRules,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import {
  PluginCompanionRegistry,
  type ErasedEndpointFactory,
} from "../src/main/plugin-companions.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  PluginUiCoordinator,
  type PluginRelayHandler,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";
import {
  alphaDescriptor,
  betaDescriptor,
  firstFitPolicy,
  makeSession,
  setupFixture,
} from "./plugin-instance-manager-fakes.ts";

/** 検証用の `alpha` 操作口の形。偽個体が持つ操作口と一致する。 */
interface AlphaOperations {
  /**
   * 計数に加える。
   *
   * @param delta - 加える値。
   * @returns 加算後の計数。
   */
  add(delta: number): number;
}

/** 中継された要求の記録。`boundInstance` は endpoint 生成時に確定した値である。 */
interface RelayCall {
  readonly boundInstance: string;
  readonly method: string;
  readonly params: unknown;
}

/** 検証用の endpoint。要求名ごとに結果を変え、受信と終了だけを記録する。 */
class RecordingEndpoint implements PluginEndpoint {
  /** 受けた要求の記録。 */
  readonly calls: RelayCall[] = [];
  /** 結び付いた emission port。その表示期間の子へ通知する口。 */
  readonly emission: PluginEmissionPort;
  /** 終了回数。冪等終了の観測に使う。 */
  disposeCalls = 0;
  /** endpoint 生成時に束縛が確定した個体。 */
  readonly boundInstance: string;
  private readonly ref: BoundPluginRef<unknown, unknown>;
  private readonly slow: boolean;
  private readonly gates: ((value: unknown) => void)[] = [];

  /**
   * @param ref - 束縛個体に限定した参照口。
   * @param emission - その表示期間の子にだけ送る通知口。
   * @param options - `slow` を真にすると `slow` 要求が未確定のまま残る。
   */
  constructor(
    ref: BoundPluginRef<unknown, unknown>,
    emission: PluginEmissionPort,
    options: { slow?: boolean } = {},
  ) {
    this.ref = ref;
    this.emission = emission;
    this.boundInstance = ref.getBinding().instanceId;
    this.slow = options.slow ?? false;
  }

  /** 終了済みなら真。 */
  get disposed(): boolean {
    return this.disposeCalls > 0;
  }

  async handleRequest(request: PluginRelayRequest): Promise<unknown> {
    this.calls.push({
      boundInstance: this.boundInstance,
      method: request.method,
      params: request.params,
    });
    if (request.method === "add") {
      const params = request.params as { delta?: unknown };
      const delta = typeof params.delta === "number" ? params.delta : 0;
      return this.ref.withOperations((operations) => (operations as AlphaOperations).add(delta));
    }
    if (request.method === "throw-range") {
      throw new RangeError("業務上の範囲外である。");
    }
    if (request.method === "business-error") {
      return { ok: false, reason: "out-of-range" };
    }
    if (request.method === "slow") {
      if (!this.slow) {
        return { ok: true, value: "slow" };
      }
      return new Promise<unknown>((resolve) => {
        this.gates.push(resolve);
      });
    }
    return { ok: false, reason: "unknown-method", method: request.method };
  }

  /** 未確定の `slow` 要求を確定させる。遅延応答の観測に使う。 */
  resolveGates(value: unknown): void {
    for (const gate of this.gates.splice(0)) {
      gate(value);
    }
  }

  /** 通知を送る。送り元 endpoint がどの子へ届くかの観測に使う。 */
  notify(payload: unknown): void {
    this.emission.emit({ event: "boundary-event", payload });
  }

  dispose(): void {
    if (this.disposeCalls > 0) {
      return;
    }
    this.disposeCalls += 1;
  }
}

/** 偽子画面の生成条件の上書き。生成照合の拒否側を動かすために使う。 */
interface FakeViewOverrides {
  /** 描画方式。`native` 以外を拒否側で試す。 */
  readonly renderer?: string;
  /** 隔離指定。付けた生成を拒否側で試す。 */
  readonly sandbox?: boolean;
  /** preload 指定。付けた生成を拒否側で試す。 */
  readonly preload?: string | null;
  /** 作成時の遷移規則。期待規則との照合の拒否側で試す。実表現は配列である。 */
  readonly navigationRules?: unknown;
}

/**
 * 静的登録の期待遷移規則。`setupBoundary` の登録内容（alpha・beta の
 * view パス）から導く。main が照合する期待値と同じ作り方である。
 */
const EXPECTED_NAVIGATION_RULES = buildPluginNavigationRules([
  "views://plugin-alpha/index.html",
  "views://plugin-beta/index.html",
]);

/** 検証用の偽子画面。読込み・破棄の事実だけを残す。 */
class FakeView implements PluginUiChildView {
  /** 生成の連番。識別子の使い分けに使う。 */
  private static nextId = 11;
  /** 破棄されたら真。 */
  removed = false;
  /** 読み込んだ URL の記録。 */
  readonly loaded: string[] = [];
  /** native 側の表示識別子。 */
  readonly viewId = FakeView.nextId++;
  /** 親 Webview の識別子。 */
  readonly hostWebviewId: number | undefined;
  /** 発行済みの初期 URL。 */
  readonly currentUrl: string | null;
  /** 描画方式。 */
  readonly renderer: string;
  /** 隔離指定の有無。 */
  readonly sandbox: boolean;
  /** preload 指定。 */
  readonly preload: string | null;
  /** 作成時の遷移規則。実表現は `string[]` 配列である。 */
  readonly navigationRules: unknown;

  /**
   * @param hostWebviewId - 親 Webview の識別子。
   * @param currentUrl - 発行済みの初期 URL。
   * @param overrides - 生成条件の上書き。省略時は本番と同じ条件。
   */
  constructor(
    hostWebviewId: number | undefined,
    currentUrl: string | null,
    overrides: FakeViewOverrides = {},
  ) {
    this.hostWebviewId = hostWebviewId;
    this.currentUrl = currentUrl;
    this.renderer = overrides.renderer ?? "native";
    this.sandbox = overrides.sandbox ?? false;
    this.preload = overrides.preload ?? null;
    // 省略時は静的登録の期待規則と一致する正規値（実表現の配列）を載せる。
    // 明示の `null`（欠落の再現）は `??` で潰さないよう `in` で区別する。
    this.navigationRules =
      "navigationRules" in overrides
        ? (overrides.navigationRules ?? null)
        : [...EXPECTED_NAVIGATION_RULES];
  }

  loadPluginUrl(url: string): void {
    this.loaded.push(url);
  }

  removeView(): void {
    this.removed = true;
  }
}

/** 検証用の組み立て。 */
interface BoundaryFixture {
  readonly coordinator: PluginUiCoordinator;
  readonly manager: PluginInstanceManager;
  readonly core: ReturnType<typeof setupFixture>["core"];
  readonly sessions: ReturnType<typeof setupFixture>["sessions"];
  readonly alpha1: string;
  readonly alpha2: string;
  readonly beta: string;
  readonly views: FakeView[];
  readonly relays: Map<string, PluginRelayHandler>;
  readonly pushes: Map<string, PluginRelayEvent[]>;
  readonly notified: { count: number };
  setNow(value: number): void;
  setView(instanceId: string | null, viewGeneration: number): void;
  endpointsFor(instanceId: string): readonly RecordingEndpoint[];
  /** 対応付け・走査タイマーを後始末する。endpoint の終了も兼ねる。 */
  dispose(): void;
}

/** 試験終了時に後始末する対応付け。走査タイマーを残さない。 */
const liveCoordinators: PluginUiCoordinator[] = [];

afterEach(() => {
  for (const coordinator of liveCoordinators.splice(0)) {
    try {
      coordinator.dispose();
    } catch {
      // 後始末の失敗は次の試験を止めない。
    }
  }
});

/**
 * 検証用の組み立てを作る。`alpha` 2個体と `beta` 1個体を割り当て済みにする。
 *
 * @param options - `slow` を真にすると全 endpoint の `slow` 要求が未確定のまま残る。
 * @returns 検証用の組み立て。
 */
function setupBoundary(options: { slow?: boolean } = {}): BoundaryFixture {
  const base = setupFixture([
    makeSession("local-1", "conn-a"),
    makeSession("local-2", "conn-b"),
    makeSession("local-3", "conn-c"),
  ]);
  const manager = new PluginInstanceManager(base.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  manager.register(betaDescriptor({ assignment: firstFitPolicy(null) }));
  const alpha1 = manager.assign("alpha");
  const alpha2 = manager.assign("alpha");
  const beta = manager.assign("beta");
  const endpointsByInstance = new Map<string, RecordingEndpoint[]>();
  const factory: ErasedEndpointFactory = (ref, emission) => {
    const endpoint = new RecordingEndpoint(ref, emission, options);
    const bound = endpoint.boundInstance;
    const list = endpointsByInstance.get(bound) ?? [];
    list.push(endpoint);
    endpointsByInstance.set(bound, list);
    return endpoint;
  };
  const registry = new PluginCompanionRegistry();
  registry.register(
    {
      kind: "alpha",
      label: "合成α",
      viewEntry: "index.html",
      viewPath: "views://plugin-alpha/index.html",
    },
    factory,
  );
  registry.register(
    {
      kind: "beta",
      label: "合成β",
      viewEntry: "index.html",
      viewPath: "views://plugin-beta/index.html",
    },
    factory,
  );
  const relays = new Map<string, PluginRelayHandler>();
  const pushes = new Map<string, PluginRelayEvent[]>();
  const createChannel: PluginUiChannelFactory = (_view, mountId, onRelay) => {
    relays.set(mountId, onRelay);
    pushes.set(mountId, []);
    const channel: PluginUiChannel = {
      push: (event) => {
        pushes.get(mountId)?.push(event);
      },
    };
    return channel;
  };
  const notified = { count: 0 };
  let nowMs = 0;
  let view: { instanceId: string | null; viewGeneration: number } = {
    instanceId: null,
    viewGeneration: 0,
  };
  const coordinator = new PluginUiCoordinator(
    7,
    { notifyExternalChange: () => void (notified.count += 1) },
    createChannel,
    () => nowMs,
    registry,
    manager,
    () => ({ ...view }),
  );
  liveCoordinators.push(coordinator);
  return {
    coordinator,
    manager,
    core: base.core,
    sessions: base.sessions,
    alpha1: alpha1.instanceId,
    alpha2: alpha2.instanceId,
    beta: beta.instanceId,
    views: [],
    relays,
    pushes,
    notified,
    setNow: (value) => {
      nowMs = value;
    },
    setView: (instanceId, viewGeneration) => {
      view = { instanceId, viewGeneration };
    },
    endpointsFor: (instanceId) => endpointsByInstance.get(instanceId) ?? [],
    dispose: () => {
      coordinator.dispose();
    },
  };
}

/**
 * 配置待ちの1件をタグ生成で結線し、マウント識別子を返す。
 *
 * @param fixture - 検証用の組み立て。
 * @returns 結線したマウント識別子。
 */
function bindPending(fixture: BoundaryFixture): string {
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) {
    throw new Error("配置が無い。");
  }
  const view = new FakeView(7, placement.initialUrl);
  fixture.views.push(view);
  if (!fixture.coordinator.handleTagCreated(view)) {
    throw new Error("生成を消費できなかった。");
  }
  return placement.mountId;
}

/**
 * 表示要求を置いて結線する。
 *
 * @param fixture - 検証用の組み立て。
 * @param instanceId - 表示する個体。
 * @param generation - 表示期間の世代。
 * @returns 結線したマウント識別子。
 */
function show(fixture: BoundaryFixture, instanceId: string, generation: number): string {
  fixture.setView(instanceId, generation);
  fixture.coordinator.syncNow();
  return bindPending(fixture);
}

/**
 * 個体の計数を読む。
 *
 * @param fixture - 検証用の組み立て。
 * @param instanceId - 読む個体。
 * @returns 計数。
 */
function countOf(fixture: BoundaryFixture, instanceId: string): number {
  const instance = fixture.core.instances.get(instanceId);
  if (instance === undefined) {
    throw new Error("個体が無い。");
  }
  return (instance.getState() as { count: number }).count;
}

/**
 * 中継口を得る。
 *
 * @param fixture - 検証用の組み立て。
 * @param mountId - マウント識別子。
 * @returns 当該マウントに閉じ込めた中継口。
 */
function relayOf(fixture: BoundaryFixture, mountId: string): PluginRelayHandler {
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) {
    throw new Error("中継口が無い。");
  }
  return relay;
}

/**
 * 偽個体が終了しているかを読む。
 *
 * 観測用の形へ一度消す。`PluginInstance` の公開面には生存印が無く、
 * 偽個体だけが持つ観測項目である。
 *
 * @param fixture - 検証用の組み立て。
 * @param instanceId - 読む個体。
 * @returns 終了していれば真。
 */
function isDisposed(fixture: BoundaryFixture, instanceId: string): boolean {
  const instance = fixture.core.instances.get(instanceId);
  if (instance === undefined) {
    throw new Error("個体が無い。");
  }
  return (instance as unknown as { isDisposed?: boolean }).isDisposed ?? false;
}

test("payload の instanceId・kind で配送先が変わらない", async () => {
  const fixture = setupBoundary();
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  // 別個体・別種別の識別子を騙って束縛個体へ送る。
  const result = await relay({
    method: "add",
    params: { delta: 5, instanceId: fixture.beta, kind: "beta" },
  });
  expect(result.ok).toBe(true);
  // 束縛された `alpha` 個体の endpoint だけが動いた。
  const alpha1Calls = fixture.endpointsFor(fixture.alpha1);
  expect(alpha1Calls).toHaveLength(1);
  expect(alpha1Calls[0]?.calls).toHaveLength(1);
  expect(alpha1Calls[0]?.calls[0]?.boundInstance).toBe(fixture.alpha1);
  expect(fixture.endpointsFor(fixture.alpha2)).toHaveLength(0);
  expect(fixture.endpointsFor(fixture.beta)).toHaveLength(0);
  expect(countOf(fixture, fixture.alpha1)).toBe(5);
  expect(countOf(fixture, fixture.alpha2)).toBe(0);
  // params は改変されず素通しされる（main は解釈しない）。
  expect(alpha1Calls[0]?.calls[0]?.params).toEqual({
    delta: 5,
    instanceId: fixture.beta,
    kind: "beta",
  });
});

test("旧世代の要求と通知は新しい表示期間の子へ入らない", async () => {
  const fixture = setupBoundary();
  const first = show(fixture, fixture.alpha1, 1);
  const relayFirst = relayOf(fixture, first);
  const firstEndpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (firstEndpoint === undefined) throw new Error("endpoint が無い。");
  await relayFirst({ method: "add", params: { delta: 1 } });
  expect(countOf(fixture, fixture.alpha1)).toBe(1);

  // 世代が進むと旧子は破棄され、新しいマウントが作られる。
  fixture.setView(fixture.alpha1, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(firstEndpoint.disposeCalls).toBe(1);
  expect(fixture.views[0]?.removed).toBe(true);
  const second = bindPending(fixture);
  expect(second).not.toBe(first);
  const relaySecond = relayOf(fixture, second);
  const secondEndpoint = fixture.endpointsFor(fixture.alpha1)[1];
  if (secondEndpoint === undefined) throw new Error("endpoint が無い。");

  // 旧マウントの中継は endpoint を呼ばず失敗として返る。
  const late = await relayFirst({ method: "add", params: { delta: 100 } });
  expect(late.ok).toBe(false);
  if (!late.ok) expect(late.error.code).toBe("unmounted");
  expect(firstEndpoint.calls).toHaveLength(1);
  expect(countOf(fixture, fixture.alpha1)).toBe(1);

  // 旧 endpoint の通知は新しい子へ届かない。
  const pushesSecond = fixture.pushes.get(second) ?? [];
  const pushesFirst = fixture.pushes.get(first) ?? [];
  firstEndpoint.notify({ n: 1 });
  expect(pushesSecond).toHaveLength(0);
  expect(pushesFirst).toHaveLength(0);
  // 新 endpoint の通知は届く（対照）。
  secondEndpoint.notify({ n: 2 });
  expect(pushesSecond).toHaveLength(1);
  expect(pushesSecond[0]?.payload).toEqual({ n: 2 });

  // 新しい子の要求は新しい endpoint へ届く。
  await relaySecond({ method: "add", params: { delta: 3 } });
  expect(secondEndpoint.calls).toHaveLength(1);
  expect(countOf(fixture, fixture.alpha1)).toBe(4);
});

test("旧世代の遅延応答は失効として返り新しい表示期間を汚さない", async () => {
  const fixture = setupBoundary({ slow: true });
  const first = show(fixture, fixture.alpha1, 1);
  const relayFirst = relayOf(fixture, first);
  const firstEndpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (firstEndpoint === undefined) throw new Error("endpoint が無い。");
  // 未確定の要求を掛けてから表示期間を替える。
  const inFlight = relayFirst({ method: "slow", params: {} });
  fixture.setView(fixture.alpha1, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const second = bindPending(fixture);
  const secondEndpoint = fixture.endpointsFor(fixture.alpha1)[1];
  if (secondEndpoint === undefined) throw new Error("endpoint が無い。");
  const pushesSecond = fixture.pushes.get(second) ?? [];
  // 旧要求が確定しても失効として返り、新しい子へは届かない。
  firstEndpoint.resolveGates({ value: "late" });
  const result = await inFlight;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  expect(secondEndpoint.calls).toHaveLength(0);
  expect(pushesSecond).toHaveLength(0);
  expect(countOf(fixture, fixture.alpha1)).toBe(0);
  // 失効後の完了では応答済みにしない。
  expect(fixture.coordinator.listPlacements()).toHaveLength(1);
  expect(fixture.coordinator.listPlacements()[0]?.mountId).toBe(second);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(false);
});

test("endpoint の RangeError は束縛失効と誤認しない", async () => {
  const fixture = setupBoundary();
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  const thrown = await relay({ method: "throw-range", params: {} });
  // 失効ではなく、アプリ自身の照合以外の失敗として返る。
  expect(thrown.ok).toBe(false);
  if (!thrown.ok) expect(thrown.error.code).toBe("endpoint-closed");
  // マウントは生きており、失敗表示も失効も起きない。
  expect(fixture.coordinator.size).toBe(1);
  expect(fixture.coordinator.isLive(mountId)).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(false);
  expect(fixture.endpointsFor(fixture.alpha1)[0]?.disposed).toBe(false);
  // その後の通常要求は通る。
  const ok = await relay({ method: "add", params: { delta: 2 } });
  expect(ok.ok).toBe(true);
  expect(countOf(fixture, fixture.alpha1)).toBe(2);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
});

test("業務エラー値と未知 method は不透明な応答として返り失効にしない", async () => {
  const fixture = setupBoundary();
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  const business = await relay({ method: "business-error", params: {} });
  expect(business.ok).toBe(true);
  if (business.ok) expect(business.value).toEqual({ ok: false, reason: "out-of-range" });
  const unknown = await relay({ method: "erase", params: {} });
  expect(unknown.ok).toBe(true);
  if (unknown.ok) {
    expect(unknown.value).toMatchObject({ reason: "unknown-method", method: "erase" });
  }
  expect(fixture.coordinator.size).toBe(1);
  expect(fixture.coordinator.isLive(mountId)).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
});

test("main 自身の照合で失効した束縛だけが unmounted になる", async () => {
  const fixture = setupBoundary();
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  fixture.manager.unassign("alpha", fixture.alpha1);
  const result = await relay({ method: "add", params: { delta: 1 } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  // 失効ではホスト自身が個体を回収する（`removeInstance` はホストの照合経由）。
  expect(fixture.core.instances.has(fixture.alpha1)).toBe(false);
  // 表示中の子も破棄され、失敗表示には回さない。
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
});

test("表示を重ねても子・endpoint が残らず本体・Session は終了しない", async () => {
  const fixture = setupBoundary();
  const cycles = 25;
  for (let generation = 1; generation <= cycles; generation += 1) {
    const mountId = show(fixture, fixture.alpha1, generation);
    const relay = relayOf(fixture, mountId);
    const result = await relay({ method: "add", params: { delta: 1 } });
    expect(result.ok).toBe(true);
  }
  expect(countOf(fixture, fixture.alpha1)).toBe(cycles);
  // 非表示にして最後の子を破棄する。
  fixture.setView(null, cycles + 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listPlacements()).toHaveLength(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  // endpoint は作られた数だけ終了している。
  const endpoints = fixture.endpointsFor(fixture.alpha1);
  expect(endpoints).toHaveLength(cycles);
  expect(endpoints.filter((endpoint) => endpoint.disposeCalls === 1)).toHaveLength(cycles);
  // 子は作られた数だけ破棄されている。
  expect(fixture.views).toHaveLength(cycles);
  expect(fixture.views.filter((view) => view.removed)).toHaveLength(cycles);
  // 個体・割当て・Session を作り増していない（表示回数で増えない）。
  expect(fixture.core.countCalls("createInstance")).toBe(3);
  expect(fixture.core.instances.size).toBe(3);
  expect(fixture.core.countCalls("removeInstance")).toBe(0);
  expect(fixture.sessions.stops).toBe(0);
  expect(isDisposed(fixture, fixture.alpha1)).toBe(false);
  expect(isDisposed(fixture, fixture.beta)).toBe(false);
  const owned = fixture.manager.listOwned();
  expect(owned.map((record) => record.instanceId).sort()).toEqual(
    [fixture.alpha1, fixture.alpha2, fixture.beta].sort(),
  );
  expect(owned.filter((record) => record.phase === "active")).toHaveLength(3);
  // 再表示は新しい世代で作れる。
  fixture.setView(fixture.alpha1, cycles + 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(1);
  fixture.coordinator.resetAll("試験");
  expect(fixture.coordinator.size).toBe(0);
});

test("待機中の走査タイマーは増えず、破棄後に残らない", async () => {
  vi.useFakeTimers();
  try {
    const baseline = vi.getTimerCount();
    const fixture = setupBoundary();
    expect(vi.getTimerCount()).toBe(baseline);
    fixture.setView(fixture.alpha1, 1);
    expect(fixture.coordinator.syncNow()).toBe(true);
    // 待機中の1本だけを持つ。
    expect(vi.getTimerCount()).toBe(baseline + 1);
    for (let generation = 2; generation <= 10; generation += 1) {
      fixture.setView(fixture.alpha1, generation);
      expect(fixture.coordinator.syncNow()).toBe(true);
      expect(vi.getTimerCount()).toBe(baseline + 1);
    }
    // 最初の正常応答で待機が無くなり、走査は止まる。
    const mountId = bindPending(fixture);
    const relay = relayOf(fixture, mountId);
    await relay({ method: "add", params: { delta: 1 } });
    // 応答済みになったことで走査の要件が消え、タイマーは止まる。
    fixture.coordinator.syncNow();
    expect(vi.getTimerCount()).toBe(baseline);
    // 全破棄でも残さない。
    fixture.setView(fixture.alpha1, 11);
    fixture.coordinator.syncNow();
    expect(vi.getTimerCount()).toBe(baseline + 1);
    fixture.coordinator.resetAll("試験");
    expect(vi.getTimerCount()).toBe(baseline);
  } finally {
    vi.useRealTimers();
  }
});

test("生成条件（native・非sandbox・preload無し）に合わない子は回収する", () => {
  const cases: readonly FakeViewOverrides[] = [
    { renderer: "webgl" },
    { sandbox: true },
    { preload: "/tmp/injected.js" },
  ];
  for (const overrides of cases) {
    const fixture = setupBoundary();
    fixture.setView(fixture.alpha1, 1);
    expect(fixture.coordinator.syncNow()).toBe(true);
    const placement = fixture.coordinator.listPlacements()[0];
    if (placement === undefined) throw new Error("配置が無い。");
    const view = new FakeView(7, placement.initialUrl, overrides);
    expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
    // 回収され、endpoint は作られず、失敗表示に局所化する。
    expect(view.removed).toBe(true);
    expect(view.loaded).toHaveLength(0);
    expect(fixture.coordinator.size).toBe(0);
    expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(0);
    const failures = fixture.coordinator.listFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("生成条件");
    expect(failures[0]?.viewGeneration).toBe(1);
    // 同一世代では自動で作り直さない（明示の再試行まで）。
    expect(fixture.coordinator.syncNow()).toBe(false);
    expect(fixture.coordinator.size).toBe(0);
    expect(fixture.coordinator.retryFailed(fixture.alpha1)).toEqual({ ok: true });
    expect(fixture.coordinator.size).toBe(1);
    fixture.coordinator.resetAll("試験");
  }
});

test("main の汎用層は plugin 固有名・固有型を参照せず params/payload を素通しする", () => {
  const mainDir = fileURLToPath(new URL("../src/main/", import.meta.url));
  const files = readdirSync(mainDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  expect(files.length).toBeGreaterThan(5);
  const forbidden = [
    "bridge-plugin-text",
    "bridge-plugin-udp",
    "bridge-plugin-diagnostic",
    "getTextState",
    "getUdpState",
    "sendText",
    "startBind",
    "stopBind",
    "textStateChanged",
    "udpStateChanged",
    "diagnosticStateChanged",
    "UDP_RELAY_",
    "TEXT_RELAY_",
    "DIAGNOSTIC_RELAY_",
    "UdpCompanionSnapshot",
    "TextCompanionSnapshot",
  ];
  const offenders: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(mainDir, name), "utf8");
    for (const token of forbidden) {
      if (source.includes(token)) {
        offenders.push(`${name}: ${token}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("正規の遷移規則は結線でき不一致・欠落・不正は endpoint 生成前に回収する", () => {
  // 正規値は実表現の配列で結線できる（対照）。JSON 文字列形も互換として結線できる。
  {
    const fixture = setupBoundary();
    const mountId = show(fixture, fixture.alpha1, 1);
    expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(1);
    expect(fixture.relays.get(mountId)).not.toBeUndefined();
    expect(fixture.views[0]?.loaded).toHaveLength(1);
  }
  {
    const fixture = setupBoundary();
    fixture.setView(fixture.alpha1, 1);
    expect(fixture.coordinator.syncNow()).toBe(true);
    const placement = fixture.coordinator.listPlacements()[0];
    if (placement === undefined) throw new Error("配置が無い。");
    const view = new FakeView(7, placement.initialUrl, {
      navigationRules: JSON.stringify(EXPECTED_NAVIGATION_RULES),
    });
    fixture.views.push(view);
    expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
    expect(view.removed).toBe(false);
    expect(view.loaded).toHaveLength(1);
    expect(fixture.coordinator.size).toBe(1);
    expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(1);
  }
  const cases: readonly { navigationRules: unknown }[] = [
    { navigationRules: null },
    { navigationRules: "{not-json" },
    { navigationRules: JSON.stringify({ allow: "*" }) },
    { navigationRules: [...EXPECTED_NAVIGATION_RULES, "views://evil/*"] },
    { navigationRules: EXPECTED_NAVIGATION_RULES.slice(0, -1) },
    { navigationRules: [...EXPECTED_NAVIGATION_RULES].reverse() },
    { navigationRules: [42] },
    { navigationRules: ["views://plugin-alpha/*", 42] },
    { navigationRules: JSON.stringify([...EXPECTED_NAVIGATION_RULES, "views://evil/*"]) },
    { navigationRules: JSON.stringify(EXPECTED_NAVIGATION_RULES.slice(0, -1)) },
    { navigationRules: JSON.stringify([...EXPECTED_NAVIGATION_RULES].reverse()) },
    { navigationRules: JSON.stringify([42]) },
  ];
  for (const entry of cases) {
    const fixture = setupBoundary();
    fixture.setView(fixture.alpha1, 1);
    expect(fixture.coordinator.syncNow()).toBe(true);
    const placement = fixture.coordinator.listPlacements()[0];
    if (placement === undefined) throw new Error("配置が無い。");
    const view = new FakeView(7, placement.initialUrl, { navigationRules: entry.navigationRules });
    fixture.views.push(view);
    expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
    // endpoint 生成・RPC 結線・子 URL 読込みより前に回収する。
    expect(view.removed).toBe(true);
    expect(view.loaded).toHaveLength(0);
    expect(fixture.coordinator.size).toBe(0);
    expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(0);
    expect(fixture.relays.get(placement.mountId)).toBeUndefined();
    const failures = fixture.coordinator.listFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.viewGeneration).toBe(1);
    expect(failures[0]?.reason).toContain("遷移規則");
    // 同一表示期間では自動で作り直さない。
    expect(fixture.coordinator.syncNow()).toBe(false);
    expect(fixture.coordinator.size).toBe(0);
  }
});

test("遷移規則の前後空白差は許容して結線する", () => {
  const fixture = setupBoundary();
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const padded = new FakeView(7, placement.initialUrl, {
    navigationRules: EXPECTED_NAVIGATION_RULES.map((rule) => `  ${rule}  `),
  });
  fixture.views.push(padded);
  expect(fixture.coordinator.handleTagCreated(padded)).toBe(true);
  expect(padded.removed).toBe(false);
  expect(padded.loaded).toHaveLength(1);
  expect(fixture.coordinator.size).toBe(1);
  expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(1);
});

test("await 中の束縛失効後の完了は正常値を返さない", async () => {
  const fixture = setupBoundary({ slow: true });
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  const endpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (endpoint === undefined) throw new Error("endpoint が無い。");
  const inFlight = relay({ method: "slow", params: {} });
  fixture.manager.unassign("alpha", fixture.alpha1);
  endpoint.resolveGates({ value: "late" });
  const result = await inFlight;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  // 失効後の完了では応答済みにしない。
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(false);
});

test("await 中の期限切れ後の完了は正常値を返さない", async () => {
  const fixture = setupBoundary({ slow: true });
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  const endpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (endpoint === undefined) throw new Error("endpoint が無い。");
  const inFlight = relay({ method: "slow", params: {} });
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  endpoint.resolveGates({ value: "late" });
  const result = await inFlight;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.size).toBe(0);
});

test("失敗後の再表示は新しい表示期間で一度生成する", () => {
  const fixture = setupBoundary();
  // 世代1で生成条件の不一致により失敗する。
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const first = fixture.coordinator.listPlacements()[0];
  if (first === undefined) throw new Error("配置が無い。");
  const bad = new FakeView(7, first.initialUrl, { renderer: "webgl" });
  fixture.views.push(bad);
  expect(fixture.coordinator.handleTagCreated(bad)).toBe(true);
  expect(bad.removed).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  // 同一表示期間では自動で作り直さない。
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.size).toBe(0);
  // 新しい表示期間では一度だけ生成する。
  fixture.setView(fixture.alpha1, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const secondMountId = bindPending(fixture);
  expect(secondMountId).not.toBe(first.mountId);
  expect(fixture.coordinator.listPlacements()[0]?.viewGeneration).toBe(2);
  expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(1);
  // 新しい表示期間でも重ねて作らない。
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.size).toBe(1);
});

test("同一表示期間の明示再試行は世代を維持し識別子を更新する", () => {
  const fixture = setupBoundary();
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const first = fixture.coordinator.listPlacements()[0];
  if (first === undefined) throw new Error("配置が無い。");
  const bad = new FakeView(7, first.initialUrl, { sandbox: true });
  fixture.views.push(bad);
  expect(fixture.coordinator.handleTagCreated(bad)).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.retryFailed(fixture.alpha1)).toEqual({ ok: true });
  const retried = fixture.coordinator.listPlacements()[0];
  if (retried === undefined) throw new Error("配置が無い。");
  // 識別子は使い回さず、世代は維持する。
  expect(retried.mountId).not.toBe(first.mountId);
  expect(retried.viewGeneration).toBe(1);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  // 再試行後の失敗も同一表示期間では抑止する。
  const badAgain = new FakeView(7, retried.initialUrl, { sandbox: true });
  fixture.views.push(badAgain);
  expect(fixture.coordinator.handleTagCreated(badAgain)).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.syncNow()).toBe(false);
});
