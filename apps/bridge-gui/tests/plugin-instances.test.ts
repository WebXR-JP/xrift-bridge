/**
 * 段1の個体別 DTO／限定操作／射影の検証。
 *
 * 偽の backend・偽の生存照合で対応付けの振る舞いだけを確かめ、
 * 実バックエンドでは束縛送信の委譲と診断統計の射影を通す。
 * 管理操作・他個体・失効した対応付けには到達・取得できないこと、
 * 古い revision で巻き戻さないことを保証する。
 * 比較コード本文・送信本文は記録に残さない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import {
  DIAGNOSTIC_PORT_ID,
  TEXT_PORT_ID,
  TEXT_SESSION_ID,
  type DiagnosticStats,
  type PluginInstanceHandle,
  type TextPluginOperations,
  type TextPluginState,
  type TextSendResult,
} from "bridge-app-core";
import { createConnectionRequest, type SessionProvider } from "world-client";
import {
  projectDiagnosticInstanceView,
  projectTextInstanceView,
  GuiBackend,
} from "../src/main/backend.ts";
import {
  asMountLiveness,
  buildDiagnosticRequestHandlers,
  buildTextRequestHandlers,
  PluginInstanceBinder,
  type InstanceProjectionBackend,
} from "../src/main/plugin-instances.ts";
import {
  PluginMountManager,
  type MountChildView,
  type SpikeChannelFactory,
} from "../src/main/plugin-mounts.ts";
import type {
  DiagnosticInstanceView,
  TextInstanceChangedMessage,
  TextInstanceSnapshot,
  TextInstanceView,
} from "../src/shared/plugin-instance.ts";
import { selectNewerInstanceSnapshot } from "../src/shared/plugin-instance.ts";

/** 送信に使うダミー本文。表示・記録に残らないことを確かめる目印である。 */
const DUMMY_TEXT = "ダミー本文-表示に残さない-101";

/** テキスト個体の限定表示の雛形。検証対象は対応付けの照合のみである。 */
const TEXT_VIEW: TextInstanceView = {
  instanceId: "instance-1",
  pluginId: "text",
  portId: "text",
  localSessionId: "local-1",
  canSend: true,
  pendingId: null,
  lastResult: null,
  stats: { attempts: 0, acknowledged: 0, unknown: 0 },
};

/** 診断個体の限定表示の雛形。 */
const DIAGNOSTIC_VIEW: DiagnosticInstanceView = {
  instanceId: "instance-2",
  pluginId: "diagnostic",
  portId: "diagnostic",
  localSessionId: "local-2",
  stats: { diagnosticEcho: 0, diagnosticPing: 0 },
};

/**
 * 検証用の偽 backend。束縛個体の有無と現割当ての失効だけを再現する。
 *
 * 識別子は `main` の対応付けが決める前提であり、子からの指定では
 * 振り向かない（渡された識別子で写像を引くのみ）。
 */
class FakeProjectionBackend implements InstanceProjectionBackend {
  private readonly textViews = new Map<string, TextInstanceView>();
  private readonly textSent = new Map<string, string[]>();
  private readonly diagnosticViews = new Map<string, DiagnosticInstanceView>();
  private readonly lapsed = new Set<string>();

  addText(view: TextInstanceView): void {
    this.textViews.set(view.instanceId, view);
    this.textSent.set(view.instanceId, []);
  }

  addDiagnostic(view: DiagnosticInstanceView): void {
    this.diagnosticViews.set(view.instanceId, view);
  }

  /** 現割当てを失効させる。以後の射影・送信は拒否する。 */
  lapse(instanceId: string): void {
    this.lapsed.add(instanceId);
  }

  /** 束縛個体へ委譲された本文の一覧。 */
  sentTextsOf(instanceId: string): readonly string[] {
    return this.textSent.get(instanceId) ?? [];
  }

  getTextInstanceView(params: { instanceId: unknown }): TextInstanceView {
    if (typeof params.instanceId !== "string") {
      throw new RangeError("instanceId は空でない文字列であること。");
    }
    const view = this.textViews.get(params.instanceId);
    if (view === undefined || this.lapsed.has(view.instanceId)) {
      throw new RangeError("束縛したテキスト個体ではない。");
    }
    return view;
  }

  sendTextForInstance(instanceId: unknown, params: { text: unknown }): Promise<TextSendResult> {
    if (typeof instanceId !== "string") {
      return Promise.reject(new RangeError("instanceId は空でない文字列であること。"));
    }
    const view = this.textViews.get(instanceId);
    if (view === undefined || this.lapsed.has(view.instanceId)) {
      return Promise.reject(new RangeError("束縛したテキスト個体ではない。"));
    }
    if (typeof params.text !== "string") {
      return Promise.reject(new RangeError("text は文字列であること。"));
    }
    this.textSent.get(view.instanceId)?.push(params.text);
    return Promise.resolve({ status: "acknowledged", id: "text-1" });
  }

  getDiagnosticInstanceView(params: { instanceId: unknown }): DiagnosticInstanceView {
    if (typeof params.instanceId !== "string") {
      throw new RangeError("instanceId は空でない文字列であること。");
    }
    const view = this.diagnosticViews.get(params.instanceId);
    if (view === undefined || this.lapsed.has(view.instanceId)) {
      throw new RangeError("束縛した診断個体ではない。");
    }
    return view;
  }
}

/** 検証用の組み立て。生存集合への出し入れで破棄を再現する。 */
function setup(): {
  backend: FakeProjectionBackend;
  live: Set<string>;
  binder: PluginInstanceBinder;
} {
  const backend = new FakeProjectionBackend();
  const live = new Set<string>();
  const binder = new PluginInstanceBinder({ isLive: (mountId) => live.has(mountId) }, backend);
  return { backend, live, binder };
}

/** テキスト・診断を1件ずつ束縛した組み立て。 */
function bindBoth(): {
  backend: FakeProjectionBackend;
  live: Set<string>;
  binder: PluginInstanceBinder;
} {
  const assembled = setup();
  assembled.backend.addText(TEXT_VIEW);
  assembled.backend.addDiagnostic(DIAGNOSTIC_VIEW);
  assembled.live.add("spike-1");
  assembled.live.add("spike-2");
  assembled.binder.bindTextMount("spike-1", TEXT_VIEW.instanceId);
  assembled.binder.bindDiagnosticMount("spike-2", DIAGNOSTIC_VIEW.instanceId);
  return assembled;
}

/** 検証用の偽子画面。生存照合の入力に使う。 */
class FakeView implements MountChildView {
  removed = false;
  constructor(
    readonly viewId: number,
    readonly hostWebviewId: number | undefined,
    readonly renderer = "native",
    readonly sandbox = false,
    readonly preload: string | null = null,
    readonly navigationRules: string | null = null,
    readonly currentUrl: string | null = null,
  ) {}
  loadSpikeUrl(_url: string): void {}
  removeView(): void {
    this.removed = true;
  }
}

test("子画面の要求口に管理操作が無い", () => {
  const { binder } = bindBoth();
  const surface = binder as unknown as Record<string, unknown>;
  // 対応付け層自体に管理操作の口が無い。
  for (const name of [
    "enableAcceptance",
    "disableAcceptance",
    "getPairingView",
    "approvePairing",
    "rejectPairing",
    "disconnectConnection",
    "assignDiagnostics",
    "assignText",
    "unassignText",
    "quit",
    "spikeCreate",
    "spikeDestroy",
    "spikePush",
    "spikeList",
    "spikeReset",
    "getSnapshot",
  ]) {
    expect(surface[name]).toBeUndefined();
  }
  // 子画面が呼べる要求は限定口だけである。
  expect(Object.keys(buildTextRequestHandlers("spike-1", binder)).sort()).toEqual([
    "getTextState",
    "sendText",
  ]);
  expect(Object.keys(buildDiagnosticRequestHandlers("spike-2", binder))).toEqual([
    "getDiagnosticState",
  ]);
});

test("束縛した個体以外の情報を取得できない", () => {
  const { binder } = bindBoth();
  const text = binder.handleGetTextState("spike-1");
  expect(text.instanceId).toBe(TEXT_VIEW.instanceId);
  expect(text.localSessionId).toBe(TEXT_VIEW.localSessionId);
  const diagnostic = binder.handleGetDiagnosticState("spike-2");
  expect(diagnostic.instanceId).toBe(DIAGNOSTIC_VIEW.instanceId);
  // 種別外の口では取れない（テキスト束縛で診断取得・逆も拒否）。
  expect(() => binder.handleGetDiagnosticState("spike-1")).toThrow(RangeError);
  expect(() => binder.handleGetTextState("spike-2")).toThrow(RangeError);
  expect(() => binder.handleSendText("spike-2", DUMMY_TEXT)).toThrow(RangeError);
  // 取得に識別子の指定口は無く、自分の個体だけが返る。
  expect(buildTextRequestHandlers("spike-1", binder).getTextState().instanceId).toBe(
    TEXT_VIEW.instanceId,
  );
});

test("失効したマウントの要求を拒否する", () => {
  const { live, binder } = bindBoth();
  // push 口の未登録も拒否する。
  expect(() => binder.pushText("spike-1")).toThrow(RangeError);
  binder.setTextSink("spike-1", () => {});
  // 所有表から消えた（破棄相当）後の要求は全て拒否する。
  live.delete("spike-1");
  expect(() => binder.handleGetTextState("spike-1")).toThrow(RangeError);
  expect(() => binder.handleSendText("spike-1", DUMMY_TEXT)).toThrow(RangeError);
  expect(() => binder.pushText("spike-1")).toThrow(RangeError);
  // 生存側は使える。
  expect(binder.handleGetDiagnosticState("spike-2").instanceId).toBe(DIAGNOSTIC_VIEW.instanceId);
  // 対応付けを外した後も拒否する（購読の残存を使えない）。
  binder.unbindMount("spike-2");
  expect(() => binder.handleGetDiagnosticState("spike-2")).toThrow(RangeError);
  // 未対応付け・空識別子の要求も拒否する。
  expect(() => binder.handleGetTextState("spike-9")).toThrow(RangeError);
  expect(() => binder.pushText("")).toThrow(RangeError);
  expect(() => binder.unbindMount("")).toThrow(RangeError);
});

test("現割当てが失効した要求を拒否する", async () => {
  const { backend, binder } = bindBoth();
  binder.setTextSink("spike-1", () => {});
  backend.lapse(TEXT_VIEW.instanceId);
  // 失効後の取得・送信・push は拒否し、古い割当てへ転送しない。
  expect(() => binder.handleGetTextState("spike-1")).toThrow(RangeError);
  await expect(binder.handleSendText("spike-1", DUMMY_TEXT)).rejects.toThrow(RangeError);
  expect(() => binder.pushText("spike-1")).toThrow(RangeError);
  // 失効した個体への束縛し直しも拒否する。
  binder.unbindMount("spike-1");
  expect(() => binder.bindTextMount("spike-1", TEXT_VIEW.instanceId)).toThrow(RangeError);
});

test("対応付けは結線済みの所有だけを生存とする", () => {
  const factory: SpikeChannelFactory = () => ({ pushState: () => {} });
  const manager = new PluginMountManager(7, factory);
  const liveness = asMountLiveness(manager);
  const dto = manager.createMount();
  // 配置待ちは生存ではない。
  expect(liveness.isLive(dto.mountId)).toBe(false);
  const view = new FakeView(11, 7, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(view);
  expect(liveness.isLive(dto.mountId)).toBe(true);
  manager.destroyMount(dto.mountId);
  expect(liveness.isLive(dto.mountId)).toBe(false);
  expect(liveness.isLive("spike-999")).toBe(false);
});

test("テキスト送信が束縛個体の現割当てに委譲される", async () => {
  const { backend, binder } = bindBoth();
  const handlers = buildTextRequestHandlers("spike-1", binder);
  const result = await handlers.sendText({ text: DUMMY_TEXT });
  expect(result.status).toBe("acknowledged");
  // 束縛個体に委譲され、別個体には届かない。
  expect(backend.sentTextsOf(TEXT_VIEW.instanceId)).toEqual([DUMMY_TEXT]);
  expect(backend.sentTextsOf(DIAGNOSTIC_VIEW.instanceId)).toEqual([]);
  // 余分な識別子を付けても束縛個体に届く（振り分け口は無い）。
  await handlers.sendText({
    text: "ダミー本文-002",
    instanceId: DIAGNOSTIC_VIEW.instanceId,
    localSessionId: "別",
  } as unknown as { text: string });
  expect(backend.sentTextsOf(TEXT_VIEW.instanceId)).toEqual([DUMMY_TEXT, "ダミー本文-002"]);
  expect(backend.sentTextsOf(DIAGNOSTIC_VIEW.instanceId)).toEqual([]);
});

test("push は改訂を進めて当該マウントだけに届く", () => {
  const assembled = setup();
  const firstView: TextInstanceView = { ...TEXT_VIEW, localSessionId: "local-1" };
  const secondView: TextInstanceView = {
    ...TEXT_VIEW,
    instanceId: "instance-3",
    localSessionId: "local-3",
  };
  assembled.backend.addText(firstView);
  assembled.backend.addText(secondView);
  assembled.live.add("spike-1");
  assembled.live.add("spike-2");
  assembled.binder.bindTextMount("spike-1", firstView.instanceId);
  assembled.binder.bindTextMount("spike-2", secondView.instanceId);
  const { binder } = assembled;
  const first: TextInstanceChangedMessage[] = [];
  const second: TextInstanceChangedMessage[] = [];
  binder.setTextSink("spike-1", (message) => {
    first.push(message);
  });
  binder.setTextSink("spike-2", (message) => {
    second.push(message);
  });
  // 初期取得は改訂 0 で、読み取りでは進まない。
  const initial = binder.handleGetTextState("spike-1");
  expect(initial.revision).toBe(0);
  expect(binder.handleGetTextState("spike-1").revision).toBe(0);
  // 当該マウントだけに push が届き、改訂が進む。
  expect(binder.pushText("spike-1")).toEqual({ revision: 1 });
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
  const pushed = first[0];
  if (pushed === undefined) throw new Error("push が届かない。");
  expect(pushed.snapshot.instanceId).toBe(firstView.instanceId);
  expect(pushed.snapshot.revision).toBe(1);
  // 初期取得と更新の競合で古い revision が巻き戻さない。
  expect(selectNewerInstanceSnapshot(pushed.snapshot, initial)).toBe(pushed.snapshot);
});

/** テスト用の表示状態。検証対象は revision の採用規約のみである。 */
function snapshotOf(revision: number): TextInstanceSnapshot {
  return { ...TEXT_VIEW, revision };
}

test("古い revision の個体表示では巻き戻さない", () => {
  expect(selectNewerInstanceSnapshot(null, snapshotOf(0))).toEqual(snapshotOf(0));
  expect(selectNewerInstanceSnapshot(snapshotOf(1), snapshotOf(2)).revision).toBe(2);
  const current = snapshotOf(3);
  expect(selectNewerInstanceSnapshot(current, snapshotOf(3))).toBe(current);
  expect(selectNewerInstanceSnapshot(current, snapshotOf(1))).toBe(current);
  // 診断の表示にも同じ規約が使える。
  const diagnostic: DiagnosticInstanceView = DIAGNOSTIC_VIEW;
  expect(
    selectNewerInstanceSnapshot({ ...diagnostic, revision: 1 }, { ...diagnostic, revision: 2 })
      .revision,
  ).toBe(2);
});

/** 検証用の偽テキスト参照。射影の入力に使う。 */
function fakeTextHandle(
  instanceId: string,
  state: TextPluginState,
): PluginInstanceHandle<TextPluginState, TextPluginOperations> {
  return {
    instanceId,
    pluginId: "text",
    getState: () => state,
    getOperations: () => ({
      sendText: (_text: string, _localSessionId: string) =>
        Promise.resolve({ status: "acknowledged", id: "text-1" }),
      onStateChanged: (_handler: (state: TextPluginState) => void) => () => {},
    }),
  };
}

/** 検証用の偽診断参照。射影の入力に使う。 */
function fakeDiagnosticHandle(
  instanceId: string,
  stats: DiagnosticStats,
): PluginInstanceHandle<DiagnosticStats> {
  return { instanceId, pluginId: "diagnostic", getState: () => stats };
}

test("個体別射影に管理情報と本文が含まれない", () => {
  const view = projectTextInstanceView(
    fakeTextHandle("instance-1", {
      canSend: true,
      pendingId: "text-1",
      lastResult: null,
      stats: { attempts: 2, acknowledged: 1, unknown: 1 },
    }),
    "local-1",
  );
  // 載せる項目は限定表示だけであり、保留・接続・候補は載せない。
  expect(Object.keys(view).sort()).toEqual([
    "canSend",
    "instanceId",
    "lastResult",
    "localSessionId",
    "pendingId",
    "pluginId",
    "portId",
    "stats",
  ]);
  expect(view.stats).toEqual({ attempts: 2, acknowledged: 1, unknown: 1 });
  const diagnostic = projectDiagnosticInstanceView(
    fakeDiagnosticHandle("instance-9", { diagnosticEcho: 3, diagnosticPing: 5 }),
    "local-9",
  );
  expect(Object.keys(diagnostic).sort()).toEqual([
    "instanceId",
    "localSessionId",
    "pluginId",
    "portId",
    "stats",
  ]);
  expect(diagnostic.stats).toEqual({ diagnosticEcho: 3, diagnosticPing: 5 });
});

const TEST_ORIGIN = "https://gui-instance-test.invalid";

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
  const backend = await GuiBackend.create({ port: 0, allowedOrigins: [TEST_ORIGIN] });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  return backend;
}

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 受付→承認→管理口の解決まで進める。
 *
 * 両方の約束に扱いを付け、未処理の拒否を残さない。
 */
async function approveConnection(backend: GuiBackend): Promise<SessionProvider> {
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({
    endpoint: endpoint.url,
    origin: TEST_ORIGIN,
  });
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  const approved = backend.approvePairing({ requestId: pairing.requestId, code: pairing.code });
  expect(approved.status).toBe("APPROVED");
  const provider = await request.sessionProvider;
  providers.push(provider);
  return provider;
}

test("実バックエンドの束縛送信が現割当てに届く", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const before = backend.getSnapshot().sessions.length;
  const session = await provider.tryCreateSession({
    sessionId: TEXT_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
  // ワールド側の反映確認の応答器を付け、本文は返送しない。
  session.onMessage((payload) => {
    if (typeof payload === "object" && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (record["op"] === "show" && typeof record["id"] === "string") {
        void session.sendReliable({ op: "shown", id: record["id"] });
      }
    }
  });

  const assignment = backend.assignText();
  // 個体別射影は自分の個体だけを返し、管理情報を含めない。
  const view = backend.getTextInstanceView({ instanceId: assignment.instanceId });
  expect(view.instanceId).toBe(assignment.instanceId);
  expect(view.localSessionId).toBe(assignment.localSessionId);
  expect(view.portId).toBe(TEXT_PORT_ID);
  expect(Object.keys(view).sort()).toEqual([
    "canSend",
    "instanceId",
    "lastResult",
    "localSessionId",
    "pendingId",
    "pluginId",
    "portId",
    "stats",
  ]);
  // 他個体の指定では取れない。
  expect(() => backend.getTextInstanceView({ instanceId: "無い" })).toThrow(RangeError);
  expect(() => backend.getTextInstanceView({ instanceId: "" })).toThrow(RangeError);

  // 束縛送信は現割当てに委譲され、反映確認で決着する。本文は射影に残らない。
  const result = await backend.sendTextForInstance(assignment.instanceId, { text: DUMMY_TEXT });
  expect(result.status).toBe("acknowledged");
  await waitForArrival(
    () => backend.getTextInstanceView({ instanceId: assignment.instanceId }).lastResult !== null,
    "反映確認の射影反映",
  );
  expect(
    JSON.stringify(backend.getTextInstanceView({ instanceId: assignment.instanceId })),
  ).not.toContain(DUMMY_TEXT);

  // 解除後は失効として拒否し、古い割当てへ転送しない。
  backend.unassignText();
  expect(() => backend.getTextInstanceView({ instanceId: assignment.instanceId })).toThrow(
    RangeError,
  );
  expect(() => backend.sendTextForInstance(assignment.instanceId, { text: DUMMY_TEXT })).toThrow(
    RangeError,
  );
});

test("実バックエンドの診断射影が自個体の統計だけを返す", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const before = backend.getSnapshot().sessions.length;
  const session = await provider.tryCreateSession({
    sessionId: "gui-instance-diag",
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
  const target = backend.getSnapshot().sessions[before];
  if (target === undefined) throw new Error("生存セッションが無い。");
  const assignment = backend.assignDiagnostics({ localSessionId: target.localSessionId });

  await session.sendReliable({ op: "echo", id: "inst-1", value: "ダミー値" });
  await session.sendReliable({ op: "ping", id: "inst-p1" });
  await waitForArrival(() => {
    const stats = backend.getDiagnosticInstanceView({ instanceId: assignment.instanceId }).stats;
    return stats.diagnosticEcho === 1 && stats.diagnosticPing === 1;
  }, "診断統計の反映");

  const view = backend.getDiagnosticInstanceView({ instanceId: assignment.instanceId });
  expect(view.localSessionId).toBe(target.localSessionId);
  expect(view.portId).toBe(DIAGNOSTIC_PORT_ID);
  expect(Object.keys(view).sort()).toEqual([
    "instanceId",
    "localSessionId",
    "pluginId",
    "portId",
    "stats",
  ]);
  // 他個体・テキスト個体では取れない。
  expect(() => backend.getDiagnosticInstanceView({ instanceId: "無い" })).toThrow(RangeError);
  expect(() => backend.getTextInstanceView({ instanceId: assignment.instanceId })).toThrow(
    RangeError,
  );
});
