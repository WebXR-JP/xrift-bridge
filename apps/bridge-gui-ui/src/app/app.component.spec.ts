import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import { AppComponent } from "./app.component.ts";
import { ManagementService } from "./management.service.ts";
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
    textError: signal(""),
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
    assignDiagnostics: vi.fn(async (_localSessionId: string) => {}),
    assignText: vi.fn(async () => {}),
    unassignText: vi.fn(async () => {}),
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
    expect(text).toContain("テキスト送信");
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
