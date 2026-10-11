import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { makeSnapshot } from "./snapshot-fixture.ts";
import { StatusSummaryComponent } from "./status-summary.component.ts";

// 採用中の表示状態の要約描画。件数・改訂番号だけを確かめる。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [StatusSummaryComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("状態要約の表示", () => {
  it("取得済みの表示状態の件数と改訂番号を描画する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.componentRef.setInput(
      "snapshot",
      makeSnapshot({
        revision: 7,
        admission: { accepting: true },
        pending: [{ requestId: "表示してはいけない識別子" }],
      }),
    );
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("7");
    expect(text).toContain("受付中");
    expect(text).toContain("1 件");
    expect(text).not.toContain("表示してはいけない識別子");
  });

  it("未取得の間は未取得と出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("未取得");
  });
});
