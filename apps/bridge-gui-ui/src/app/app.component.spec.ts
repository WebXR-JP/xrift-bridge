import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ComponentFixture } from "@angular/core/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import { AppComponent } from "./app.component.ts";
import { ManagementService } from "./Services/management.service.ts";
import { makeSnapshot } from "./snapshot-fixture.ts";

// 入れ物の起動時の振る舞い。初回取得と準備完了通知だけを行い、
// 起動時の自動走行（受付の往復・子画面作成）はしないことを確かめる。

// ADR: `as` は実行時の検証にならないため、主張する型が成立する根拠を残す。
// 代役は入れ物の試験用であり、入れ物が使う項目（表示信号・初回取得・通知・
// 受付・保留・接続・セッション・テキスト・終了・子画面作成）だけを持つ。
// 主張は、入れ物の呼び出し項目と代役表の項目が一致することで成り立つ。
function prepareServiceStub() {
  return {
    snapshot: signal(makeSnapshot({ revision: 5 })),
    pairingViews: signal(new Map()),
    eventLog: signal([] as readonly string[]),
    spikeMounts: signal([] as readonly never[]),
    fetchInitial: vi.fn(async () => {}),
    notifyReady: vi.fn(),
    registerMountHosts: vi.fn((_spike: HTMLElement, _plugin: HTMLElement) => {}),
    refreshSpike: vi.fn(async (_via: string) => {}),
    enableAcceptance: vi.fn(async () => {}),
    disableAcceptance: vi.fn(async () => {}),
    showPairingView: vi.fn(async (_requestId: string) => {}),
    approvePairing: vi.fn(async (_requestId: string, _code: string) => {}),
    rejectPairing: vi.fn(async (_requestId: string) => {}),
    disconnectConnection: vi.fn(async (_connectionId: string) => {}),
    assignPlugin: vi.fn(async (_pluginKind: string, _localSessionId?: string) => {}),
    unassignPlugin: vi.fn(
      async (_instanceId: string, _localSessionId: string, _portId: string) => {},
    ),
    quit: vi.fn(async () => {}),
    createSpike: vi.fn(async () => {}),
    pushSpike: vi.fn(async (_mountId: string) => {}),
    destroySpike: vi.fn(async (_mountId: string) => {}),
    resetSpikes: vi.fn(async () => {}),
    retryPluginMounts: vi.fn(async () => {}),
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
  it("初回取得と準備完了通知だけを行い自動走行しない", async () => {
    const { stub } = await prepareRoot();
    expect(stub.fetchInitial).toHaveBeenCalledTimes(1);
    expect(stub.notifyReady).toHaveBeenCalledTimes(1);
    expect(stub.enableAcceptance).not.toHaveBeenCalled();
    expect(stub.disableAcceptance).not.toHaveBeenCalled();
    expect(stub.createSpike).not.toHaveBeenCalled();
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

  it("子画面の一覧と配置先を描画し初期化で所有を読み直す", async () => {
    const { fixture, stub } = await prepareRoot();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("実プラグイン");
    expect(text).toContain("段0スパイク");
    expect(fixture.nativeElement.querySelector("#spike-host")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("#plugin-host")).not.toBe(null);
    expect(stub.registerMountHosts).toHaveBeenCalledTimes(1);
    expect(stub.refreshSpike).toHaveBeenCalledWith("初期化");
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
  it("5つのナビ項目があり初期は接続を選ぶ", async () => {
    const { fixture } = await prepareRoot();
    const root = fixture.nativeElement as HTMLElement;
    const navButtons = root.querySelectorAll("nav button[data-nav-key]");
    expect(navButtons.length).toBe(5);
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
    expect(panelOf(fixture, "log").classList.contains("hidden")).toBe(true);
    expect(root.querySelector("header h1")?.textContent).toContain("セッション一覧");
    // 常時マウントのため、非表示パネルの部品も破棄されない。
    expect(panelOf(fixture, "connections").querySelector("app-status-summary")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("#spike-host")).not.toBe(null);
    expect(fixture.nativeElement.querySelector("#plugin-host")).not.toBe(null);
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

  it("パネル切替が業務RPCを送らない", async () => {
    const { fixture, stub } = await prepareRoot();
    for (const key of ["sessions", "plugins", "operations", "log", "connections"]) {
      selectView(fixture, key);
    }
    await fixture.whenStable();
    expect(stub.fetchInitial).toHaveBeenCalledTimes(1);
    expect(stub.enableAcceptance).not.toHaveBeenCalled();
    expect(stub.disableAcceptance).not.toHaveBeenCalled();
    expect(stub.showPairingView).not.toHaveBeenCalled();
    expect(stub.approvePairing).not.toHaveBeenCalled();
    expect(stub.rejectPairing).not.toHaveBeenCalled();
    expect(stub.disconnectConnection).not.toHaveBeenCalled();
    expect(stub.assignPlugin).not.toHaveBeenCalled();
    expect(stub.unassignPlugin).not.toHaveBeenCalled();
    expect(stub.quit).not.toHaveBeenCalled();
    expect(stub.createSpike).not.toHaveBeenCalled();
    expect(stub.pushSpike).not.toHaveBeenCalled();
    expect(stub.destroySpike).not.toHaveBeenCalled();
    expect(stub.resetSpikes).not.toHaveBeenCalled();
    expect(stub.retryPluginMounts).not.toHaveBeenCalled();
  });
});
