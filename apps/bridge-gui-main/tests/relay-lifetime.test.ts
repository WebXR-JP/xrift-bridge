/**
 * 実 backend での寿命・世代失効の独立検証。
 *
 * 本物の `GuiBackend`・本物の UDP endpoint 工場・本物のセッションを使い、
 * 子の破棄がプラグイン本体・Session・UDP ソケットを終了しないこと、
 * 表示を重ねても個体・割当てを作り増さないこと、古い表示世代が
 * backend へ反映されないことを観測する。native 画素観測・実入力は行わない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createSocket } from "node:dgram";
import type { PluginRelayEvent, PluginRelayResult } from "bridge-gui-contract/plugin-instance";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import {
  UDP_RELAY_METHOD_GET_STATE,
  UDP_RELAY_METHOD_START,
  isUdpCompanionSnapshot,
  type UdpCompanionSnapshot,
} from "bridge-plugin-udp/gui-contract";
import { createConnectionRequest, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import type { PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import {
  PluginUiCoordinator,
  type PluginRelayHandler,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";

const TEST_ORIGIN = "https://gui-relay-lifetime-test.invalid";

const backends: GuiBackend[] = [];
const providers: SessionProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

/** 試験用のバックエンドを生成する。待ち受けは空きポート自動選択である。 */
async function startBackend(): Promise<GuiBackend> {
  const backend = await GuiBackend.create(
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  return backend;
}

/**
 * 出来事の到達を待つ。時刻の長さではなく到達で確定する。
 *
 * @param condition - 待ち終える条件。
 * @param what - 失敗時の表示名。
 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 受付→承認まで進める。
 *
 * @param backend - 対象のバックエンド。
 * @returns 承認済みの接続。
 */
async function approveConnection(backend: GuiBackend): Promise<SessionProvider> {
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({ endpoint: endpoint.url, origin: TEST_ORIGIN });
  void request.sessionProvider.catch(() => {});
  const approved = backend.approvePairing({ requestId: (await request.pairingInfo).requestId });
  expect(approved.status).toBe("APPROVED");
  const provider = await request.sessionProvider;
  providers.push(provider);
  return provider;
}

/**
 * 論理名の確実配送・双方向セッションを1件作り、公開を待つ。
 *
 * @param backend - 対象のバックエンド。
 * @param provider - セッションを作る接続。
 * @param sessionId - 作るセッションの論理名。
 */
async function createSession(
  backend: GuiBackend,
  provider: SessionProvider,
  sessionId: string,
): Promise<void> {
  const before = backend.getSnapshot().sessions.length;
  await provider.tryCreateSession({ sessionId, kind: "reliable", direction: "bidirectional" });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
}

/** 検証用の偽子画面。読込み・破棄の事実だけを残す。 */
class FakeView implements PluginUiChildView {
  /** 破棄されたら真。 */
  removed = false;
  /** 読み込んだ URL の記録。 */
  readonly loaded: string[] = [];
  /** 生成の連番。 */
  private static nextId = 11;
  /** native 側の表示識別子。 */
  readonly viewId = FakeView.nextId++;

  /**
   * @param hostWebviewId - 親 Webview の識別子。
   * @param currentUrl - 発行済みの初期 URL。
   * @param navigationRules - 作成時の遷移規則。静的登録の期待規則と一致させる。実表現は配列である。
   */
  constructor(
    readonly hostWebviewId: number | undefined,
    readonly currentUrl: string | null,
    readonly navigationRules: unknown,
  ) {}

  get renderer(): string {
    return "native";
  }

  get sandbox(): boolean {
    return false;
  }

  get preload(): string | null {
    return null;
  }

  loadPluginUrl(url: string): void {
    this.loaded.push(url);
  }

  removeView(): void {
    this.removed = true;
  }
}

/** 検証用の対応付け。本物の backend の登録表と管理層を使う。 */
interface MountFixture {
  readonly coordinator: PluginUiCoordinator;
  readonly relays: Map<string, PluginRelayHandler>;
  readonly pushes: Map<string, PluginRelayEvent[]>;
  readonly views: FakeView[];
  /** 子タグに載せる遷移規則。backend の snapshot から取った期待値（実表現の配列）である。 */
  readonly navigationRules: readonly string[];
}

/**
 * 本物の UDP 登録表・管理層で対応付けを作る。表示要求は実 backend の
 * `pluginView` を正とし、ローカル変数では置き換えない。
 *
 * @param backend - 対象のバックエンド。
 * @returns 検証用の対応付け。
 */
function setupMounts(backend: GuiBackend): MountFixture {
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  const udpEntry = backend.companionRegistry.getEntry("udp");
  if (udpEntry === undefined) throw new Error("UDP の登録が無い。");
  const registry = new PluginCompanionRegistry();
  // backend と同じ静的登録済み view パス集合を写す。遷移規則の期待値が
  // snapshot と一致するための経路である。
  for (const registered of backend.companionRegistry.list()) {
    registry.register(registered.companion, registered.createEndpoint);
  }
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
  const coordinator = new PluginUiCoordinator(
    7,
    { notifyExternalChange: () => {} },
    createChannel,
    Date.now,
    registry,
    manager,
    // 実 backend の表示状態を通す。表示要求源の置き換えはしない。
    () => backend.getPluginView(),
  );
  return {
    coordinator,
    relays,
    pushes,
    views: [],
    navigationRules: [...backend.getSnapshot().pluginNavigationRules],
  };
}

/**
 * 実 backend の表示要求で表示し、結線する。採用応答と世代の進行を確かめる。
 *
 * @param backend - 対象のバックエンド。
 * @param fixture - 検証用の対応付け。
 * @param instanceId - 表示する個体。
 * @returns 結線したマウント識別子。
 */
function show(backend: GuiBackend, fixture: MountFixture, instanceId: string): string {
  const base = backend.getPluginView().viewGeneration;
  const result = backend.setPluginView({ instanceId, baseViewGeneration: base });
  expect(result.adopted).toBe(true);
  expect(result.current).toEqual({ instanceId, viewGeneration: base + 1 });
  fixture.coordinator.syncNow();
  const placement = fixture.coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  // 対応付けは backend の採用済み世代を写す。
  expect(placement.viewGeneration).toBe(backend.getPluginView().viewGeneration);
  const view = new FakeView(7, placement.initialUrl, fixture.navigationRules);
  fixture.views.push(view);
  if (!fixture.coordinator.handleTagCreated(view)) throw new Error("生成を消費できなかった。");
  return placement.mountId;
}

/**
 * 実 backend の表示要求で非表示にして子を破棄する。
 *
 * @param backend - 対象のバックエンド。
 * @param fixture - 検証用の対応付け。
 */
function hide(backend: GuiBackend, fixture: MountFixture): void {
  const base = backend.getPluginView().viewGeneration;
  const result = backend.setPluginView({ instanceId: null, baseViewGeneration: base });
  expect(result.adopted).toBe(true);
  expect(result.current.viewGeneration).toBe(base + 1);
  fixture.coordinator.syncNow();
}

/**
 * 中継口を得る。
 *
 * @param fixture - 検証用の対応付け。
 * @param mountId - マウント識別子。
 * @returns 当該マウントに閉じ込めた中継口。
 */
function relayOf(fixture: MountFixture, mountId: string): PluginRelayHandler {
  const relay = fixture.relays.get(mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  return relay;
}

/**
 * 中継経由で表示用 DTO を読む。
 *
 * @param relay - 中継口。
 * @returns 表示用 DTO。
 */
async function readStateViaRelay(relay: PluginRelayHandler): Promise<UdpCompanionSnapshot> {
  const result: PluginRelayResult = await relay({
    method: UDP_RELAY_METHOD_GET_STATE,
    params: {},
  });
  if (!result.ok) throw new Error(`中継が失敗した: ${result.error.code}`);
  if (!isUdpCompanionSnapshot(result.value)) throw new Error("表示用 DTO の形状が不正である。");
  return result.value;
}

/**
 * 観測専用の endpoint から表示用 DTO を読む。
 *
 * @param endpoint - 束縛個体に限定した観測用 endpoint。
 * @returns 表示用 DTO。
 */
async function readStateViaEndpoint(endpoint: PluginEndpoint): Promise<UdpCompanionSnapshot> {
  const value = await endpoint.handleRequest({
    method: UDP_RELAY_METHOD_GET_STATE,
    params: {},
  });
  if (!isUdpCompanionSnapshot(value)) throw new Error("表示用 DTO の形状が不正である。");
  return value;
}

/**
 * 状態が条件を満たすまで読む。到達で確定する。
 *
 * @param read - 読み取り口。
 * @param predicate - 待ち終える条件。
 * @param what - 失敗時の表示名。
 * @returns 到達した状態。
 */
async function waitForState(
  read: () => Promise<UdpCompanionSnapshot>,
  predicate: (state: UdpCompanionSnapshot) => boolean,
  what: string,
): Promise<UdpCompanionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await read();
    if (predicate(state)) return state;
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 空きポートを1つ得る。使った瞬間に閉じる（競合は試行の範囲とする）。
 *
 * @returns 空きポート番号。
 */
async function freeUdpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createSocket("udp4");
    probe.once("error", (error) => {
      probe.close();
      reject(error);
    });
    probe.bind(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 1件のデータグラムを送る。
 *
 * @param port - 宛先ポート。
 * @param body - 本文。
 */
async function sendDatagram(port: number, body: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sender = createSocket("udp4");
    sender.once("error", (error) => {
      sender.close();
      reject(error);
    });
    sender.send(Buffer.from(body), port, "127.0.0.1", () => {
      sender.close(() => resolve());
    });
  });
}

test("子の破棄で UDP の受信ソケットと本体・Session は終了しない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSession(backend, provider, UDP_SESSION_ID);
  const assignment = backend.assignPlugin({ pluginKind: "udp" });
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  const entry = backend.companionRegistry.getEntry("udp");
  if (entry === undefined) throw new Error("UDP の登録が無い。");
  // 束縛の生存観測専用。読めれば所有段階・現割当てが生きている。
  const probe = entry.createEndpoint(manager.createBoundRef("udp", assignment.instanceId), {
    emit: () => {},
  });
  const readProbe = (): Promise<UdpCompanionSnapshot> => readStateViaEndpoint(probe);
  const fixture = setupMounts(backend);
  try {
    const port = await freeUdpPort();
    // 実 backend の表示要求で子を表示して bind を開始する。
    const first = show(backend, fixture, assignment.instanceId);
    expect(backend.getSnapshot().pluginView).toEqual({
      instanceId: assignment.instanceId,
      viewGeneration: 1,
    });
    const started = await relayOf(
      fixture,
      first,
    )({
      method: UDP_RELAY_METHOD_START,
      params: { bind: { address: "127.0.0.1", port }, allowNonLoopback: false },
    });
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.value).toEqual({ ok: true });
    await waitForState(
      readProbe,
      (state) => state.isRunning && state.boundAddress?.port === port,
      "bind の完了",
    );
    // 子を非表示にして破棄する。backend の表示期間も終了する。
    hide(backend, fixture);
    expect(backend.getSnapshot().pluginView).toEqual({ instanceId: null, viewGeneration: 2 });
    expect(fixture.views[0]?.removed).toBe(true);
    expect(fixture.coordinator.size).toBe(0);
    // 破棄後も本体・ソケットは生きていて受信できる。
    const afterDestroy = await readProbe();
    expect(afterDestroy.isRunning).toBe(true);
    expect(afterDestroy.stats.receivedDatagrams).toBe(0);
    await sendDatagram(port, "after-destroy");
    const received = await waitForState(
      readProbe,
      (state) => state.stats.receivedDatagrams >= 1,
      "破棄後の受信",
    );
    expect(received.boundAddress?.port).toBe(port);
    // 表示を重ねても個体・割当て・Session は増えず、ソケットは生き続ける。
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const mountId = show(backend, fixture, assignment.instanceId);
      const view = await readStateViaRelay(relayOf(fixture, mountId));
      expect(view.isRunning).toBe(true);
      hide(backend, fixture);
    }
    expect(backend.getSnapshot().plugins.instances).toHaveLength(1);
    expect(backend.getSnapshot().plugins.assignments).toHaveLength(1);
    // snapshot の sessions は生存分だけを載せる。残っていることが生存の証拠である。
    expect(backend.getSnapshot().sessions).toHaveLength(1);
    expect(backend.getSnapshot().sessions[0]?.sessionId).toBe(UDP_SESSION_ID);
    expect(manager.listOwned().map((record) => record.instanceId)).toEqual([assignment.instanceId]);
    expect(manager.listOwned()[0]?.phase).toBe("active");
    // 現割当て一致は生存セッションを要する。通れば Session は生きている。
    expect(manager.requireBinding("udp", assignment.instanceId).localSessionId).toBe(
      assignment.localSessionId,
    );
    // 最後の破棄の後も受信でき、個体は終了していない。
    await sendDatagram(port, "after-cycles");
    await waitForState(
      readProbe,
      (state) => state.stats.receivedDatagrams >= 2,
      "反復表示後の受信",
    );
    const final = await readProbe();
    expect(final.isRunning).toBe(true);
    expect(final.phase).toBe("running");
    expect(fixture.views).toHaveLength(6);
    expect(fixture.views.filter((view) => view.removed)).toHaveLength(6);
    expect(fixture.coordinator.size).toBe(0);
    expect(fixture.coordinator.listFailures()).toHaveLength(0);
  } finally {
    fixture.coordinator.dispose();
    probe.dispose();
  }
});

test("一致した基準世代だけを採用しstaleは状態を変更しない", async () => {
  const backend = await startBackend();
  // 初期値は無し・世代0である。
  expect(backend.getSnapshot().pluginView).toEqual({ instanceId: null, viewGeneration: 0 });
  // 一致した基準世代で採用し、世代を一つ進める。
  expect(backend.setPluginView({ instanceId: "instance-9", baseViewGeneration: 0 })).toEqual({
    adopted: true,
    current: { instanceId: "instance-9", viewGeneration: 1 },
  });
  expect(backend.getSnapshot().pluginView).toEqual({
    instanceId: "instance-9",
    viewGeneration: 1,
  });
  // 対象が同じ要求は既に満たされており、世代を進めない。
  expect(backend.setPluginView({ instanceId: "instance-9", baseViewGeneration: 1 })).toEqual({
    adopted: false,
    current: { instanceId: "instance-9", viewGeneration: 1 },
  });
  // 古い基準世代は stale とし、snapshot へ反映しない。
  expect(backend.setPluginView({ instanceId: "instance-7", baseViewGeneration: 0 })).toEqual({
    adopted: false,
    current: { instanceId: "instance-9", viewGeneration: 1 },
  });
  // 未来の基準世代も stale とし、巻き戻し・先取りしない。
  expect(backend.setPluginView({ instanceId: "instance-7", baseViewGeneration: 5 })).toEqual({
    adopted: false,
    current: { instanceId: "instance-9", viewGeneration: 1 },
  });
  expect(backend.getSnapshot().pluginView).toEqual({
    instanceId: "instance-9",
    viewGeneration: 1,
  });
  // 形式外は拒否する。
  expect(() => backend.setPluginView({ instanceId: 1, baseViewGeneration: 1 })).toThrowError(
    RangeError,
  );
  expect(() =>
    backend.setPluginView({ instanceId: "instance-7", baseViewGeneration: -1 }),
  ).toThrowError(RangeError);
  expect(backend.getSnapshot().pluginView).toEqual({
    instanceId: "instance-9",
    viewGeneration: 1,
  });
});
