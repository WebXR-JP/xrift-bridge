import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { PendingRowComponent } from "./pending-row.component.ts";

// 保留行の描画と要求の送出。行は emit するだけで取得・判定は行わない。
// 比較コードの入力欄は持たず、自動取得の状態だけを示す。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PendingRowComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 標題に一致する操作ボタンを返す。 */
function findButton(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").includes(label),
  );
}

describe("保留行の表示", () => {
  it("要求識別子と取得済みの比較コードを描画する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.componentRef.setInput("codeState", "ready");
    fixture.componentRef.setInput("view", {
      available: true,
      requestId: "r1",
      code: "041003",
      displayCode: "041-003",
    });
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("r1");
    expect(text).toContain("041-003");
  });

  it("入力欄と表示ボタンを持たない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.componentRef.setInput("codeState", "ready");
    fixture.componentRef.setInput("view", {
      available: true,
      requestId: "r1",
      code: "041003",
      displayCode: "041-003",
    });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector("input")).toBe(null);
    expect(findButton(root, "比較コードを表示する")).toBe(undefined);
  });

  it("未取得と取得中は取得中表示であり承認は押せない", async () => {
    await TestBed.compileComponents();
    for (const state of ["unfetched", "fetching"] as const) {
      const fixture = TestBed.createComponent(PendingRowComponent);
      fixture.componentRef.setInput("requestId", "r1");
      fixture.componentRef.setInput("codeState", state);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.textContent).toContain("取得しています");
      expect(findButton(root, "承認する")?.disabled).toBe(true);
      expect(findButton(root, "再試行")).toBe(undefined);
    }
  });

  it("取得後は追加入力なしで承認でき要求識別子だけを載せる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.componentRef.setInput("codeState", "ready");
    fixture.componentRef.setInput("view", {
      available: true,
      requestId: "r1",
      code: "041003",
      displayCode: "041-003",
    });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(findButton(root, "承認する")?.disabled).toBe(false);
    let approved: unknown[] = [];
    fixture.componentInstance.approveRequested.subscribe((requestId) => {
      approved = [...approved, requestId];
    });
    findButton(root, "承認する")?.click();
    expect(approved).toEqual(["r1"]);
  });

  it("取得失敗時は短い失敗表示と再試行を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.componentRef.setInput("codeState", "failed");
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("取得に失敗した");
    expect(findButton(root, "承認する")?.disabled).toBe(true);
    let retried: string[] = [];
    fixture.componentInstance.retryRequested.subscribe((requestId) => {
      retried = [...retried, requestId];
    });
    findButton(root, "再試行")?.click();
    expect(retried).toEqual(["r1"]);
  });

  it("取下げの要求を送出するだけである", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.componentRef.setInput("codeState", "ready");
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    let rejected: string[] = [];
    fixture.componentInstance.rejectRequested.subscribe((requestId) => {
      rejected = [...rejected, requestId];
    });
    findButton(root, "取り下げる")?.click();
    expect(rejected).toEqual(["r1"]);
  });

  it("取得不能時は理由を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.componentRef.setInput("codeState", "failed");
    fixture.componentRef.setInput("view", {
      available: false,
      reason: "承認済みのため取得できない",
    });
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("取得できない");
    expect(text).toContain("承認済みのため取得できない");
  });
});
