import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ComponentFixture } from "@angular/core/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import { AppComponent } from "./app.component.ts";
import { ManagementService } from "./Services/management.service.ts";
import type { EventLogEntry } from "./Services/management.service.ts";
import type { PluginViewState } from "./plugin-view-state.ts";
import { makeSnapshot } from "./snapshot-fixture.ts";

// 入れ物の起動時の振る舞い。初回取得だけを行い、
// 起動時の自動走行（受付の往復・子画面作成）はしないことを確かめる。

// ADR: `as` は実行時の検証にならないため、主張する型が成立する根拠を残す。
// 代役は入れ物の試験用であり、入れ物が使う項目（表示信号・初回取得・通知・
// 受付・保留・接続・セッション・テキスト・終了・個体限定再試行・再読み込み）
// だけを持つ。主張は、入れ物の呼び出し項目と代役表の項目が一致することで成り立つ。
function prepareServiceStub() {
  return {
    snapshot: signal(makeSnapshot({ revision: 5 })),
    pairingViews: signal(new Map()),
    pairingFetchPending: signal([] as readonly string[]),
    pairingFetchFailed: signal([] as readonly string[]),
    eventLog: signal([] as readonly EventLogEntry[]),
    pluginError: signal(""),
    localMcpStatus: signal(null),
    localMcpError: signal(""),
    localMcpEnablePending: signal(false),
    localMcpDisablePending: signal(false),
    pluginViewStateFor: vi.fn((_instanceId: string | null): PluginViewState => ({
      kind: "preparing",
    })),
    fetchInitial: vi.fn(async () => {}),
    registerPluginHost: vi.fn((_plugin: HTMLElement) => {}),
    setPluginViewState: vi.fn(async (_visible: boolean, _activeInstanceId: string | null) => {}),
    enableAcceptance: vi.fn(async () => {}),
    disableAcceptance: vi.fn(async () => {}),
    retryPairingView: vi.fn(async (_requestId: string) => {}),
    approvePairing: vi.fn(async (_requestId: string) => {}),
    rejectPairing: vi.fn(async (_requestId: string) => {}),
    disconnectConnection: vi.fn(async (_connectionId: string) => {}),
    assignPlugin: vi.fn(async (_pluginKind: string, _localSessionId?: string) => {}),
    unassignPlugin: vi.fn(
      async (_instanceId: string, _localSessionId: string, _portId: string) => {},
    ),
    quit: vi.fn(async () => {}),
    retryPluginMount: vi.fn(async (_instanceId: string) => {}),
    reloadSnapshot: vi.fn(async () => {}),
    fetchLocalMcpStatus: vi.fn(async () => {}),
    enableLocalMcp: vi.fn(async () => {}),
    disableLocalMcp: vi.fn(async () => {}),
  };
}

async function prepareRoot() {
  const stub = prepareServiceStub();
  TestBed.configureTestingModule({
    imports: [AppComponent],
    providers: [provideZonelessChangeDetection(), { provide: ManagementService, useValue: stub }],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(AppComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, stub };
}

describe("入れ物の起動", () => {
  it("初回取得だけを行い自動走行しない", async () => {
    const { stub } = await prepareRoot();
    expect(stub.fetchInitial).toHaveBeenCalledTimes(1);
    expect(stub.fetchLocalMcpStatus).toHaveBeenCalledTimes(1);
    expect(stub.enableAcceptance).not.toHaveBeenCalled();
    expect(stub.disableAcceptance).not.toHaveBeenCalled();
    expect(stub.enableLocalMcp).not.toHaveBeenCalled();
    expect(stub.disableLocalMcp).not.toHaveBeenCalled();
  });

  it("状態要約と受付操作を描画する", async () => {
    const { fixture } = await prepareRoot();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("状態");
    expect(text).toContain("受付");
    expect(text).toContain("5");
  });

  it("管理機能の一覧と終了・受信記録を描画する", async () => {
    const { fixture } = await prepareRoot();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("保留");
    expect(text).toContain("接続");
    expect(text).toContain("生存セッション");
    expect(text).toContain("使用可能なプラグイン");
    expect(text).toContain("起動中のプラグイン");
    expect(text).toContain("終了");
    expect(text).toContain("受信記録");
  });

  it("子画面スロットと配置先を描画し単一hostだけを登録する", async () => {
    const { fixture, stub } = await prepareRoot();
    expect(fixture.nativeElement.querySelector("#plugin-slot")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("#plugin-host")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("app-plugin-view-fallback")).not.toBe(null);
    // 撤去した要素は残らない。
    expect(fixture.nativeElement.querySelector("#spike-host")).toBe(null);
    expect(fixture.nativeElement.querySelector("app-plugin-mounts")).toBe(null);
    expect(fixture.nativeElement.querySelector("app-spike-section")).toBe(null);
    expect(stub.registerPluginHost).toHaveBeenCalledTimes(1);
  });
});

// 2カラム化後の画面選択。5パネルは常時マウントし、表示切替だけを行う。
// 切替は業務 RPC を送らず、snapshot 更新で選択は戻らないことを確かめる。

/** パネル要素を求める。常時マウントのため、欠けてはならない。 */
function panelOf(fixture: ComponentFixture<AppComponent>, key: string): HTMLElement {
  const root = fixture.nativeElement as HTMLElement;
  const panel = root.querySelector(`[data-panel="${key}"]`);
  if (panel === null) {
    throw new Error(`パネルが無い: ${key}`);
  }
  return panel as HTMLElement;
}

/** ナビ項目を押す。表示切替だけであり、業務 RPC は送らない。 */
function selectView(fixture: ComponentFixture<AppComponent>, key: string): void {
  const root = fixture.nativeElement as HTMLElement;
  const button = root.querySelector(`nav button[data-nav-key="${key}"]`);
  if (button === null) {
    throw new Error(`ナビ項目が無い: ${key}`);
  }
  (button as HTMLButtonElement).click();
  fixture.detectChanges();
}

describe("画面選択とパネル切替", () => {
  it("6つのナビ項目があり初期は接続を選ぶ", async () => {
    const { fixture } = await prepareRoot();
    const root = fixture.nativeElement as HTMLElement;
    const navButtons = root.querySelectorAll("nav button[data-nav-key]");
    expect(navButtons.length).toBe(6);
    expect(
      root.querySelector('nav button[data-nav-key="connections"]')?.getAttribute("aria-current"),
    ).toBe("page");
    expect(panelOf(fixture, "connections").classList.contains("hidden")).toBe(false);
    expect(panelOf(fixture, "sessions").classList.contains("hidden")).toBe(true);
    expect(root.querySelector("header h1")?.textContent).toContain("接続");
  });

  it("選択切替で対応パネルだけが表示され他は非表示になる", async () => {
    const { fixture } = await prepareRoot();
    selectView(fixture, "sessions");
    const root = fixture.nativeElement as HTMLElement;
    expect(panelOf(fixture, "sessions").classList.contains("hidden")).toBe(false);
    expect(panelOf(fixture, "connections").classList.contains("hidden")).toBe(true);
    expect(panelOf(fixture, "plugins").classList.contains("hidden")).toBe(true);
    expect(panelOf(fixture, "operations").classList.contains("hidden")).toBe(true);
    expect(panelOf(fixture, "local-mcp").classList.contains("hidden")).toBe(true);
    expect(panelOf(fixture, "log").classList.contains("hidden")).toBe(true);
    expect(root.querySelector("header h1")?.textContent).toContain("セッション一覧");
    // 常時マウントのため、非表示パネルの部品も破棄されない。
    expect(panelOf(fixture, "connections").querySelector("app-status-summary")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("#plugin-host")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("#plugin-slot")).not.toBe(null);
  });

  it("選択はsnapshot更新で戻らない", async () => {
    const { fixture, stub } = await prepareRoot();
    selectView(fixture, "log");
    stub.snapshot.set(makeSnapshot({ revision: 9 }));
    fixture.detectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(panelOf(fixture, "log").classList.contains("hidden")).toBe(false);
    expect(panelOf(fixture, "connections").classList.contains("hidden")).toBe(true);
    expect(root.querySelector("header h1")?.textContent).toContain("受信記録");
  });

  it("pluginsパネルがプラグイン一覧を描画する", async () => {
    const { fixture } = await prepareRoot();
    selectView(fixture, "plugins");
    const panel = panelOf(fixture, "plugins");
    expect(panel.querySelector("app-plugin-list")).not.toBe(null);
    expect(panel.querySelector("app-text-card")).toBe(null);
    expect(panel.textContent).toContain("使用可能なプラグイン");
    expect(panel.textContent).toContain("起動中のプラグイン");
  });

  it("失敗表示の束縛をプラグイン一覧へ渡す", async () => {
    const { fixture, stub } = await prepareRoot();
    selectView(fixture, "plugins");
    // 失敗が無いときは出さない。
    expect(panelOf(fixture, "plugins").querySelector('[aria-live="polite"]')).toBe(null);
    // 失敗理由が一覧の先頭に polite で出る。
    stub.pluginError.set("操作に失敗した: 割当て不可");
    fixture.detectChanges();
    await fixture.whenStable();
    const panel = panelOf(fixture, "plugins");
    const status = panel.querySelector('[aria-live="polite"]');
    if (status === null) {
      throw new Error("失敗表示が一覧へ渡らない");
    }
    expect(status.textContent).toContain("割当て不可");
  });

  it("パネル切替が業務RPCを送らない", async () => {
    const { fixture, stub } = await prepareRoot();
    for (const key of ["sessions", "plugins", "operations", "local-mcp", "log", "connections"]) {
      selectView(fixture, key);
    }
    await fixture.whenStable();
    expect(stub.fetchInitial).toHaveBeenCalledTimes(1);
    expect(stub.enableAcceptance).not.toHaveBeenCalled();
    expect(stub.disableAcceptance).not.toHaveBeenCalled();
    expect(stub.retryPairingView).not.toHaveBeenCalled();
    expect(stub.approvePairing).not.toHaveBeenCalled();
    expect(stub.rejectPairing).not.toHaveBeenCalled();
    expect(stub.disconnectConnection).not.toHaveBeenCalled();
    expect(stub.assignPlugin).not.toHaveBeenCalled();
    expect(stub.unassignPlugin).not.toHaveBeenCalled();
    expect(stub.quit).not.toHaveBeenCalled();
    expect(stub.retryPluginMount).not.toHaveBeenCalled();
    expect(stub.reloadSnapshot).not.toHaveBeenCalled();
    expect(stub.enableLocalMcp).not.toHaveBeenCalled();
    expect(stub.disableLocalMcp).not.toHaveBeenCalled();
  });

  it("ローカル MCP パネルが常時マウントされ選択で表示される", async () => {
    const { fixture } = await prepareRoot();
    expect(panelOf(fixture, "local-mcp").classList.contains("hidden")).toBe(true);
    expect(panelOf(fixture, "local-mcp").querySelector("app-local-mcp-panel")).not.toBe(null);
    selectView(fixture, "local-mcp");
    expect(panelOf(fixture, "local-mcp").classList.contains("hidden")).toBe(false);
    expect(fixture.nativeElement.querySelector("header h1")?.textContent).toContain(
      "ローカル業務操作 MCP",
    );
  });
});

// プラグイン操作の選択と表示制御。タブ単位はインスタンスであり、
// 改訂進行・追加では選択を変えず、消滅時だけ移すことを確かめる。
// 表示切替は業務 RPC を送らず、表示制御への通知だけである。
// native の見え方は自動検証できない（DOM・RPC レベルまでである）。

/** 試験用の所有個体。 */
function instanceOf(
  instanceId: string,
  pluginKind = "text",
  localSessionId = "s1",
): {
  pluginKind: string;
  pluginId: string;
  instanceId: string;
  localSessionId: string;
  portId: string;
  phase: "active";
} {
  return {
    pluginKind,
    pluginId: pluginKind,
    instanceId,
    localSessionId,
    portId: pluginKind,
    phase: "active",
  };
}

/** 操作タブを押す。選択要求だけであり、業務 RPC は送らない。 */
function selectOperationTab(fixture: ComponentFixture<AppComponent>, index: number): void {
  const root = fixture.nativeElement as HTMLElement;
  const tabs = root.querySelectorAll('[data-panel="operations"] [role="tab"]');
  const tab = tabs[index];
  if (tab === undefined || !(tab instanceof HTMLButtonElement)) {
    throw new Error(`操作タブが無い: ${index}`);
  }
  tab.click();
  fixture.detectChanges();
}

describe("プラグイン操作の選択と表示制御", () => {
  it("初期は非表示から始まりoperations選択時のみ表示する", async () => {
    const { fixture, stub } = await prepareRoot();
    // 初期（connections 選択）は非表示である。
    expect(stub.setPluginViewState).toHaveBeenCalledTimes(1);
    expect(stub.setPluginViewState.mock.calls[0]?.[0]).toBe(false);
    expect(stub.setPluginViewState.mock.calls[0]?.[1]).toBe(null);
    stub.setPluginViewState.mockClear();
    selectView(fixture, "operations");
    await fixture.whenStable();
    const last = stub.setPluginViewState.mock.calls.at(-1);
    expect(last?.[0]).toBe(true);
    selectView(fixture, "log");
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it("初期選択はtext種別であり無ければ先頭である", async () => {
    const { fixture, stub } = await prepareRoot();
    stub.snapshot.set(
      makeSnapshot({
        revision: 6,
        plugins: {
          kinds: [],
          instances: [instanceOf("i-diag", "diagnostic"), instanceOf("i-text", "text")],
          assignments: [],
        },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const last = stub.setPluginViewState.mock.calls.at(-1);
    expect(last?.[1]).toBe("i-text");
    stub.snapshot.set(
      makeSnapshot({
        revision: 7,
        plugins: {
          kinds: [],
          instances: [instanceOf("i-a", "diagnostic"), instanceOf("i-b", "diagnostic")],
          assignments: [],
        },
      }),
    );
    stub.setPluginViewState.mockClear();
    // 所有が入れ替わって選択が消えた場合は残存の先頭へ移す。
    fixture.detectChanges();
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)?.[1]).toBe("i-a");
  });

  it("改訂進行・別個体追加では選択を変えない", async () => {
    const { fixture, stub } = await prepareRoot();
    stub.snapshot.set(
      makeSnapshot({
        revision: 6,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)?.[1]).toBe("i1");
    const callsAfterSelect = stub.setPluginViewState.mock.calls.length;
    // 改訂だけが進んでも選択は変わらない。
    stub.snapshot.set(
      makeSnapshot({
        revision: 7,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    // 別個体が増えても選択は変わらない。
    stub.snapshot.set(
      makeSnapshot({
        revision: 8,
        plugins: {
          kinds: [],
          instances: [instanceOf("i1"), instanceOf("i2", "text", "s2")],
          assignments: [],
        },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.activeInstanceId()).toBe("i1");
    // 選択が変わらないため、新たな通知があっても対象は変わらない。
    for (const call of stub.setPluginViewState.mock.calls.slice(callsAfterSelect)) {
      expect(call[1]).toBe("i1");
    }
  });

  it("選択個体が消えたときだけ残存個体へ移し所有0ならnullである", async () => {
    const { fixture, stub } = await prepareRoot();
    stub.snapshot.set(
      makeSnapshot({
        revision: 6,
        plugins: {
          kinds: [],
          instances: [instanceOf("i1"), instanceOf("i2", "text", "s2")],
          assignments: [],
        },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)?.[1]).toBe("i1");
    // i1 が消えたら残存へ移す。
    stub.snapshot.set(
      makeSnapshot({
        revision: 7,
        plugins: { kinds: [], instances: [instanceOf("i2", "text", "s2")], assignments: [] },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)?.[1]).toBe("i2");
    // 所有が0なら `null` である。
    stub.snapshot.set(makeSnapshot({ revision: 8 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)?.[1]).toBe(null);
  });

  it("タブ切替は表示制御だけであり業務RPCを送らずhostの同一性を保つ", async () => {
    const { fixture, stub } = await prepareRoot();
    stub.snapshot.set(
      makeSnapshot({
        revision: 6,
        plugins: {
          kinds: [],
          instances: [instanceOf("i1"), instanceOf("i2", "text", "s2")],
          assignments: [],
        },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    selectView(fixture, "operations");
    const pluginHostBefore = fixture.nativeElement.querySelector("#plugin-host");
    const slotBefore = fixture.nativeElement.querySelector("#plugin-slot");
    expect(pluginHostBefore).not.toBe(null);
    expect(slotBefore).not.toBe(null);
    selectOperationTab(fixture, 1);
    await fixture.whenStable();
    expect(stub.setPluginViewState.mock.calls.at(-1)).toEqual([true, "i2"]);
    // `#plugin-host` を `@if` に入れないため、参照は保たれる。
    expect(fixture.nativeElement.querySelector("#plugin-host")).toBe(pluginHostBefore);
    expect(fixture.nativeElement.querySelector("#plugin-slot")).toBe(slotBefore);
    expect(fixture.nativeElement.querySelector("#spike-host")).toBe(null);
    expect(stub.fetchInitial).toHaveBeenCalledTimes(1);
    expect(stub.assignPlugin).not.toHaveBeenCalled();
    expect(stub.unassignPlugin).not.toHaveBeenCalled();
    expect(stub.retryPluginMount).not.toHaveBeenCalled();
  });

  it("起動処理は1回でありoperations部品とスロットを描画する", async () => {
    const { fixture, stub } = await prepareRoot();
    selectView(fixture, "operations");
    const panel = panelOf(fixture, "operations");
    expect(panel.querySelector("app-plugin-operations")).not.toBe(null);
    expect(panel.querySelector("app-plugin-view-fallback")).not.toBe(null);
    expect(panel.querySelector("#plugin-slot")).not.toBe(null);
    expect(panel.querySelector("#plugin-host")).not.toBe(null);
    expect(panel.querySelector("app-plugin-mounts")).toBe(null);
    expect(panel.querySelector("app-spike-section")).toBe(null);
    expect(stub.fetchInitial).toHaveBeenCalledTimes(1);
    expect(stub.registerPluginHost).toHaveBeenCalledTimes(1);
  });

  it("スロットは子画面タグの入れ物と代替表示を常時置く", async () => {
    const { fixture } = await prepareRoot();
    selectView(fixture, "operations");
    const slot = panelOf(fixture, "operations").querySelector("#plugin-slot");
    if (slot === null) {
      throw new Error("スロットが無い");
    }
    // 差し替えるのは表示だけであり、host は `@if` に入れない。
    expect(slot.querySelector("#plugin-host")).not.toBe(null);
    expect(slot.querySelector("app-plugin-view-fallback")).not.toBe(null);
    expect(slot.getAttribute("role")).toBe("tabpanel");
  });

  it("代替表示の再試行は選択個体だけに作用する", async () => {
    const { fixture, stub } = await prepareRoot();
    stub.snapshot.set(
      makeSnapshot({
        revision: 6,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    selectView(fixture, "operations");
    const fallback = fixture.nativeElement.querySelector("app-plugin-view-fallback");
    if (fallback === null) {
      throw new Error("代替表示が無い");
    }
    // 代替表示の再試行は App 経由で選択個体だけに送る。
    await fixture.componentInstance.onRetryPluginView();
    expect(stub.retryPluginMount).toHaveBeenCalledWith("i1");
    expect(stub.retryPluginMount).toHaveBeenCalledTimes(1);
  });

  it("代替表示の再読み込みは表示状態を読み直す", async () => {
    const { fixture, stub } = await prepareRoot();
    await fixture.componentInstance.onReloadSnapshot();
    expect(stub.reloadSnapshot).toHaveBeenCalledTimes(1);
  });
});
