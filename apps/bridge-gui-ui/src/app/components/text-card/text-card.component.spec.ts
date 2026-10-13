import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { OwnedPluginInstanceSummary } from "bridge-gui-contract/management";
import { TextCardComponent } from "./text-card.component.ts";

// テキスト所有カードの描画。割当て／解除の可否と段階だけを示す。
// 送信状態・結果・統計は載せない（子画面で確認する）。本文は扱わない。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [TextCardComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 試験用の所有記録。 */
function ownedOf(overrides?: Partial<OwnedPluginInstanceSummary>): OwnedPluginInstanceSummary {
  return {
    pluginKind: "text",
    pluginId: "text",
    instanceId: "i1",
    localSessionId: "s1",
    portId: "text",
    phase: "active",
    ...overrides,
  };
}

describe("テキスト所有カードの表示", () => {
  it("未取得の間は未取得と出し割当てだけ押せる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("未取得");
    const buttons = root.querySelectorAll("button");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("未割当ての間は割当てだけ押せて解除は押せない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("fetched", true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("未割当て");
    const buttons = root.querySelectorAll("button");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("割当て中は解除だけ押せて割当ては押せない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("fetched", true);
    fixture.componentRef.setInput("owned", ownedOf());
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("s1");
    expect(root.textContent).toContain("割当て中");
    const buttons = root.querySelectorAll("button");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("回収失敗は割当て済み扱いで両方押せず未回収と出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("fetched", true);
    fixture.componentRef.setInput("owned", ownedOf({ phase: "cleanupFailed" }));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("回収失敗");
    const buttons = root.querySelectorAll("button");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("操作失敗の説明を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("fetched", true);
    fixture.componentRef.setInput("error", "操作に失敗した: 割当て不可");
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("操作に失敗した: 割当て不可");
  });

  it("押すと割当てと三識別子の解除要求が出る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("fetched", true);
    fixture.componentRef.setInput("owned", ownedOf());
    fixture.detectChanges();
    let assigned = 0;
    fixture.componentInstance.assignRequested.subscribe(() => {
      assigned += 1;
    });
    const triples: unknown[] = [];
    fixture.componentInstance.unassignRequested.subscribe((request) => {
      triples.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    const buttons = root.querySelectorAll("button");
    (buttons[1] as HTMLButtonElement).click();
    expect(assigned).toBe(0);
    expect(triples).toEqual([{ instanceId: "i1", localSessionId: "s1", portId: "text" }]);
  });
});
