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
import type { TextSendResult } from "bridge-app-core";
import {
  PluginUiCoordinator,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";
import type {
  DiagnosticInstanceView,
  TextInstanceSnapshot,
  TextInstanceView,
} from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginDiagnosticUrl,
  buildPluginTextUrl,
  parsePluginMountId,
  pluginMountKindOf,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";

/** 検証用の束縛情報。表示の照合だけに使う。 */
interface TestBinding {
  instanceId: string;
  localSessionId: string;
  portId: string;
}

/** 検証用の偽 backend。現割当てと個体別射影の最小口を満たす。 */
class FakeBackend {
  textBinding: TestBinding | null = null;
  diagnostics: TestBinding[] = [];
  textView: TextInstanceView | null = null;
  diagnosticView: DiagnosticInstanceView | null = null;
  notified = 0;

  notifyExternalChange(): void {
    this.notified += 1;
  }

  getTextBinding(): TestBinding | null {
    return this.textBinding;
  }

  listDiagnosticBindings(): TestBinding[] {
    return [...this.diagnostics];
  }

  getTextInstanceView(params: { instanceId: unknown }): TextInstanceView {
    const view = this.textView;
    if (view === null || view.instanceId !== params.instanceId) {
      throw new RangeError("束縛したテキスト個体ではない。");
    }
    if (this.textBinding === null || this.textBinding.instanceId !== params.instanceId) {
      throw new RangeError("束縛したテキスト個体ではない。");
    }
    return view;
  }

  sendTextForInstance(instanceId: unknown, params: { text: unknown }): Promise<TextSendResult> {
    if (this.textBinding === null || this.textBinding.instanceId !== instanceId) {
      return Promise.reject(new RangeError("束縛したテキスト個体ではない。"));
    }
    if (typeof params.text !== "string" || params.text.length === 0) {
      return Promise.reject(new RangeError("text は空でない文字列であること。"));
    }
    return Promise.resolve({ status: "acknowledged" as const, id: "test-1" });
  }

  getDiagnosticInstanceView(params: { instanceId: unknown }): DiagnosticInstanceView {
    const view = this.diagnosticView;
    if (view === null || view.instanceId !== params.instanceId) {
      throw new RangeError("束縛した診断個体ではない。");
    }
    if (!this.diagnostics.some((binding) => binding.instanceId === params.instanceId)) {
      throw new RangeError("診断の現割当てが無い。");
    }
    return view;
  }
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
    if (kind === "text") {
      const pushed: unknown[] = [];
      textPushes.set(mountId, pushed);
      const channel: PluginUiChannel = {
        pushText: (message) => {
          pushed.push(message);
        },
      };
      return channel;
    }
    const pushed: unknown[] = [];
    diagnosticPushes.set(mountId, pushed);
    const channel: PluginUiChannel = {
      pushDiagnostic: (message) => {
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
  const coordinator = new PluginUiCoordinator(7, backend, fakes.factory, () => nowMs);
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
  const textUrl = buildPluginTextUrl("plugin-text-3");
  expect(parsePluginMountId(textUrl)).toBe("plugin-text-3");
  expect(pluginMountKindOf("plugin-text-3")).toBe("text");
  const diagnosticUrl = buildPluginDiagnosticUrl("plugin-diagnostic-4");
  expect(parsePluginMountId(diagnosticUrl)).toBe("plugin-diagnostic-4");
  expect(pluginMountKindOf("plugin-diagnostic-4")).toBe("diagnostic");
  expect(parsePluginMountId(buildPluginBlankUrl("plugin-text-3"))).toBe("plugin-text-3");
  // 段0スパイクの識別子は実プラグインの名前空間に入らない。
  expect(parsePluginMountId("views://plugin-host/blank.html#mount=spike-1")).toBeNull();
  expect(parsePluginMountId(null)).toBeNull();
  expect(pluginMountKindOf("spike-1")).toBeNull();
  expect(pluginMountKindOf("plugin-unknown-1")).toBeNull();
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
  expect(view.loaded).toEqual([buildPluginTextUrl(placement.mountId)]);
  expect(view.removed).toBe(false);
  const bound = coordinator.listPlacements()[0];
  if (bound === undefined) throw new Error("配置が無い。");
  expect(bound.phase).toBe("bound");
  // 子画面の初期取得で準備完了になる。
  const snapshot: TextInstanceSnapshot = coordinator.handleGetTextState(placement.mountId);
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
  coordinator.handleGetTextState(placement.mountId);
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
  expect(coordinator.retryFailed()).toEqual({ ok: true });
  expect(coordinator.listFailures()).toHaveLength(0);
  expect(coordinator.size).toBe(1);
  // 識別子は使い回さない。
  expect(coordinator.listPlacements()[0]?.mountId).toBe("plugin-text-2");
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
  expect(() => coordinator.handleGetTextState(placement.mountId)).toThrow(RangeError);
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
  coordinator.handleGetTextState(placement.mountId);
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
  expect(view.loaded).toEqual([buildPluginDiagnosticUrl(placement.mountId)]);
  const snapshot = coordinator.handleGetDiagnosticState(placement.mountId);
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
