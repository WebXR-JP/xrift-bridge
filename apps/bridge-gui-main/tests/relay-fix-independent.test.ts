/**
 * 中継・寿命の修正（表示世代の main 所有／navigationRules の静的照合／
 * 非同期完了の生存再照合／表示期間単位の失敗抑止）の独立検証。
 *
 * 既存の `relay-boundaries.test.ts`・`relay-lifetime.test.ts`・
 * `plugin-view-generation.test.ts` とは観測経路をずらして組む。
 *
 * - 世代は本物の `GuiBackend` で採番・採用／stale を観測し、そのうえで
 *   本物の状態通知経路（`onStateChanged` → `syncNow`）まで通して非同期
 *   完了の再照合を見る。
 * - navigationRules は `matchPluginNavigationRules` を直接叩く表組みと、
 *   endpoint 工場の呼び出し回数を数える経路で照合順序を見る。
 * - 失敗抑止は「世代＋対象」の両方で区切られることを、別個体・再試行の
 *   組合せで見る。
 *
 * native 画素観測・実入力の自動化は行わない（非目標）。
 *
 * @packageDocumentation
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import type {
  AdoptedPluginView,
  PluginRelayEvent,
  PluginRelayRequest,
} from "bridge-gui-contract/plugin-instance";
import {
  buildPluginNavigationRules,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import { GuiBackend } from "../src/main/backend.ts";
import {
  PluginCompanionRegistry,
  type ErasedEndpointFactory,
} from "../src/main/plugin-companions.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  matchPluginNavigationRules,
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

/* ------------------------------------------------------------------ */
/* 共通の検証用部品                                                     */
/* ------------------------------------------------------------------ */

/** 検証用の `alpha` 操作口の形。偽個体が持つ操作口と一致する。 */
interface AlphaOperations {
  /** 計数に加える。 */
  add(delta: number): number;
}

/** 要求を手で確定できる endpoint。非同期完了の観測に使う。 */
class GatedEndpoint implements PluginEndpoint {
  /** 受けた要求の記録。 */
  readonly calls: PluginRelayRequest[] = [];
  /** 結び付いた emission port。 */
  readonly emission: PluginEmissionPort;
  /** 終了回数。 */
  disposeCalls = 0;
  /** endpoint 生成時に束縛が確定した個体。 */
  readonly boundInstance: string;
  private readonly ref: BoundPluginRef<unknown, unknown>;
  private readonly pending: ReadonlySet<string>;
  private readonly gates: ((value: unknown) => void)[] = [];

  /**
   * @param ref - 束縛個体に限定した参照口。
   * @param emission - その表示期間の子にだけ送る通知口。
   * @param pending - 未確定のまま残す要求名の集合。
   */
  constructor(
    ref: BoundPluginRef<unknown, unknown>,
    emission: PluginEmissionPort,
    pending: ReadonlySet<string>,
  ) {
    this.ref = ref;
    this.emission = emission;
    this.pending = pending;
    this.boundInstance = ref.getBinding().instanceId;
  }

  /** 終了済みなら真。 */
  get disposed(): boolean {
    return this.disposeCalls > 0;
  }

  async handleRequest(request: PluginRelayRequest): Promise<unknown> {
    this.calls.push(request);
    if (request.method === "add") {
      const params = request.params as { delta?: unknown };
      const delta = typeof params.delta === "number" ? params.delta : 0;
      return this.ref.withOperations((operations) => (operations as AlphaOperations).add(delta));
    }
    if (this.pending.has(request.method)) {
      return new Promise<unknown>((resolve) => {
        this.gates.push(resolve);
      });
    }
    return { ok: true, echo: request.method };
  }

  /** 未確定の要求を確定させる。 */
  resolveGates(value: unknown): void {
    for (const gate of this.gates.splice(0)) {
      gate(value);
    }
  }

  /** 通知を送る。 */
  notify(payload: unknown): void {
    this.emission.emit({ event: "independent-event", payload });
  }

  dispose(): void {
    if (this.disposeCalls > 0) return;
    this.disposeCalls += 1;
  }
}

/** 検証用の偽子画面。 */
class FakeView implements PluginUiChildView {
  /** 生成の連番。 */
  private static nextId = 900;
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
  /** 作成時の遷移規則。欠落は `in` で区別する。実表現は `string[]` 配列である。 */
  readonly navigationRules: unknown;

  /**
   * @param hostWebviewId - 親 Webview の識別子。
   * @param currentUrl - 発行済みの初期 URL。
   * @param overrides - 生成条件の上書き。
   */
  constructor(
    hostWebviewId: number | undefined,
    currentUrl: string | null,
    overrides: {
      renderer?: string;
      sandbox?: boolean;
      preload?: string | null;
      navigationRules?: unknown;
    } = {},
  ) {
    this.hostWebviewId = hostWebviewId;
    this.currentUrl = currentUrl;
    this.renderer = overrides.renderer ?? "native";
    this.sandbox = overrides.sandbox ?? false;
    this.preload = overrides.preload ?? null;
    this.navigationRules =
      "navigationRules" in overrides ? (overrides.navigationRules ?? null) : [...EXPECTED_RULES];
  }

  loadPluginUrl(url: string): void {
    this.loaded.push(url);
  }

  removeView(): void {
    this.removed = true;
  }
}

/** 静的登録の期待遷移規則（`setupIndependent` の登録順と一致させる）。 */
const EXPECTED_RULES = buildPluginNavigationRules([
  "views://plugin-alpha/index.html",
  "views://plugin-beta/index.html",
]);

/** 検証用の組み立て。 */
interface Fixture {
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
  /** endpoint 工場の呼び出し回数（種別を問わない）。 */
  readonly factoryCalls: { count: number };
  setNow(value: number): void;
  setView(instanceId: string | null, viewGeneration: number): void;
  endpointsFor(instanceId: string): readonly GatedEndpoint[];
}

/** 組み立ての選択。 */
interface FixtureOptions {
  /** 未確定のまま残す要求名。 */
  readonly pending?: ReadonlySet<string>;
  /** 表示状態を読む口。本物の backend を繋いで実配線を再現する。 */
  readonly viewSource?: () => AdoptedPluginView;
}

/** 試験終了時に後始末する対応付け。 */
const liveCoordinators: PluginUiCoordinator[] = [];

/** 試験終了時に閉じるバックエンド。 */
const backends: GuiBackend[] = [];

afterEach(() => {
  for (const coordinator of liveCoordinators.splice(0)) {
    try {
      coordinator.dispose();
    } catch {
      // 後始末の失敗は次の試験を止めない。
    }
  }
});

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後始末の終了失敗は無視する。
    }
  }
});

/**
 * 偽 core・偽 endpoint で検証用の組み立てを作る。
 *
 * @param options - 未確定の要求名・表示状態の読み取り口。
 * @returns 検証用の組み立て。
 */
function setupIndependent(options: FixtureOptions = {}): Fixture {
  const pending = options.pending ?? new Set<string>();
  const base = setupFixture([
    makeSession("local-i1", "conn-i"),
    makeSession("local-i2", "conn-i"),
    makeSession("local-i3", "conn-i"),
  ]);
  const manager = new PluginInstanceManager(base.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  manager.register(betaDescriptor({ assignment: firstFitPolicy(null) }));
  const alpha1 = manager.assign("alpha");
  const alpha2 = manager.assign("alpha");
  const beta = manager.assign("beta");
  const endpointsByInstance = new Map<string, GatedEndpoint[]>();
  const factoryCalls = { count: 0 };
  const factory: ErasedEndpointFactory = (ref, emission) => {
    factoryCalls.count += 1;
    const endpoint = new GatedEndpoint(ref, emission, pending);
    const list = endpointsByInstance.get(endpoint.boundInstance) ?? [];
    list.push(endpoint);
    endpointsByInstance.set(endpoint.boundInstance, list);
    return endpoint;
  };
  const registry = new PluginCompanionRegistry();
  registry.register(
    {
      kind: "alpha",
      label: "独立α",
      viewEntry: "index.html",
      viewPath: "views://plugin-alpha/index.html",
    },
    factory,
  );
  registry.register(
    {
      kind: "beta",
      label: "独立β",
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
  let nowMs = 0;
  let view: AdoptedPluginView = { instanceId: null, viewGeneration: 0 };
  const viewSource =
    options.viewSource ??
    ((): AdoptedPluginView => {
      return { ...view };
    });
  const coordinator = new PluginUiCoordinator(
    7,
    { notifyExternalChange: () => {} },
    createChannel,
    () => nowMs,
    registry,
    manager,
    viewSource,
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
    factoryCalls,
    setNow: (value) => {
      nowMs = value;
    },
    setView: (instanceId, viewGeneration) => {
      view = { instanceId, viewGeneration };
    },
    endpointsFor: (instanceId) => endpointsByInstance.get(instanceId) ?? [],
  };
}

/**
 * 配置待ちの1件を本番と同じ条件で結線する。
 *
 * @param fixture - 検証用の組み立て。
 * @returns 結線したマウント識別子。
 */
function bindFirstPending(fixture: Fixture): string {
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(7, placement.initialUrl);
  fixture.views.push(view);
  if (!fixture.coordinator.handleTagCreated(view)) throw new Error("生成を消費できなかった。");
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
function show(fixture: Fixture, instanceId: string, generation: number): string {
  fixture.setView(instanceId, generation);
  fixture.coordinator.syncNow();
  return bindFirstPending(fixture);
}

/**
 * 個体の計数を読む。
 *
 * @param fixture - 検証用の組み立て。
 * @param instanceId - 読む個体。
 * @returns 計数。
 */
function countOf(fixture: Fixture, instanceId: string): number {
  const instance = fixture.core.instances.get(instanceId);
  if (instance === undefined) throw new Error("個体が無い。");
  return (instance.getState() as { count: number }).count;
}

/**
 * 中継口を得る。
 *
 * @param fixture - 検証用の組み立て。
 * @param mountId - マウント識別子。
 * @returns 当該マウントに閉じ込めた中継口。
 */
function relayOf(fixture: Fixture, mountId: string): PluginRelayHandler {
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  return relay;
}

/**
 * 試験用のバックエンドを生成する。待ち受けは空きポート自動選択である。
 *
 * @returns 起動したバックエンド。
 */
async function startBackend(): Promise<GuiBackend> {
  const backend = await GuiBackend.create({ port: 0 });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  return backend;
}

/** マイクロタスクとタイマーを一巡させる。 */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ */
/* 1. 表示世代の所有権を main に統一                                   */
/* ------------------------------------------------------------------ */

test("世代は一巡してもゼロへ戻らず単調である", async () => {
  const backend = await startBackend();
  const seen: number[] = [backend.getPluginView().viewGeneration];
  // 採用（対象替わり）と管理画面遷移の終了を交互に60回重ねる。
  for (let round = 0; round < 60; round += 1) {
    const adopted = backend.setPluginView({
      instanceId: `instance-${round % 3}`,
      baseViewGeneration: backend.getPluginView().viewGeneration,
    });
    expect(adopted.adopted).toBe(true);
    seen.push(backend.getPluginView().viewGeneration);
    seen.push(backend.endPluginViewForNavigation().viewGeneration);
  }
  expect(seen).toHaveLength(121);
  for (let index = 1; index < seen.length; index += 1) {
    expect(seen[index]).toBe((seen[index - 1] ?? 0) + 1);
    expect(seen[index]).toBeGreaterThan(0);
  }
  expect(backend.getPluginView()).toEqual({ instanceId: null, viewGeneration: 120 });
});

test("高い世代のリロード後は観測世代との一致で一発採用される", async () => {
  const backend = await startBackend();
  for (let round = 0; round < 45; round += 1) {
    backend.setPluginView({
      instanceId: round % 2 === 0 ? "instance-x" : null,
      baseViewGeneration: backend.getPluginView().viewGeneration,
    });
  }
  expect(backend.getPluginView().viewGeneration).toBe(45);
  // リロード相当。main が無し・新世代へ進める。
  const afterReload = backend.endPluginViewForNavigation();
  expect(afterReload).toEqual({ instanceId: null, viewGeneration: 46 });
  // リロード後の画面は snapshot の採用済み世代を基準に一発で採用される。
  const recovered = backend.setPluginView({
    instanceId: "instance-x",
    baseViewGeneration: afterReload.viewGeneration,
  });
  expect(recovered).toEqual({
    adopted: true,
    current: { instanceId: "instance-x", viewGeneration: 47 },
  });
  // 一発で足りている（追試行が要らない）ことを、同じ基準が stale になることで示す。
  const again = backend.setPluginView({
    instanceId: "instance-x",
    baseViewGeneration: afterReload.viewGeneration,
  });
  expect(again.adopted).toBe(false);
  expect(again.current).toEqual({ instanceId: "instance-x", viewGeneration: 47 });
});

test("stale は snapshot を変えず現在の採用済み値を返す", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 0 }).adopted).toBe(
    true,
  );
  const current = backend.getPluginView();
  expect(current).toEqual({ instanceId: "instance-a", viewGeneration: 1 });
  for (const params of [
    { instanceId: null, baseViewGeneration: 0 },
    { instanceId: "instance-b", baseViewGeneration: 0 },
    { instanceId: "instance-b", baseViewGeneration: 2 },
    { instanceId: "instance-b", baseViewGeneration: 99 },
    { instanceId: "instance-a", baseViewGeneration: 99 },
  ]) {
    const result = backend.setPluginView(params);
    expect(result.adopted).toBe(false);
    // 現在の採用済み対象・世代を返す（RPC 成功と採用を混同しない）。
    expect(result.current).toEqual(current);
    expect(backend.getPluginView()).toEqual(current);
    expect(backend.getSnapshot().pluginView).toEqual(current);
  }
});

test("A→無し→A と A→B→A はそれぞれ新しい表示期間になる", async () => {
  const backend = await startBackend();
  const track: AdoptedPluginView[] = [];
  const apply = (instanceId: string | null): void => {
    const result = backend.setPluginView({
      instanceId,
      baseViewGeneration: backend.getPluginView().viewGeneration,
    });
    expect(result.adopted).toBe(true);
    track.push(result.current);
  };
  apply("A");
  apply(null);
  apply("A");
  apply("B");
  apply("A");
  expect(track).toEqual([
    { instanceId: "A", viewGeneration: 1 },
    { instanceId: null, viewGeneration: 2 },
    { instanceId: "A", viewGeneration: 3 },
    { instanceId: "B", viewGeneration: 4 },
    { instanceId: "A", viewGeneration: 5 },
  ]);
});

test("基準と対象がいずれも一致する要求では世代を進めない", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "A", baseViewGeneration: 0 }).adopted).toBe(true);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = backend.setPluginView({ instanceId: "A", baseViewGeneration: 1 });
    expect(result.adopted).toBe(false);
    expect(result.current).toEqual({ instanceId: "A", viewGeneration: 1 });
  }
  expect(backend.getPluginView()).toEqual({ instanceId: "A", viewGeneration: 1 });
});

test("本物の状態通知経路で世代切替が待ちの子を外し遅れた完了は失効として返る", async () => {
  // 世代の SSoT は本物の `GuiBackend`、個体管理・endpoint は検証用の偽で
  // 組み、本番と同じ「状態通知 → `syncNow`」の配線だけで追随させる。
  const backend = await startBackend();
  const fixture = setupIndependent({
    pending: new Set(["slow"]),
    viewSource: () => backend.getPluginView(),
  });
  backend.onStateChanged(() => {
    fixture.coordinator.syncNow();
  });

  // 表示対象を本物の backend で採用する。
  const adopted = backend.setPluginView({
    instanceId: fixture.alpha1,
    baseViewGeneration: 0,
  });
  expect(adopted.adopted).toBe(true);
  await drain();
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.viewGeneration).toBe(1);
  const view = new FakeView(7, placement.initialUrl);
  if (!fixture.coordinator.handleTagCreated(view)) throw new Error("生成を消費できなかった。");
  const relay = relayOf(fixture, placement.mountId);
  const endpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (endpoint === undefined) throw new Error("endpoint が無い。");

  // 未確定の要求を掛けてから、main 側で表示期間を終了する。
  const inFlight = relay({ method: "slow", params: {} });
  await drain();
  expect(endpoint.calls).toHaveLength(1);
  const ended = backend.endPluginViewForNavigation();
  expect(ended.viewGeneration).toBe(2);
  // 本番の配線（状態通知 → `syncNow`）だけで対応付けが外れる。
  await drain();
  expect(fixture.coordinator.size).toBe(0);
  expect(endpoint.disposed).toBe(true);
  expect(view.removed).toBe(true);

  // 遅れて完了しても正常値を返さず、`pluginResponded` も立てない。
  endpoint.resolveGates({ value: "late" });
  const result = await inFlight;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  expect(fixture.coordinator.listPlacements()).toHaveLength(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  expect(countOf(fixture, fixture.alpha1)).toBe(0);

  // 新しい表示期間の子へは届かない（対照として新しい子は普通に動く）。
  const next = backend.setPluginView({
    instanceId: fixture.alpha1,
    baseViewGeneration: backend.getPluginView().viewGeneration,
  });
  expect(next.adopted).toBe(true);
  await drain();
  const nextPlacement = fixture.coordinator.listPlacements()[0];
  if (nextPlacement === undefined) throw new Error("配置が無い。");
  expect(nextPlacement.mountId).not.toBe(placement.mountId);
  const nextView = new FakeView(7, nextPlacement.initialUrl);
  if (!fixture.coordinator.handleTagCreated(nextView)) {
    throw new Error("生成を消費できなかった。");
  }
  const nextEndpoint = fixture.endpointsFor(fixture.alpha1).at(-1);
  if (nextEndpoint === undefined) throw new Error("endpoint が無い。");
  expect(nextEndpoint.calls).toHaveLength(0);
  const ok = await relayOf(fixture, nextPlacement.mountId)({ method: "add", params: { delta: 4 } });
  expect(ok.ok).toBe(true);
  expect(countOf(fixture, fixture.alpha1)).toBe(4);
  expect(fixture.coordinator.listPlacements()[0]?.mountId).toBe(nextPlacement.mountId);
  // 旧 endpoint の通知は新しい子へ届かない。
  endpoint.notify({ n: 99 });
  expect(fixture.pushes.get(nextPlacement.mountId)).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* 2. navigationRules の静的登録との照合                               */
/* ------------------------------------------------------------------ */

test("遷移規則の照合は順序付き完全一致で内部空白は許さない", () => {
  const expected = buildPluginNavigationRules([
    "views://plugin-alpha/index.html",
    "views://plugin-beta/index.html",
  ]);
  // 実表現の配列を中心に受け付け、JSON 文字列形も互換として受け付ける。
  const accepted: readonly unknown[] = [
    [...expected],
    expected.map((rule) => `  ${rule}  `),
    expected.map((rule) => `\t${rule}\n`),
    JSON.stringify(expected),
    JSON.stringify(expected.map((rule) => `  ${rule}  `)),
    JSON.stringify(expected.map((rule) => `\t${rule}\n`)),
  ];
  for (const actual of accepted) {
    expect(matchPluginNavigationRules(actual, expected)).toBe(true);
  }
  const rejected: readonly unknown[] = [
    null,
    undefined,
    42,
    "",
    "{not-json",
    "null",
    "42",
    JSON.stringify({ allow: "*" }),
    expected.slice(0, -1),
    [...expected, "views://evil/*"],
    [...expected].reverse(),
    expected.map(() => expected[0] ?? ""),
    [42],
    [expected[0], [expected[1]]],
    JSON.stringify(expected.slice(0, -1)),
    JSON.stringify([...expected, "views://evil/*"]),
    JSON.stringify([...expected].reverse()),
    JSON.stringify(expected.map(() => expected[0] ?? "")),
    JSON.stringify([42]),
    JSON.stringify([expected[0], [expected[1]]]),
    // 前後の空白だけを許すため、内部の空白差は不一致である。
    expected.map((rule) => rule.replace("://", ":// ")),
    JSON.stringify(expected.map((rule) => rule.replace("://", ":// "))),
  ];
  for (const actual of rejected) {
    expect(matchPluginNavigationRules(actual, expected)).toBe(false);
  }
});

test("静的登録の外から来た規則は endpoint 工場を1度も呼ばずに回収する", () => {
  const fixture = setupIndependent();
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  // 子が「自分が見ている scope だけ」を規則として申告した形を再現する（実表現の配列）。
  const childClaim = buildPluginNavigationRules(["views://plugin-alpha/index.html"]);
  const sneaky = new FakeView(7, placement.initialUrl, {
    navigationRules: [...childClaim],
  });
  fixture.views.push(sneaky);
  expect(fixture.coordinator.handleTagCreated(sneaky)).toBe(true);
  expect(sneaky.removed).toBe(true);
  expect(sneaky.loaded).toHaveLength(0);
  expect(fixture.factoryCalls.count).toBe(0);
  expect(fixture.endpointsFor(fixture.alpha1)).toHaveLength(0);
  expect(fixture.coordinator.size).toBe(0);
  const failures = fixture.coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.viewGeneration).toBe(1);
  expect(failures[0]?.reason).toContain("遷移規則");
  // 同一表示期間では自動で作り直さない。
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.factoryCalls.count).toBe(0);
});

test("正規の規則では endpoint 工場が1回だけ呼ばれて結線する", () => {
  const fixture = setupIndependent();
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.factoryCalls.count).toBe(0);
  const mountId = bindFirstPending(fixture);
  expect(fixture.factoryCalls.count).toBe(1);
  expect(fixture.relays.get(mountId)).not.toBeUndefined();
  expect(fixture.views[0]?.loaded).toHaveLength(1);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* 3. 非同期完了の生存再照合                                           */
/* ------------------------------------------------------------------ */

test("await 中の全体破棄後の完了は正常値を返さずpluginRespondedも立てない", async () => {
  const fixture = setupIndependent({ pending: new Set(["slow"]) });
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  const endpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (endpoint === undefined) throw new Error("endpoint が無い。");
  const inFlight = relay({ method: "slow", params: {} });
  await drain();
  // 管理画面の遷移掃除に相当する全体破棄を行う。
  fixture.coordinator.resetAll("管理画面の遷移");
  expect(fixture.coordinator.size).toBe(0);
  expect(endpoint.disposed).toBe(true);
  endpoint.resolveGates({ value: "late" });
  const result = await inFlight;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  expect(fixture.coordinator.listPlacements()).toHaveLength(0);
  expect(countOf(fixture, fixture.alpha1)).toBe(0);
});

test("await 中の期限切れ後の完了は正常値を返さず失敗表示にだけ残る", async () => {
  const fixture = setupIndependent({ pending: new Set(["slow"]) });
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  const endpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (endpoint === undefined) throw new Error("endpoint が無い。");
  const inFlight = relay({ method: "slow", params: {} });
  await drain();
  fixture.setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  endpoint.resolveGates({ value: "late" });
  const result = await inFlight;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("unmounted");
  // 失敗表示は残るが、配置は復活せず応答済みにもならない。
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.listPlacements()).toHaveLength(0);
  expect(endpoint.disposed).toBe(true);
});

test("同一要求の再送は旧マウントの完了を新マウントへ付け替えない", async () => {
  const fixture = setupIndependent({ pending: new Set(["slow"]) });
  const first = show(fixture, fixture.alpha1, 1);
  const relayFirst = relayOf(fixture, first);
  const firstEndpoint = fixture.endpointsFor(fixture.alpha1)[0];
  if (firstEndpoint === undefined) throw new Error("endpoint が無い。");
  const inFlight = relayFirst({ method: "slow", params: {} });
  await drain();
  // 世代を進めて新子を作る。
  fixture.setView(fixture.alpha1, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const second = bindFirstPending(fixture);
  const secondEndpoint = fixture.endpointsFor(fixture.alpha1)[1];
  if (secondEndpoint === undefined) throw new Error("endpoint が無い。");
  const pushesSecond = fixture.pushes.get(second) ?? [];
  firstEndpoint.resolveGates({ n: 1 });
  const late = await inFlight;
  expect(late.ok).toBe(false);
  if (!late.ok) expect(late.error.code).toBe("unmounted");
  // 新マウントには要求も通知も届かない。
  expect(secondEndpoint.calls).toHaveLength(0);
  expect(pushesSecond).toHaveLength(0);
  expect(countOf(fixture, fixture.alpha1)).toBe(0);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(false);
  // 対照として新マウントは普通に動く。
  const ok = await relayOf(fixture, second)({ method: "add", params: { delta: 2 } });
  expect(ok.ok).toBe(true);
  expect(countOf(fixture, fixture.alpha1)).toBe(2);
  expect(fixture.coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
  // 旧 endpoint の通知は新しい子へ届かない（対照の後に送る）。
  firstEndpoint.notify({ n: 99 });
  expect(fixture.pushes.get(second)).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* 4. 失敗抑止を表示期間（世代＋対象）単位へ                           */
/* ------------------------------------------------------------------ */

test("同一表示期間では再生成せず明示再試行は世代を維持し再表示では一度だけ生成する", () => {
  const fixture = setupIndependent();
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  const first = fixture.coordinator.listPlacements()[0];
  if (first === undefined) throw new Error("配置が無い。");
  const bad = new FakeView(7, first.initialUrl, { renderer: "webgl" });
  expect(fixture.coordinator.handleTagCreated(bad)).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  // 生成条件の段で戻すため endpoint 工場には達しない。
  expect(fixture.factoryCalls.count).toBe(0);
  // 同一表示期間では自動再生成しない。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(fixture.coordinator.syncNow()).toBe(false);
  }
  expect(fixture.factoryCalls.count).toBe(0);
  // 明示再試行では世代を維持し mountId だけ替える。
  expect(fixture.coordinator.retryFailed(fixture.alpha1)).toEqual({ ok: true });
  const retried = fixture.coordinator.listPlacements()[0];
  if (retried === undefined) throw new Error("配置が無い。");
  expect(retried.mountId).not.toBe(first.mountId);
  expect(retried.viewGeneration).toBe(1);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  // 再試行後の結線は工場を1回だけ呼ぶ。
  bindFirstPending(fixture);
  expect(fixture.factoryCalls.count).toBe(1);
  // 新しい表示期間（新世代）では一度だけ生成する。
  fixture.coordinator.resetAll("試験");
  fixture.setView(fixture.alpha1, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.listPlacements()).toHaveLength(1);
  expect(fixture.coordinator.listPlacements()[0]?.viewGeneration).toBe(2);
  bindFirstPending(fixture);
  expect(fixture.factoryCalls.count).toBe(2);
  expect(fixture.coordinator.syncNow()).toBe(false);
});

test("失敗抑止は世代と対象の組で区切られ他個体・別世代へは及ばない", () => {
  const fixture = setupIndependent();
  /** 現在の表示対象を生成条件の不一致で失敗させる。 */
  const failCurrent = (instanceId: string): string => {
    fixture.setView(instanceId, 1);
    fixture.coordinator.syncNow();
    const placement = fixture.coordinator.listPlacements()[0];
    if (placement === undefined) throw new Error("配置が無い。");
    const view = new FakeView(7, placement.initialUrl, { sandbox: true });
    expect(fixture.coordinator.handleTagCreated(view)).toBe(true);
    return placement.mountId;
  };
  const firstAlpha1 = failCurrent(fixture.alpha1);
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  // 同じ世代でも対象が違えば別の表示期間であり、抑止しない。
  const alpha2Mount = failCurrent(fixture.alpha2);
  expect(alpha2Mount).not.toBe(firstAlpha1);
  expect(fixture.coordinator.listFailures()).toHaveLength(2);
  // どちらの個体も同一表示期間では抑止される。
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.syncNow()).toBe(false);
  fixture.setView(fixture.alpha2, 1);
  expect(fixture.coordinator.syncNow()).toBe(false);
  expect(fixture.coordinator.size).toBe(0);
  // 再試行は指定個体の失敗だけを消し、他個体の抑止は残す。
  fixture.setView(fixture.alpha1, 1);
  expect(fixture.coordinator.retryFailed(fixture.alpha1)).toEqual({ ok: true });
  expect(fixture.coordinator.listFailures()).toHaveLength(1);
  expect(fixture.coordinator.listFailures()[0]?.instanceId).toBe(fixture.alpha2);
  expect(fixture.coordinator.size).toBe(1);
  // 他個体はまだ抑止されている（外れるのは表示中の alpha1 の子だけ）。
  fixture.setView(fixture.alpha2, 1);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  // 別世代では抑止が及ばず、一度生成する。旧世代の失敗は新しい表示期間の
  // 採用時に剪定されるため、失敗表示は残らない（個体ごとに最新のみ）。
  fixture.setView(fixture.alpha2, 2);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(1);
  expect(fixture.coordinator.listPlacements()[0]?.viewGeneration).toBe(2);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* 5. 前回検証した境界の維持                                           */
/* ------------------------------------------------------------------ */

test("配送先固定・失効の分離・資源の回収は修正後も維持される", async () => {
  const fixture = setupIndependent();
  const mountId = show(fixture, fixture.alpha1, 1);
  const relay = relayOf(fixture, mountId);
  // payload で別個体を騙っても束縛個体へ届く。
  const forwarded = await relay({
    method: "add",
    params: { delta: 7, instanceId: fixture.beta, kind: "beta" },
  });
  expect(forwarded.ok).toBe(true);
  expect(countOf(fixture, fixture.alpha1)).toBe(7);
  // 束縛していない beta 個体は状態も触られない。
  expect(fixture.core.instances.get(fixture.beta)?.getState()).toEqual({ label: "" });
  expect(fixture.endpointsFor(fixture.beta)).toHaveLength(0);
  // 業務に無い要求も失効にせず、不透明な正常応答として返る。
  const opaque = await relay({ method: "unknown-op", params: {} });
  expect(opaque.ok).toBe(true);
  if (opaque.ok) expect(opaque.value).toEqual({ ok: true, echo: "unknown-op" });
  expect(fixture.coordinator.isLive(mountId)).toBe(true);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  // 束縛の失効は main 自身の照合で決まる。
  fixture.manager.unassign("alpha", fixture.alpha1);
  const revoked = await relay({ method: "add", params: { delta: 1 } });
  expect(revoked.ok).toBe(false);
  if (!revoked.ok) expect(revoked.error.code).toBe("unmounted");
  expect(fixture.core.instances.has(fixture.alpha1)).toBe(false);
  expect(fixture.coordinator.syncNow()).toBe(true);
  expect(fixture.coordinator.size).toBe(0);
  expect(fixture.coordinator.listFailures()).toHaveLength(0);
  // 個体・Session を作り増さず、必要な分だけ回収する。
  expect(fixture.core.countCalls("createInstance")).toBe(3);
  expect(fixture.core.countCalls("removeInstance")).toBe(1);
  expect(fixture.sessions.stops).toBe(0);
});

test("main の汎用層は撤去した共有口と種別固有名を参照しない", () => {
  const mainDir = fileURLToPath(new URL("../src/main/", import.meta.url));
  const files = readdirSync(mainDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  expect(files.length).toBeGreaterThan(5);
  const forbidden = [
    "bridge-plugin-text",
    "bridge-plugin-udp",
    "bridge-plugin-diagnostic",
    "projectView",
    "toSnapshot",
    "readSnapshot",
    "pushMessageName",
    "buildRequestHandlers",
  ];
  const offenders: string[] = [];
  for (const name of files) {
    const lines = readFileSync(join(mainDir, name), "utf8")
      .split("\n")
      // 宣言文（「持たない」等の説明）は対象外とし、コード行だけを見る。
      .filter((line) => {
        const head = line.trimStart();
        return !head.startsWith("*") && !head.startsWith("//") && !head.startsWith("/*");
      });
    const source = lines.join("\n");
    for (const token of forbidden) {
      if (source.includes(token)) offenders.push(`${name}: ${token}`);
    }
  }
  expect(offenders).toEqual([]);
});
