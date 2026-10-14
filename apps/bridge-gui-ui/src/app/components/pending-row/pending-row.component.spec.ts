import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { PendingRowComponent } from "./pending-row.component.ts";

// 保留行の描画と要求の送出。行は emit するだけで取得・判定は行わない。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PendingRowComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 表示中の入力欄へ比較コードを入れる。整形しない。 */
function fillCode(root: HTMLElement, code: string): void {
  const field = root.querySelector("input") as HTMLInputElement | null;
  if (field !== null) {
    field.value = code;
    field.dispatchEvent(new Event("input"));
  }
}

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

  it("承認では入力欄の比較コードを先頭ゼロのまま載せる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    fillCode(root, "041003");
    fixture.detectChanges();
    let approved: unknown[] = [];
    fixture.componentInstance.approveRequested.subscribe((request) => {
      approved = [...approved, request];
    });
    findButton(root, "承認する")?.click();
    expect(approved).toEqual([{ requestId: "r1", code: "041003" }]);
  });

  it("表示と取下げの要求を送出するだけである", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    let shown: string[] = [];
    let rejected: string[] = [];
    fixture.componentInstance.showRequested.subscribe((requestId) => {
      shown = [...shown, requestId];
    });
    fixture.componentInstance.rejectRequested.subscribe((requestId) => {
      rejected = [...rejected, requestId];
    });
    findButton(root, "比較コードを表示する")?.click();
    findButton(root, "取り下げる")?.click();
    expect(shown).toEqual(["r1"]);
    expect(rejected).toEqual(["r1"]);
  });

  it("取得不能時は理由を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingRowComponent);
    fixture.componentRef.setInput("requestId", "r1");
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
