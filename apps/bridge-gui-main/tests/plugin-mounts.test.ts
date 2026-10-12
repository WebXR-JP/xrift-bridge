/**
 * 段0スパイクのマウント管理の検証。
 *
 * 偽の子画面と偽チャネルで所有表の振る舞いだけを確かめる。
 * Electrobun の SDK 呼び出しは適合層に隔離し、ここでは触らない。
 * 識別子・URL の一致、重複・遅延生成の回収、破棄の残存なしを保証する。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import {
  PluginMountManager,
  type MountChannel,
  type MountChildView,
  type SpikeChannelFactory,
  type SpikeChannelHooks,
} from "../src/main/plugin-mounts.ts";
import { buildBlankUrl } from "bridge-gui-contract/plugin-spike";
import { parseMountId } from "bridge-gui-contract/plugin-spike";

/** 検証用の偽チャネル。push の到達だけを記録する。 */
class FakeChannel implements MountChannel {
  readonly pushed: Array<{ mountId: string; revision: number }> = [];
  pushState(message: { mountId: string; revision: number }): void {
    this.pushed.push({ ...message });
  }
}

/** 検証用の偽子画面。破棄と読込みの事実だけを残す。 */
class FakeView implements MountChildView {
  removed = false;
  loaded: string[] = [];
  constructor(
    readonly viewId: number,
    readonly hostWebviewId: number | undefined,
    readonly renderer = "native",
    readonly sandbox = false,
    readonly preload: string | null = null,
    readonly navigationRules: string | null = null,
    readonly currentUrl: string | null = null,
  ) {}
  loadSpikeUrl(url: string): void {
    this.loaded.push(url);
  }
  removeView(): void {
    this.removed = true;
  }
}

/** 偽チャネルの工場。結線ごとの hooks を保持する。 */
function setup(): {
  manager: PluginMountManager;
  channels: Map<string, FakeChannel>;
  hooks: Map<string, SpikeChannelHooks>;
} {
  const channels = new Map<string, FakeChannel>();
  const hooks = new Map<string, SpikeChannelHooks>();
  const factory: SpikeChannelFactory = (view, mountId, hook) => {
    void view;
    const channel = new FakeChannel();
    channels.set(mountId, channel);
    hooks.set(mountId, hook);
    return channel;
  };
  return { manager: new PluginMountManager(7, factory), channels, hooks };
}

test("識別子を使い回さない", () => {
  const { manager } = setup();
  const first = manager.createMount();
  manager.destroyMount(first.mountId);
  const second = manager.createMount();
  // 破棄後の再作成でも識別子は進み、使い回さない。
  expect(second.mountId).not.toBe(first.mountId);
  expect(manager.listMounts().map((mount) => mount.mountId)).toEqual([second.mountId]);
});

test("配置待ちの生成だけを結線する", () => {
  const { manager } = setup();
  const dto = manager.createMount();
  const view = new FakeView(11, 7, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(view);
  // 結線後に子画面を読み込む。
  expect(view.removed).toBe(false);
  expect(view.loaded).toHaveLength(1);
  const summary = manager.listMounts()[0];
  expect(summary?.phase).toBe("bound");
  expect(summary?.ready).toBe(false);
});

test("親の異なる生成には触れない", () => {
  const { manager } = setup();
  const dto = manager.createMount();
  const view = new FakeView(11, 99, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(view);
  // 他者の所有物のため破棄せず、配置待ちも保つ。
  expect(view.removed).toBe(false);
  expect(view.loaded).toHaveLength(0);
  expect(manager.listMounts()[0]?.phase).toBe("pending");
});

test("生成条件外は回収する", () => {
  const { manager } = setup();
  const dto = manager.createMount();
  const view = new FakeView(11, 7, "cef", false, null, null, dto.initialUrl);
  manager.handleTagCreated(view);
  expect(view.removed).toBe(true);
  expect(manager.listMounts()).toHaveLength(0);
});

test("重複する生成を回収する", () => {
  const { manager, channels } = setup();
  const dto = manager.createMount();
  const first = new FakeView(11, 7, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(first);
  // 同じ初期 URL の二度目の生成は重複であり、新しい側を回収する。
  const second = new FakeView(12, 7, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(second);
  expect(second.removed).toBe(true);
  expect(first.removed).toBe(false);
  expect(channels.has(dto.mountId)).toBe(true);
});

test("退役済みの遅延生成を回収する", () => {
  const { manager, channels } = setup();
  const dto = manager.createMount();
  manager.destroyMount(dto.mountId);
  // 初期化途中の削除の後に届いた遅延生成は結線しない。
  const late = new FakeView(11, 7, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(late);
  expect(late.removed).toBe(true);
  expect(channels.has(dto.mountId)).toBe(false);
  expect(manager.listMounts()).toHaveLength(0);
});

test("由来不明の生成を回収する", () => {
  const { manager } = setup();
  const view = new FakeView(11, 7, "native", false, null, null, buildBlankUrl("spike-999"));
  manager.handleTagCreated(view);
  expect(view.removed).toBe(true);
});

test("採用通知で準備完了とし当該 mount だけに送る", () => {
  const { manager, channels, hooks } = setup();
  const first = manager.createMount();
  const second = manager.createMount();
  manager.handleTagCreated(new FakeView(11, 7, "native", false, null, null, first.initialUrl));
  manager.handleTagCreated(new FakeView(12, 7, "native", false, null, null, second.initialUrl));
  hooks.get(first.mountId)?.handleReady(first.mountId);
  // 通知した側だけが準備完了となり、push も当該 mount だけに届く。
  expect(manager.listMounts().find((mount) => mount.mountId === first.mountId)?.ready).toBe(true);
  expect(manager.listMounts().find((mount) => mount.mountId === second.mountId)?.ready).toBe(false);
  expect(channels.get(first.mountId)?.pushed).toHaveLength(1);
  expect(channels.get(second.mountId)?.pushed).toHaveLength(0);
  // 状態取得は結線済みの snapshot を返す。
  expect(hooks.get(first.mountId)?.handleGetState(first.mountId)).toEqual({
    mountId: first.mountId,
    revision: 1,
  });
});

test("破棄で所有と表示を残さない", () => {
  const { manager, hooks } = setup();
  const dto = manager.createMount();
  const view = new FakeView(11, 7, "native", false, null, null, dto.initialUrl);
  manager.handleTagCreated(view);
  manager.destroyMount(dto.mountId);
  expect(view.removed).toBe(true);
  expect(manager.listMounts()).toHaveLength(0);
  // 破棄後の取得・通知は拒否する（購読の残存を使えない）。
  expect(() => manager.snapshotOf(dto.mountId)).toThrow(RangeError);
  expect(() => hooks.get(dto.mountId)?.handleReady(dto.mountId)).toThrow(RangeError);
});

test("全破棄で残存を残さない", () => {
  const { manager } = setup();
  const first = manager.createMount();
  const second = manager.createMount();
  const firstView = new FakeView(11, 7, "native", false, null, null, first.initialUrl);
  manager.handleTagCreated(firstView);
  manager.resetAll("検証");
  expect(firstView.removed).toBe(true);
  expect(manager.listMounts()).toHaveLength(0);
  expect(manager.size).toBe(0);
  // 全破棄後も連番は巻き戻さない。
  expect(manager.createMount().mountId).not.toBe(first.mountId);
  expect(manager.createMount().mountId).not.toBe(second.mountId);
});

test("不明な操作を拒否する", () => {
  const { manager } = setup();
  expect(() => manager.destroyMount("spike-999")).toThrow(RangeError);
  expect(() => manager.destroyMount("")).toThrow(RangeError);
  expect(() => manager.pushMount("spike-999")).toThrow(RangeError);
});

test("URL の断片から識別子を読む", () => {
  expect(parseMountId(buildBlankUrl("spike-3"))).toBe("spike-3");
  // 形式外・空・断片無しは受け付けない。
  expect(parseMountId("views://plugin-host/blank.html")).toBe(null);
  expect(parseMountId(null)).toBe(null);
  expect(parseMountId("views://plugin-host/blank.html#mount=")).toBe(null);
  expect(parseMountId("views://plugin-host/blank.html#mount=other-1")).toBe(null);
});
