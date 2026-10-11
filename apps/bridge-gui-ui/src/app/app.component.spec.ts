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
// 受付・子画面作成）だけを持つ。主張は、入れ物の呼び出し項目と代役表の
// 項目が一致することで成り立つ。
function prepareServiceStub() {
  return {
    snapshot: signal(makeSnapshot({ revision: 5 })),
    fetchInitial: vi.fn(async () => {}),
    notifyReady: vi.fn(),
    enableAcceptance: vi.fn(async () => {}),
    disableAcceptance: vi.fn(async () => {}),
    createSpike: vi.fn(async (_host: HTMLElement) => {}),
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
});
