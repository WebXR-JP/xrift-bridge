/**
 * 個体別 DTO／限定操作／射影の検証。
 *
 * 偽の companion・偽の生存照合で対応付けの振る舞いだけを確かめ、
 * 実バックエンドでは本番 companion 経由の束縛送信の委譲と診断統計の射影を通す。
 * 管理操作・他個体・失効した対応付けには到達・取得できないこと、
 * 古い revision で巻き戻さないことを保証する。
 * 比較コード本文・送信本文は記録に残さない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { DIAGNOSTIC_PORT_ID } from "bridge-plugin-diagnostic";
import { TEXT_PORT_ID, type TextSendResult } from "bridge-plugin-text";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import { DIAGNOSTIC_ECHO_SESSION_ID } from "bridge-plugin-diagnostic/contract";
import { createConnectionRequest, type SessionProvider } from "world-client";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { GuiBackend } from "../src/main/backend.ts";
import { registerBundledPlugins } from "../src/composition/bundled-plugins.ts";
import { PluginInstanceBinder } from "../src/main/plugin-instances.ts";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import type { CompanionRequestEnv, PluginCompanion } from "bridge-gui-plugin-sdk/companion";
import type {
  TextInstanceChangedMessage,
  TextInstanceSnapshot,
  TextInstanceView,
} from "bridge-plugin-text/gui-contract";
import type {
  DiagnosticInstanceSnapshot,
  DiagnosticInstanceView,
} from "bridge-plugin-diagnostic/gui-contract";
import { selectNewerInstanceSnapshot } from "bridge-gui-contract/plugin-instance";

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

/** 検証用の companion 到達先。限定口の capture 前の材料である。 */
interface StubStore {
  readonly views: Map<string, InstanceBaseView>;
  readonly sent: Map<string, unknown[]>;
  readonly lapsed: Set<string>;
}

function stubStore(): StubStore {
  return { views: new Map(), sent: new Map(), lapsed: new Set() };
}

/**
 * 検証用のテキスト companion。到達は capture した材料だけを使う。
 */
function stubTextCompanion(store: StubStore): PluginCompanion {
  return {
    kind: "text",
    label: "テキスト",
    viewPath: "views://plugin-text/index.html",
    listDesired: () => [],
    readView: (instanceId: string) => {
      const view = store.views.get(instanceId);
      if (view === undefined || store.lapsed.has(instanceId)) {
        throw new RangeError("束縛したテキスト個体ではない。");
      }
      return view;
    },
    toSnapshot: (view, revision) => ({ ...(view as TextInstanceView), revision }),
    send: (instanceId: string, params: unknown) => {
      const view = store.views.get(instanceId);
      if (view === undefined || store.lapsed.has(instanceId)) {
        return Promise.reject(new RangeError("束縛したテキスト個体ではない。"));
      }
      // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
      const table = params as { text: unknown };
      if (typeof table.text !== "string") {
        return Promise.reject(new RangeError("text は文字列であること。"));
      }
      store.sent.get(instanceId)?.push(table.text);
      return Promise.resolve({ status: "acknowledged", id: "text-1" });
    },
    pushMessageName: "textStateChanged",
    buildRequestHandlers: (mountId: string, env: CompanionRequestEnv) => ({
      getTextState: () => {
        const snapshot = env.readSnapshot("text", mountId);
        const typed = snapshot as TextInstanceSnapshot;
        env.markReady(mountId);
        return typed;
      },
      sendText: (params: { text: string }) => {
        const result = env.send("text", mountId, params);
        return result as Promise<TextSendResult>;
      },
    }),
  };
}

/**
 * 検証用の診断 companion。到達は capture した材料だけを使う。
 */
function stubDiagnosticCompanion(store: StubStore): PluginCompanion {
  return {
    kind: "diagnostic",
    label: "診断",
    viewPath: "views://plugin-diagnostic/index.html",
    listDesired: () => [],
    readView: (instanceId: string) => {
      const view = store.views.get(instanceId);
      if (view === undefined || store.lapsed.has(instanceId)) {
        throw new RangeError("束縛した診断個体ではない。");
      }
      return view;
    },
    toSnapshot: (view, revision) => ({ ...(view as DiagnosticInstanceView), revision }),
    pushMessageName: "diagnosticStateChanged",
    buildRequestHandlers: (mountId: string, env: CompanionRequestEnv) => ({
      getDiagnosticState: () => {
        const snapshot = env.readSnapshot("diagnostic", mountId);
        const typed = snapshot as DiagnosticInstanceSnapshot;
        env.markReady(mountId);
        return typed;
      },
    }),
  };
}

/** 検証用の組み立て。生存集合への出し入れで破棄を再現する。 */
function setup(): {
  store: StubStore;
  live: Set<string>;
  binder: PluginInstanceBinder;
} {
  const store = stubStore();
  const live = new Set<string>();
  const registry = new PluginCompanionRegistry();
  registry.register(stubTextCompanion(store));
  registry.register(stubDiagnosticCompanion(store));
  const binder = new PluginInstanceBinder({ isLive: (mountId) => live.has(mountId) }, registry);
  return { store, live, binder };
}

/**
 * 対応付けを companion の要求口（本番経路）に結線する試験用の汎用口。
 *
 * 読み・送信は対応付けに委譲する。準備完了の記録は行わない
 * （binder 側に準備完了の保持が無く、対応付けの照合対象外であるため）。
 *
 * @param binder - 読み・送信の委譲先。
 * @returns companion の要求表組み立てに渡す汎用口。
 */
function toRequestEnv(binder: PluginInstanceBinder): CompanionRequestEnv {
  return {
    readSnapshot: (kind, mountId) => binder.readSnapshot(kind, mountId),
    send: (kind, mountId, params) => binder.send(kind, mountId, params),
    markReady: () => {},
  };
}

/** テキスト・診断を1件ずつ束縛した組み立て。 */
function bindBoth(): {
  store: StubStore;
  live: Set<string>;
  binder: PluginInstanceBinder;
} {
  const assembled = setup();
  assembled.store.views.set(TEXT_VIEW.instanceId, TEXT_VIEW);
  assembled.store.views.set(DIAGNOSTIC_VIEW.instanceId, DIAGNOSTIC_VIEW);
  assembled.store.sent.set(TEXT_VIEW.instanceId, []);
  assembled.live.add("plugin-text-1");
  assembled.live.add("plugin-diagnostic-1");
  assembled.binder.bindMount("plugin-text-1", "text", TEXT_VIEW.instanceId);
  assembled.binder.bindMount("plugin-diagnostic-1", "diagnostic", DIAGNOSTIC_VIEW.instanceId);
  return assembled;
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
    "assignPlugin",
    "unassignPlugin",
    "quit",
    "getSnapshot",
  ]) {
    expect(surface[name]).toBeUndefined();
  }
  // 子画面が呼べる要求は限定口だけである。
  const registry = new PluginCompanionRegistry();
  const store = stubStore();
  registry.register(stubTextCompanion(store));
  registry.register(stubDiagnosticCompanion(store));
  const text = registry.get("text");
  const diagnostic = registry.get("diagnostic");
  if (text === undefined || diagnostic === undefined) throw new Error("companion が無い。");
  const env = toRequestEnv(binder);
  expect(Object.keys(text.buildRequestHandlers("plugin-text-1", env)).sort()).toEqual([
    "getTextState",
    "sendText",
  ]);
  expect(Object.keys(diagnostic.buildRequestHandlers("plugin-diagnostic-1", env))).toEqual([
    "getDiagnosticState",
  ]);
});

test("束縛した個体以外の情報を取得できない", () => {
  const { binder } = bindBoth();
  // ADR: `as` を使う理由は、汎用口が種別を問わない `unknown` を返し、試験で
  // 束縛種別の具象表示を取り出すためである。根拠は、対応付けが同一種別の
  // 記述子で読み・付番を対にすることである。
  const text = binder.readSnapshot("text", "plugin-text-1") as TextInstanceSnapshot;
  expect(text.instanceId).toBe(TEXT_VIEW.instanceId);
  expect(text.localSessionId).toBe(TEXT_VIEW.localSessionId);
  const diagnostic = binder.readSnapshot(
    "diagnostic",
    "plugin-diagnostic-1",
  ) as DiagnosticInstanceSnapshot;
  expect(diagnostic.instanceId).toBe(DIAGNOSTIC_VIEW.instanceId);
  // 種別外の口では取れない（テキスト束縛で診断取得・逆も拒否）。
  expect(() => binder.readSnapshot("diagnostic", "plugin-text-1")).toThrow(RangeError);
  expect(() => binder.readSnapshot("text", "plugin-diagnostic-1")).toThrow(RangeError);
  expect(() => binder.send("text", "plugin-diagnostic-1", { text: DUMMY_TEXT })).toThrow(
    RangeError,
  );
  // 取得に識別子の指定口は無く、自分の個体だけが返る。
  const registry = new PluginCompanionRegistry();
  const store = stubStore();
  registry.register(stubTextCompanion(store));
  const companion = registry.get("text");
  if (companion === undefined) throw new Error("companion が無い。");
  const getTextState = companion.buildRequestHandlers("plugin-text-1", toRequestEnv(binder))[
    "getTextState"
  ] as () => TextInstanceSnapshot;
  expect(getTextState().instanceId).toBe(TEXT_VIEW.instanceId);
});

test("失効したマウントの要求を拒否する", () => {
  const { live, binder } = bindBoth();
  // push 口の未登録も拒否する。
  expect(() => binder.push("plugin-text-1")).toThrow(RangeError);
  binder.setSink("plugin-text-1", "text", () => {});
  // 所有表から消えた（破棄相当）後の要求は全て拒否する。
  live.delete("plugin-text-1");
  expect(() => binder.readSnapshot("text", "plugin-text-1")).toThrow(RangeError);
  expect(() => binder.send("text", "plugin-text-1", { text: DUMMY_TEXT })).toThrow(RangeError);
  expect(() => binder.push("plugin-text-1")).toThrow(RangeError);
  // 生存側は使える。
  expect(
    (binder.readSnapshot("diagnostic", "plugin-diagnostic-1") as DiagnosticInstanceSnapshot)
      .instanceId,
  ).toBe(DIAGNOSTIC_VIEW.instanceId);
  // 対応付けを外した後も拒否する（購読の残存を使えない）。
  binder.unbindMount("plugin-diagnostic-1");
  expect(() => binder.readSnapshot("diagnostic", "plugin-diagnostic-1")).toThrow(RangeError);
  // 未対応付け・空識別子の要求も拒否する。
  expect(() => binder.readSnapshot("text", "plugin-text-9")).toThrow(RangeError);
  expect(() => binder.push("")).toThrow(RangeError);
  expect(() => binder.unbindMount("")).toThrow(RangeError);
});

test("所有側の結線状態が生存確認の正本である", () => {
  const { store, live, binder } = setup();
  store.views.set(TEXT_VIEW.instanceId, TEXT_VIEW);
  // 未結線（所有側に無い）マウントには束縛できない。
  expect(() => binder.bindMount("plugin-text-1", "text", TEXT_VIEW.instanceId)).toThrow(RangeError);
  // 所有側が結線済みを示したら束縛でき、固有要求表で読める。
  live.add("plugin-text-1");
  binder.bindMount("plugin-text-1", "text", TEXT_VIEW.instanceId);
  const snapshot = binder.readSnapshot("text", "plugin-text-1") as TextInstanceSnapshot;
  expect(snapshot.instanceId).toBe(TEXT_VIEW.instanceId);
  const registry = new PluginCompanionRegistry();
  registry.register(stubTextCompanion(store));
  const companion = registry.get("text");
  if (companion === undefined) throw new Error("companion が無い。");
  const handlers = companion.buildRequestHandlers("plugin-text-1", toRequestEnv(binder));
  expect(Object.keys(handlers).sort()).toEqual(["getTextState", "sendText"]);
  // 所有側の退役後は失効として拒否し、束縛し直しもできない。
  live.delete("plugin-text-1");
  expect(() => binder.readSnapshot("text", "plugin-text-1")).toThrow(RangeError);
  binder.unbindMount("plugin-text-1");
  expect(() => binder.bindMount("plugin-text-1", "text", TEXT_VIEW.instanceId)).toThrow(RangeError);
});

test("現割当てが失効した要求を拒否する", async () => {
  const { store, binder } = bindBoth();
  binder.setSink("plugin-text-1", "text", () => {});
  store.lapsed.add(TEXT_VIEW.instanceId);
  // 失効後の取得・送信・push は拒否し、古い割当てへ転送しない。
  expect(() => binder.readSnapshot("text", "plugin-text-1")).toThrow(RangeError);
  await expect(binder.send("text", "plugin-text-1", { text: DUMMY_TEXT })).rejects.toThrow(
    RangeError,
  );
  expect(() => binder.push("plugin-text-1")).toThrow(RangeError);
  // 失効した個体への束縛し直しも拒否する。
  binder.unbindMount("plugin-text-1");
  expect(() => binder.bindMount("plugin-text-1", "text", TEXT_VIEW.instanceId)).toThrow(RangeError);
});

test("テキスト送信が束縛個体の現割当てに委譲される", async () => {
  const { store, binder } = bindBoth();
  const registry = new PluginCompanionRegistry();
  registry.register(stubTextCompanion(store));
  const companion = registry.get("text");
  if (companion === undefined) throw new Error("companion が無い。");
  const handlers = companion.buildRequestHandlers("plugin-text-1", toRequestEnv(binder));
  // ADR: `as` を使う理由は、要求表が種別を問わない汎用表であり、試験で
  // 束縛種別の具象口を取り出すためである。根拠は、対応付けが同一種別の
  // 記述子で結線・送信を対にすることである。
  const sendText = handlers["sendText"] as (params: { text: string }) => Promise<TextSendResult>;
  const result = await sendText({ text: DUMMY_TEXT });
  expect(result.status).toBe("acknowledged");
  // 束縛個体に委譲され、別個体には届かない。
  expect(store.sent.get(TEXT_VIEW.instanceId)).toEqual([DUMMY_TEXT]);
  expect(store.sent.get(DIAGNOSTIC_VIEW.instanceId)).toBeUndefined();
  // 余分な識別子を付けても束縛個体に届く（振り分け口は無い）。
  await sendText({
    text: "ダミー本文-002",
    instanceId: DIAGNOSTIC_VIEW.instanceId,
    localSessionId: "別",
  } as unknown as { text: string });
  expect(store.sent.get(TEXT_VIEW.instanceId)).toEqual([DUMMY_TEXT, "ダミー本文-002"]);
  expect(store.sent.get(DIAGNOSTIC_VIEW.instanceId)).toBeUndefined();
});

test("push は改訂を進めて当該マウントだけに届く", () => {
  const assembled = setup();
  const firstView: TextInstanceView = { ...TEXT_VIEW, localSessionId: "local-1" };
  const secondView: TextInstanceView = {
    ...TEXT_VIEW,
    instanceId: "instance-3",
    localSessionId: "local-3",
  };
  assembled.store.views.set(firstView.instanceId, firstView);
  assembled.store.views.set(secondView.instanceId, secondView);
  assembled.store.sent.set(firstView.instanceId, []);
  assembled.store.sent.set(secondView.instanceId, []);
  assembled.live.add("plugin-text-1");
  assembled.live.add("plugin-diagnostic-1");
  assembled.binder.bindMount("plugin-text-1", "text", firstView.instanceId);
  assembled.binder.bindMount("plugin-diagnostic-1", "text", secondView.instanceId);
  const { binder } = assembled;
  const first: TextInstanceChangedMessage[] = [];
  const second: TextInstanceChangedMessage[] = [];
  // ADR: `as` を使う理由は、汎用 push 口が `unknown` で運ぶ通知を試験で
  // 種別の具象形として集めるためである。根拠は、対応付けが同一種別の
  // 記述子で作った通知を変えずに運ぶことである。
  binder.setSink("plugin-text-1", "text", (message) => {
    first.push(message as TextInstanceChangedMessage);
  });
  binder.setSink("plugin-diagnostic-1", "text", (message) => {
    second.push(message as TextInstanceChangedMessage);
  });
  // 初期取得は改訂 0 で、読み取りでは進まない。
  const initial = binder.readSnapshot("text", "plugin-text-1") as TextInstanceSnapshot;
  expect(initial.revision).toBe(0);
  expect((binder.readSnapshot("text", "plugin-text-1") as TextInstanceSnapshot).revision).toBe(0);
  // 当該マウントだけに push が届き、改訂が進む。
  expect(binder.push("plugin-text-1")).toEqual({ revision: 1 });
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
  const backend = await GuiBackend.create(
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
    { registerPlugins: registerBundledPlugins },
  );
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
  const approved = backend.approvePairing({ requestId: pairing.requestId });
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

  const assignment = backend.assignPlugin({ pluginKind: "text" });
  const companion = backend.companionRegistry.get("text");
  if (companion === undefined) throw new Error("テキスト companion が無い。");
  // 個体別射影は自分の個体だけを返し、管理情報を含めない。
  // ADR: `as` を使う理由は、汎用口が種別を問わない表示を返し、試験で
  // 束縛種別の具象表示を取り出すためである。
  const view = companion.readView(assignment.instanceId) as TextInstanceView;
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
  expect(() => companion.readView("無い")).toThrow(RangeError);

  // 束縛送信は現割当てに委譲され、反映確認で決着する。本文は射影に残らない。
  const send = companion.send;
  if (send === undefined) throw new Error("テキストの送信口が無い。");
  const result = (await send(assignment.instanceId, { text: DUMMY_TEXT })) as TextSendResult;
  expect(result.status).toBe("acknowledged");
  await waitForArrival(
    () => (companion.readView(assignment.instanceId) as TextInstanceView).lastResult !== null,
    "反映確認の射影反映",
  );
  expect(
    JSON.stringify(companion.readView(assignment.instanceId) as TextInstanceView),
  ).not.toContain(DUMMY_TEXT);

  // 解除後は失効として拒否し、古い割当てへ転送しない。
  backend.unassignPlugin({
    instanceId: assignment.instanceId,
    localSessionId: assignment.localSessionId,
    portId: assignment.portId,
  });
  expect(() => companion.readView(assignment.instanceId)).toThrow(RangeError);
  expect(() => send(assignment.instanceId, { text: DUMMY_TEXT })).toThrow(RangeError);
});

test("実バックエンドの診断射影が自個体の統計だけを返す", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const before = backend.getSnapshot().sessions.length;
  const session = await provider.tryCreateSession({
    sessionId: DIAGNOSTIC_ECHO_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
  const target = backend.getSnapshot().sessions[before];
  if (target === undefined) throw new Error("生存セッションが無い。");
  const assignment = backend.assignPlugin({
    pluginKind: "diagnostic",
    localSessionId: target.localSessionId,
  });
  const companion = backend.companionRegistry.get("diagnostic");
  if (companion === undefined) throw new Error("診断 companion が無い。");

  await session.sendReliable({ op: "echo", id: "inst-1", value: "ダミー値" });
  await session.sendReliable({ op: "ping", id: "inst-p1" });
  await waitForArrival(() => {
    const stats = (companion.readView(assignment.instanceId) as DiagnosticInstanceView).stats;
    return stats.diagnosticEcho === 1 && stats.diagnosticPing === 1;
  }, "診断統計の反映");

  // ADR: `as` を使う理由は上記と同様である。
  const view = companion.readView(assignment.instanceId) as DiagnosticInstanceView;
  expect(view.localSessionId).toBe(target.localSessionId);
  expect(view.portId).toBe(DIAGNOSTIC_PORT_ID);
  expect(Object.keys(view).sort()).toEqual([
    "instanceId",
    "localSessionId",
    "pluginId",
    "portId",
    "stats",
  ]);
  // 他個体では取れない。
  expect(() => companion.readView("無い")).toThrow(RangeError);
  const textCompanion = backend.companionRegistry.get("text");
  if (textCompanion === undefined) throw new Error("テキスト companion が無い。");
  expect(() => textCompanion.readView(assignment.instanceId)).toThrow(RangeError);
});
