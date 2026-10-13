import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { makeSnapshot } from "../../snapshot-fixture.ts";
import { TextCardComponent } from "./text-card.component.ts";

// 固定テキストカードの描画。割当て／解除の可否と直近結果・統計を示す。
// 本文は扱わない（失敗の説明だけを出す）。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [TextCardComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 試験用の割当て中状態を取り出す。 */
function assignedText() {
  return makeSnapshot().text;
}

describe("固定テキストカードの表示", () => {
  it("未割当ての間は割当てだけ押せて解除は押せない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: null,
      instanceId: null,
    });
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
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: "s1",
      instanceId: "i1",
      canSend: true,
    });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("s1");
    expect(root.textContent).toContain("送信可能");
    const buttons = root.querySelectorAll("button");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("実行中は応答待ちを示す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: "s1",
      instanceId: "i1",
      canSend: false,
      pendingId: "p1",
    });
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("実行中");
    expect(text).toContain("p1");
  });

  it("反映確認と結果不明の理由を短い説明で出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: "s1",
      instanceId: "i1",
      lastResult: { status: "acknowledged" },
      stats: { attempts: 2, acknowledged: 1, unknown: 1 },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("反映確認");
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: "s1",
      instanceId: "i1",
      lastResult: { status: "unknown", reason: "timeout" },
      stats: { attempts: 2, acknowledged: 1, unknown: 1 },
    });
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("応答期限切れ");
    expect(text).toContain("送信試行 2");
  });

  it("操作失敗の説明を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: null,
      instanceId: null,
    });
    fixture.componentRef.setInput("error", "操作に失敗した: 割当て不可");
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("操作に失敗した: 割当て不可");
  });

  it("押すと割当てと解除の要求が出る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(TextCardComponent);
    fixture.componentRef.setInput("text", {
      ...assignedText(),
      localSessionId: "s1",
      instanceId: "i1",
      canSend: true,
    });
    fixture.detectChanges();
    let unassigned = 0;
    fixture.componentInstance.unassignRequested.subscribe(() => {
      unassigned += 1;
    });
    const root = fixture.nativeElement as HTMLElement;
    const buttons = root.querySelectorAll("button");
    (buttons[1] as HTMLButtonElement).click();
    expect(unassigned).toBe(1);
  });
});
