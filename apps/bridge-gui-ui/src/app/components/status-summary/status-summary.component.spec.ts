import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { makeSnapshot } from "../../snapshot-fixture.ts";
import { StatusSummaryComponent } from "./status-summary.component.ts";

// 採用中の表示状態の要約描画。件数・改訂番号だけを確かめる。
// 比較コード本文・業務 payload は要約に出さない。

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

  it("公開先の URL と受付中・停止中を描画する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.componentRef.setInput(
      "snapshot",
      makeSnapshot({ endpoint: { url: "http://127.0.0.1:1", listening: true } }),
    );
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("http://127.0.0.1:1");
    expect(text).toContain("受付中");
  });

  it("未公開の公開先と割当ての件数を描画する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.componentRef.setInput(
      "snapshot",
      makeSnapshot({
        endpoint: null,
        plugins: {
          kinds: [],
          instances: [
            {
              pluginKind: "diagnostic",
              pluginId: "diagnostic",
              instanceId: "i1",
              localSessionId: "s1",
              portId: "diagnostic",
              phase: "active",
            },
          ],
          assignments: [{ localSessionId: "s1", instanceId: "i1", portId: "diagnostic" }],
        },
      }),
    );
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("未公開");
    expect(text).toContain("実体 1");
    expect(text).toContain("割当て 1");
  });

  it("全所有記録の識別子と種別と段階を描画する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.componentRef.setInput(
      "snapshot",
      makeSnapshot({
        plugins: {
          kinds: [],
          instances: [
            {
              pluginKind: "text",
              pluginId: "text",
              instanceId: "i9",
              localSessionId: "s9",
              portId: "text",
              phase: "cleanupFailed",
            },
          ],
          assignments: [],
        },
      }),
    );
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("i9");
    expect(text).toContain("text");
    expect(text).toContain("cleanupFailed");
  });

  it("未取得の間は未取得と出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("未取得");
  });

  it("見出しを helm accordion の trigger に載せ初期展開で出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(StatusSummaryComponent);
    fixture.componentRef.setInput("snapshot", makeSnapshot({ revision: 3 }));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector("[data-slot='accordion-trigger']");
    expect(trigger?.textContent).toContain("状態");
    // 初期展開のため内容（改訂番号の値）がそのまま読める。
    expect(root.textContent).toContain("3");
  });
});
