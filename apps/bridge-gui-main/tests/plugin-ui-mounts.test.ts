/**
 * 実プラグイン子画面の対応付け・配置・回収の検証。
 *
 * 偽の子画面・偽チャネル・偽 backend で対応付けの振る舞いだけを確かめ、
 * Electrobun の SDK 呼び出しは適合層に隔離したまま触らない。
 * 現割当てへの追随、生成照合、失効・失敗時の回収、失敗の局所化と再試行、
 * 残存なしを保証する。送信本文は記録に残さない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import type { TextSendResult } from "bridge-plugin-text";
import {
  PluginUiCoordinator,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import type { PluginCompanion } from "bridge-gui-plugin-sdk/companion";
import type {
  DiagnosticInstanceSnapshot,
  DiagnosticInstanceView,
} from "bridge-plugin-diagnostic/gui-contract";
import type { TextInstanceSnapshot, TextInstanceView } from "bridge-plugin-text/gui-contract";
import {
  BUNDLED_PLUGIN_ASSETS,
  getBundledPluginAsset,
} from "../src/composition/bundled-plugin-assets.ts";
import {
  buildPluginBlankUrl,
  buildPluginViewUrl,
  parsePluginMountId,
  pluginMountKindOf,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";

/** 検証用の解決済み view パス。静的 manifest の値を正本とする。 */
function bundledViewPath(kind: string): string {
  const entry = getBundledPluginAsset(BUNDLED_PLUGIN_ASSETS, kind);
  if (entry === undefined) throw new Error(`資産が無い: ${kind}`);
  return entry.viewPath;
}

/** 検証用の束縛情報。表示の照合だけに使う。 */
interface TestBinding {
  instanceId: string;
  localSessionId: string;
  portId: string;
}

/** 検証用の偽 backend。外部変化の通知口だけを持つ。 */
class FakeBackend {
  textBinding: TestBinding | null = null;
  diagnostics: TestBinding[] = [];
  textView: TextInstanceView | null = null;
  diagnosticView: DiagnosticInstanceView | null = null;
  notified = 0;
  /** 真の場合に要望読みを失敗させる。種別ごとの失敗隔離の検証に使う。 */
  textDesiredFails = false;
  /** 真の場合に要望読みを失敗させる。種別ごとの失敗隔離の検証に使う。 */
  diagnosticDesiredFails = false;

  notifyExternalChange(): void {
    this.notified += 1;
  }
}

/**
 * 検証用のテキスト companion。材料（FakeBackend）を capture する。
 */
function stubTextCompanion(store: FakeBackend): PluginCompanion {
  return {
    kind: "text",
    label: "テキスト",
    viewPath: bundledViewPath("text"),
    listDesired: () => {
      if (store.textDesiredFails) {
        throw new Error("テキストの要望読みに失敗した。");
      }
      const binding = store.textBinding;
      return binding === null ? [] : [{ ...binding }];
    },
    readView: (instanceId: string) => {
      const view = store.textView;
      if (view === null || view.instanceId !== instanceId) {
        throw new RangeError("束縛したテキスト個体ではない。");
      }
      if (store.textBinding === null || store.textBinding.instanceId !== instanceId) {
        throw new RangeError("束縛したテキスト個体ではない。");
      }
      return view;
    },
    toSnapshot: (view, revision) => ({ ...(view as TextInstanceView), revision }),
    send: (instanceId: string, params: unknown) => {
      if (store.textBinding === null || store.textBinding.instanceId !== instanceId) {
        return Promise.reject(new RangeError("束縛したテキスト個体ではない。"));
      }
      // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
      const table = params as { text: unknown };
      if (typeof table.text !== "string" || table.text.length === 0) {
        return Promise.reject(new RangeError("text は空でない文字列であること。"));
      }
      return Promise.resolve({ status: "acknowledged" as const, id: "test-1" });
    },
    pushMessageName: "textStateChanged",
    buildRequestHandlers: (mountId: string, env) => ({
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
 * 検証用の診断 companion。材料（FakeBackend）を capture する。
 */
function stubDiagnosticCompanion(store: FakeBackend): PluginCompanion {
  return {
    kind: "diagnostic",
    label: "診断",
    viewPath: bundledViewPath("diagnostic"),
    listDesired: () => {
      if (store.diagnosticDesiredFails) {
        throw new Error("診断の要望読みに失敗した。");
      }
      return store.diagnostics.map((binding) => ({ ...binding }));
    },
    readView: (instanceId: string) => {
      const view = store.diagnosticView;
      if (view === null || view.instanceId !== instanceId) {
        throw new RangeError("束縛した診断個体ではない。");
      }
      if (!store.diagnostics.some((binding) => binding.instanceId === instanceId)) {
        throw new RangeError("診断の現割当てが無い。");
      }
      return view;
    },
    toSnapshot: (view, revision) => ({ ...(view as DiagnosticInstanceView), revision }),
    pushMessageName: "diagnosticStateChanged",
    buildRequestHandlers: (mountId: string, env) => ({
      getDiagnosticState: () => {
        const snapshot = env.readSnapshot("diagnostic", mountId);
        const typed = snapshot as DiagnosticInstanceSnapshot;
        env.markReady(mountId);
        return typed;
      },
    }),
  };
}

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
    readonly navigationRules: string | null = null,
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

/** 検証用の偽チャネル工場。種別ごとの push 到達を記録する。 */
function setupFactory(options: { failBind?: boolean } = {}): {
  factory: PluginUiChannelFactory;
  textPushes: Map<string, unknown[]>;
  diagnosticPushes: Map<string, unknown[]>;
  boundKinds: Map<string, string>;
} {
  const textPushes = new Map<string, unknown[]>();
  const diagnosticPushes = new Map<string, unknown[]>();
  const boundKinds = new Map<string, string>();
  const factory: PluginUiChannelFactory = (view, mountId, kind, hooks) => {
    void view;
    void hooks;
    if (options.failBind) {
      throw new Error("結線失敗");
    }
    boundKinds.set(mountId, kind);
    const pushed: unknown[] = [];
    if (kind === "text") {
      textPushes.set(mountId, pushed);
    } else {
      diagnosticPushes.set(mountId, pushed);
    }
    const channel: PluginUiChannel = {
      push: (message: unknown) => {
        pushed.push(message);
      },
    };
    return channel;
  };
  return { factory, textPushes, diagnosticPushes, boundKinds };
}

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

/** 診断個体の限定表示の雛形。検証対象は対応付けの照合のみである。 */
const DIAGNOSTIC_VIEW: DiagnosticInstanceView = {
  instanceId: "instance-9",
  pluginId: "diagnostic",
  portId: "diagnostic",
  localSessionId: "local-9",
  stats: { diagnosticEcho: 2, diagnosticPing: 3 },
};

/** 検証用の対応付け。時刻を差し替えて期限を確かめる。 */
function setup(options: { failBind?: boolean } = {}): {
  backend: FakeBackend;
  coordinator: PluginUiCoordinator;
  textPushes: Map<string, unknown[]>;
  diagnosticPushes: Map<string, unknown[]>;
  boundKinds: Map<string, string>;
  setNow: (value: number) => void;
} {
  const backend = new FakeBackend();
  const fakes = setupFactory(options);
  let nowMs = 0;
  const registry = new PluginCompanionRegistry();
  registry.register(stubTextCompanion(backend));
  registry.register(stubDiagnosticCompanion(backend));
  const coordinator = new PluginUiCoordinator(7, backend, fakes.factory, () => nowMs, registry);
  return {
    backend,
    coordinator,
    textPushes: fakes.textPushes,
    diagnosticPushes: fakes.diagnosticPushes,
    boundKinds: fakes.boundKinds,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

test("実プラグインの識別子は往復しスパイクと混ざらない", () => {
  // 子画面 URL の組み立ては対応付けが汎用の組み立てで行う。相対 entrypoint の
  // 宣言と解決済み view パスの対応は資産の同期テストで固定する。
  const textUrl = buildPluginViewUrl(bundledViewPath("text"), "plugin-text-3");
  expect(parsePluginMountId(textUrl)).toBe("plugin-text-3");
  expect(pluginMountKindOf("plugin-text-3")).toBe("text");
  const diagnosticUrl = buildPluginViewUrl(bundledViewPath("diagnostic"), "plugin-diagnostic-4");
  expect(parsePluginMountId(diagnosticUrl)).toBe("plugin-diagnostic-4");
  expect(pluginMountKindOf("plugin-diagnostic-4")).toBe("diagnostic");
  expect(parsePluginMountId(buildPluginBlankUrl("plugin-text-3"))).toBe("plugin-text-3");
  // 段0スパイクの識別子は実プラグインの名前空間に入らない。
  expect(parsePluginMountId("views://plugin-host/blank.html#mount=spike-1")).toBeNull();
  expect(parsePluginMountId(null)).toBeNull();
  expect(pluginMountKindOf("spike-1")).toBeNull();
  // 形式正しい未知種別は構文として受け付け、既知・未登録の判定は登録表が行う。
  expect(parsePluginMountId("views://plugin-host/blank.html#mount=plugin-unknown-1")).toBe(
    "plugin-unknown-1",
  );
  expect(pluginMountKindOf("plugin-unknown-1")).toBe("unknown");
});

test("現割当てに配置を作る", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  expect(coordinator.syncNow()).toBe(true);
  expect(coordinator.size).toBe(1);
  expect(backend.notified).toBeGreaterThan(0);
  const placements = coordinator.listPlacements();
  expect(placements).toHaveLength(1);
  const placement = placements[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.mountId).toBe("plugin-text-1");
  expect(placement.kind).toBe("text");
  expect(placement.initialUrl).toBe(buildPluginBlankUrl("plugin-text-1"));
  expect(placement.phase).toBe("pending");
  expect(placement.ready).toBe(false);
  expect(placement.instanceId).toBe("instance-1");
  expect(placement.localSessionId).toBe("local-1");
  // 変化が無ければ通知を重ねない。
  const notified = backend.notified;
  expect(coordinator.syncNow()).toBe(false);
  expect(backend.notified).toBe(notified);
});

test("要望が無ければ配置を作らない", () => {
  const { coordinator } = setup();
  expect(coordinator.syncNow()).toBe(false);
  expect(coordinator.size).toBe(0);
  expect(coordinator.listPlacements()).toHaveLength(0);
});

test("タグ生成で個体別チャネルを結線する", () => {
  const { backend, coordinator, boundKinds } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  expect(coordinator.handleTagCreated(view)).toBe(true);
  expect(boundKinds.get(placement.mountId)).toBe("text");
  expect(view.loaded).toEqual([buildPluginViewUrl(bundledViewPath("text"), placement.mountId)]);
  expect(view.removed).toBe(false);
  const bound = coordinator.listPlacements()[0];
  if (bound === undefined) throw new Error("配置が無い。");
  expect(bound.phase).toBe("bound");
  // 子画面の初期取得で準備完了になる。
  // ADR: `as` を使う理由は、汎用口が `unknown` で返す表示を試験で種別の
  // 具象形として確かめるためである。根拠は、対応付けが同一種別の記述子で
  // 読み・付番を対にすることである。
  const snapshot = coordinator.readSnapshot("text", placement.mountId) as TextInstanceSnapshot;
  coordinator.markReady(placement.mountId);
  expect(snapshot.instanceId).toBe("instance-1");
  expect(snapshot.revision).toBe(0);
  expect(coordinator.listPlacements()[0]?.ready).toBe(true);
});

test("親違いと他名前空間の生成に触らない", () => {
  const { coordinator } = setup();
  const foreign = new FakeView(11, 99, buildPluginBlankUrl("plugin-text-1"));
  expect(coordinator.handleTagCreated(foreign)).toBe(false);
  expect(foreign.removed).toBe(false);
  const spike = new FakeView(12, 7, "views://plugin-host/blank.html#mount=spike-1");
  expect(coordinator.handleTagCreated(spike)).toBe(false);
  expect(spike.removed).toBe(false);
  expect(coordinator.size).toBe(0);
});

test("終了した割当ての対応付けを回収する", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  coordinator.handleTagCreated(view);
  // Session 終了で現割当てが消える。
  backend.textBinding = null;
  expect(coordinator.syncNow()).toBe(true);
  expect(coordinator.size).toBe(0);
  expect(view.removed).toBe(true);
  // 通常の終了は失敗表示に回さない。
  expect(coordinator.listFailures()).toHaveLength(0);
  expect(coordinator.failureCount).toBe(0);
});

test("生成待ちの期限超過を失敗表示に回し再配置しない", () => {
  const { backend, coordinator, setNow } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  expect(coordinator.size).toBe(1);
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(coordinator.syncNow()).toBe(true);
  expect(coordinator.size).toBe(0);
  const failures = coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.kind).toBe("text");
  expect(failures[0]?.instanceId).toBe("instance-1");
  // 現割当てが残っていても明示の再試行まで再配置しない。
  expect(coordinator.syncNow()).toBe(false);
  expect(coordinator.size).toBe(0);
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("結線後に準備完了が無いまま期限超過したら失敗表示に回し再配置しない", () => {
  const { backend, coordinator, setNow } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  coordinator.handleTagCreated(view);
  expect(coordinator.listPlacements()[0]?.phase).toBe("bound");
  // 子画面の初期取得が無いまま期限を過ぎると失敗表示に回る。
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(coordinator.syncNow()).toBe(true);
  expect(coordinator.size).toBe(0);
  expect(view.removed).toBe(true);
  const failures = coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.kind).toBe("text");
  expect(failures[0]?.instanceId).toBe("instance-1");
  // 現割当てが残っていても明示の再試行まで再配置しない。
  expect(coordinator.syncNow()).toBe(false);
  expect(coordinator.size).toBe(0);
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("準備完了があれば期限超過で回収しない", () => {
  const { backend, coordinator, setNow } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  coordinator.handleTagCreated(view);
  coordinator.readSnapshot("text", placement.mountId);
  coordinator.markReady(placement.mountId);
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  expect(coordinator.syncNow()).toBe(false);
  expect(coordinator.size).toBe(1);
  expect(view.removed).toBe(false);
  expect(coordinator.listFailures()).toHaveLength(0);
  expect(coordinator.listPlacements()[0]?.ready).toBe(true);
});

test("再試行で現割当てへ再配置する", () => {
  const { backend, coordinator, setNow } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  coordinator.syncNow();
  expect(coordinator.listFailures()).toHaveLength(1);
  expect(coordinator.retryFailed("instance-1")).toEqual({ ok: true });
  expect(coordinator.listFailures()).toHaveLength(0);
  expect(coordinator.size).toBe(1);
  // 識別子は使い回さない。
  expect(coordinator.listPlacements()[0]?.mountId).toBe("plugin-text-2");
});

test("個体限定の再試行は対象個体だけに作用する", () => {
  const { backend, coordinator, setNow } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  backend.diagnostics = [
    { instanceId: "instance-9", localSessionId: "local-9", portId: "diagnostic" },
  ];
  backend.diagnosticView = DIAGNOSTIC_VIEW;
  coordinator.syncNow();
  expect(coordinator.size).toBe(2);
  // 両方を期限超過で失敗表示に回す。
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  coordinator.syncNow();
  expect(coordinator.size).toBe(0);
  expect(coordinator.listFailures()).toHaveLength(2);
  // テキスト側の結線済み配置を用意し、再試行の前後で保全されることを見る。
  // まず対象個体だけを再試行し、診断の失敗は残る。
  expect(coordinator.retryFailed("instance-1")).toEqual({ ok: true });
  const failures = coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.instanceId).toBe("instance-9");
  // 対象個体だけが再配置され、他個体の再配置は起きない。
  const placements = coordinator.listPlacements();
  expect(placements).toHaveLength(1);
  expect(placements[0]?.instanceId).toBe("instance-1");
  expect(placements[0]?.mountId).toBe("plugin-text-3");
  // 割当ての実体には触らない（要望側の束縛は保つ）。
  expect(backend.textBinding?.instanceId).toBe("instance-1");
  expect(backend.diagnostics.map((binding) => binding.instanceId)).toEqual(["instance-9"]);
});

test("未知の個体の再試行は例外にせず何も変えない", () => {
  const { backend, coordinator, setNow } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  coordinator.syncNow();
  expect(coordinator.listFailures()).toHaveLength(1);
  const before = coordinator.listPlacements().map((placement) => placement.mountId);
  // 現所有・失敗のいずれにも無い識別子は作用なしで受付とする。
  expect(coordinator.retryFailed("instance-unknown")).toEqual({ ok: true });
  expect(coordinator.listFailures()).toHaveLength(1);
  expect(coordinator.listPlacements().map((placement) => placement.mountId)).toEqual(before);
  // 形違いの指定も例外にしない。
  expect(coordinator.retryFailed("")).toEqual({ ok: true });
  expect(coordinator.retryFailed(null)).toEqual({ ok: true });
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("破棄後の再試行は受付だけを返す", () => {
  const { coordinator } = setup();
  coordinator.dispose();
  expect(coordinator.retryFailed("instance-1")).toEqual({ ok: true });
});

test("個体限定の再試行は正常マウントと送信に触らない", () => {
  const { backend, coordinator, setNow, textPushes } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  backend.diagnostics = [
    { instanceId: "instance-9", localSessionId: "local-9", portId: "diagnostic" },
  ];
  backend.diagnosticView = DIAGNOSTIC_VIEW;
  coordinator.syncNow();
  // テキスト側だけを結線して準備完了にし、診断側は生成待ちのまま期限切れにする。
  const textMountId = coordinator
    .listPlacements()
    .find((placement) => placement.kind === "text")?.mountId;
  if (textMountId === undefined) throw new Error("テキストの配置が無い。");
  const textView = new FakeView(11, 7, buildPluginBlankUrl(textMountId));
  coordinator.handleTagCreated(textView);
  coordinator.readSnapshot("text", textMountId);
  coordinator.markReady(textMountId);
  coordinator.pushBound();
  expect(textPushes.get(textMountId)).toHaveLength(1);
  setNow(PLUGIN_PENDING_TIMEOUT_MS + 1);
  coordinator.syncNow();
  // 準備完了のテキストは残り、診断だけが失敗表示に回る。
  expect(coordinator.listPlacements().map((placement) => placement.mountId)).toEqual([textMountId]);
  expect(coordinator.listFailures()).toHaveLength(1);
  expect(coordinator.listFailures()[0]?.instanceId).toBe("instance-9");
  // 診断個体だけを再試行し、テキストの配置・改訂・push 先に触らない。
  expect(coordinator.retryFailed("instance-9")).toEqual({ ok: true });
  expect(coordinator.listPlacements().some((placement) => placement.mountId === textMountId)).toBe(
    true,
  );
  expect(textPushes.get(textMountId)).toHaveLength(1);
  expect(
    coordinator.listPlacements().find((placement) => placement.mountId === textMountId)?.revision,
  ).toBe(1);
  expect(coordinator.listFailures()).toHaveLength(0);
});

test("結線の失敗をそのマウントに局所化する", () => {
  const { backend, coordinator } = setup({ failBind: true });
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  expect(coordinator.handleTagCreated(view)).toBe(true);
  expect(coordinator.size).toBe(0);
  expect(view.removed).toBe(true);
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("子画面の読込み失敗をそのマウントに局所化する", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  view.loadFails = true;
  expect(coordinator.handleTagCreated(view)).toBe(true);
  expect(coordinator.size).toBe(0);
  expect(view.removed).toBe(true);
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("失効した束縛の初期取得で対応付けを回収する", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  coordinator.handleTagCreated(view);
  // 現割当てが失効した後の初期取得は拒否し、対応付けを回収する。
  backend.textBinding = null;
  expect(() => coordinator.readSnapshot("text", placement.mountId)).toThrow(RangeError);
  expect(coordinator.size).toBe(0);
  expect(view.removed).toBe(true);
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("結線済みの対応付けへ最新状態を送る", () => {
  const { backend, coordinator, textPushes } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  coordinator.handleTagCreated(new FakeView(11, 7, placement.initialUrl));
  coordinator.readSnapshot("text", placement.mountId);
  coordinator.markReady(placement.mountId);
  coordinator.pushBound();
  const pushed = textPushes.get(placement.mountId);
  expect(pushed).toHaveLength(1);
  expect(coordinator.listPlacements()[0]?.revision).toBe(1);
  coordinator.pushBound();
  expect(textPushes.get(placement.mountId)).toHaveLength(2);
  expect(coordinator.listPlacements()[0]?.revision).toBe(2);
});

test("送信 push の失効で対応付けを回収する", () => {
  const { backend, coordinator, textPushes } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  coordinator.handleTagCreated(new FakeView(11, 7, placement.initialUrl));
  backend.textBinding = null;
  coordinator.pushBound();
  expect(textPushes.get(placement.mountId)).toHaveLength(0);
  expect(coordinator.size).toBe(0);
  expect(coordinator.listFailures()).toHaveLength(1);
});

test("診断の配置・結線・送信 push が通る", () => {
  const { backend, coordinator, diagnosticPushes, boundKinds } = setup();
  backend.diagnostics = [
    { instanceId: "instance-9", localSessionId: "local-9", portId: "diagnostic" },
  ];
  backend.diagnosticView = DIAGNOSTIC_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.mountId).toBe("plugin-diagnostic-1");
  expect(placement.kind).toBe("diagnostic");
  const view = new FakeView(21, 7, placement.initialUrl);
  expect(coordinator.handleTagCreated(view)).toBe(true);
  expect(boundKinds.get(placement.mountId)).toBe("diagnostic");
  expect(view.loaded).toEqual([
    buildPluginViewUrl(bundledViewPath("diagnostic"), placement.mountId),
  ]);
  const snapshot = coordinator.readSnapshot(
    "diagnostic",
    placement.mountId,
  ) as DiagnosticInstanceSnapshot;
  coordinator.markReady(placement.mountId);
  expect(snapshot.stats).toEqual({ diagnosticEcho: 2, diagnosticPing: 3 });
  coordinator.pushBound();
  expect(diagnosticPushes.get(placement.mountId)).toHaveLength(1);
});

test("全破棄で購読・表示の残存を残さない", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  backend.diagnostics = [
    { instanceId: "instance-9", localSessionId: "local-9", portId: "diagnostic" },
  ];
  backend.diagnosticView = DIAGNOSTIC_VIEW;
  coordinator.syncNow();
  expect(coordinator.size).toBe(2);
  const views = coordinator.listPlacements().map((placement) => {
    const view = new FakeView(30, 7, placement.initialUrl);
    coordinator.handleTagCreated(view);
    return view;
  });
  expect(coordinator.resetAll("試験")).toEqual({ ok: true });
  expect(coordinator.size).toBe(0);
  expect(coordinator.listPlacements()).toHaveLength(0);
  expect(coordinator.listFailures()).toHaveLength(0);
  for (const view of views) {
    expect(view.removed).toBe(true);
  }
});

test("退役後の遅延生成を回収する", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  coordinator.resetAll("試験");
  // 配置待ちの破棄後に届いた遅延生成は回収する。
  const late = new FakeView(11, 7, placement.initialUrl);
  expect(coordinator.handleTagCreated(late)).toBe(true);
  expect(late.removed).toBe(true);
  expect(late.loaded).toHaveLength(0);
  expect(coordinator.size).toBe(0);
});

test("重複する生成を回収する", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  coordinator.handleTagCreated(new FakeView(11, 7, placement.initialUrl));
  const duplicated = new FakeView(12, 7, placement.initialUrl);
  expect(coordinator.handleTagCreated(duplicated)).toBe(true);
  expect(duplicated.removed).toBe(true);
  expect(duplicated.loaded).toHaveLength(0);
  expect(coordinator.size).toBe(1);
});

test("要望読みに失敗した種別の既存マウントを保全し成功側は追随する", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  backend.diagnostics = [
    { instanceId: "instance-9", localSessionId: "local-9", portId: "diagnostic" },
  ];
  backend.diagnosticView = DIAGNOSTIC_VIEW;
  coordinator.syncNow();
  expect(coordinator.size).toBe(2);
  // 両方結線する。要望不明と割当て終了を区別するため、結線済みで確かめる。
  const views = new Map<string, FakeView>();
  for (const placement of coordinator.listPlacements()) {
    const view = new FakeView(30, 7, placement.initialUrl);
    coordinator.handleTagCreated(view);
    views.set(placement.mountId, view);
  }
  const diagnosticMountId = coordinator
    .listPlacements()
    .find((placement) => placement.kind === "diagnostic")?.mountId;
  if (diagnosticMountId === undefined) throw new Error("診断の配置が無い。");
  const textMountId = coordinator
    .listPlacements()
    .find((placement) => placement.kind === "text")?.mountId;
  if (textMountId === undefined) throw new Error("テキストの配置が無い。");

  // 診断の要望読みだけを失敗させ、テキストの現割当ては新しい個体へ進める。
  backend.diagnosticDesiredFails = true;
  backend.textBinding = { instanceId: "instance-2", localSessionId: "local-2", portId: "text" };
  backend.textView = { ...TEXT_VIEW, instanceId: "instance-2", localSessionId: "local-2" };
  expect(coordinator.syncNow()).toBe(true);

  // 成功側（テキスト）は追随し、失敗側（診断）の既存マウントは保全される。
  const diagnostic = coordinator
    .listPlacements()
    .find((placement) => placement.kind === "diagnostic");
  expect(diagnostic?.mountId).toBe(diagnosticMountId);
  expect(views.get(diagnosticMountId)?.removed).toBe(false);
  const text = coordinator.listPlacements().find((placement) => placement.kind === "text");
  expect(text?.instanceId).toBe("instance-2");
  expect(text?.mountId).toBe("plugin-text-3");
  expect(views.get(textMountId)?.removed).toBe(true);
  // 要望不明は失敗表示に回さない。
  expect(coordinator.listFailures()).toHaveLength(0);
});

test("全種別の要望読みに失敗したら何も変えない", () => {
  const { backend, coordinator } = setup();
  backend.textBinding = { instanceId: "instance-1", localSessionId: "local-1", portId: "text" };
  backend.textView = TEXT_VIEW;
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  const view = new FakeView(11, 7, placement.initialUrl);
  coordinator.handleTagCreated(view);

  // 全種別で失敗する。要望が空の場合と同様に、対応付けを変えない。
  backend.textDesiredFails = true;
  backend.diagnosticDesiredFails = true;
  const notified = backend.notified;
  expect(coordinator.syncNow()).toBe(false);
  expect(coordinator.size).toBe(1);
  expect(coordinator.listPlacements()[0]?.mountId).toBe(placement.mountId);
  expect(view.removed).toBe(false);
  expect(backend.notified).toBe(notified);
  expect(coordinator.listFailures()).toHaveLength(0);
});
