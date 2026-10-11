import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { PendingListComponent } from "./pending-list.component.ts";

// 保留一覧の描画と要求の送出。入力値は行が保持し、親の更新で失わせない。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PendingListComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("保留一覧の表示", () => {
  it("保留が無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("保留は無い");
  });

  it("要求識別子ごとに操作を出し表示要求を送出する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("r1");
    let shown: string[] = [];
    fixture.componentInstance.showRequested.subscribe((requestId) => {
      shown = [...shown, requestId];
    });
    const showButton = Array.from(root.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("比較コードを表示する"),
    );
    showButton?.click();
    expect(shown).toEqual(["r1"]);
  });

  it("承認では入力欄の比較コードを載せる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const field = root.querySelector("input") as HTMLInputElement | null;
    field?.focus();
    if (field !== null) {
      field.value = "041003";
      field.dispatchEvent(new Event("input"));
    }
    fixture.detectChanges();
    let approved: unknown[] = [];
    fixture.componentInstance.approveRequested.subscribe((request) => {
      approved = [...approved, request];
    });
    const approveButton = Array.from(root.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("承認する"),
    );
    approveButton?.click();
    expect(approved).toEqual([{ requestId: "r1", code: "041003" }]);
  });

  it("状態更新でも入力値と行の同一性を保つ", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.detectChanges();
    const before = fixture.nativeElement as HTMLElement;
    const fieldBefore = before.querySelector("input") as HTMLInputElement | null;
    if (fieldBefore !== null) {
      fieldBefore.value = "041003";
      fieldBefore.dispatchEvent(new Event("input"));
    }
    fixture.detectChanges();
    // 保留は同じで表示だけ更新する（改訂が進んだ場合の写し）。
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: true, requestId: "r1", code: "x", displayCode: "y" }]]),
    );
    fixture.detectChanges();
    const after = fixture.nativeElement as HTMLElement;
    const fieldAfter = after.querySelector("input") as HTMLInputElement | null;
    expect(fieldAfter?.value).toBe("041003");
    expect(fieldAfter?.isSameNode(fieldBefore)).toBe(true);
  });

  it("取得不能時は理由だけを出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: false, reason: "承認済みのため取得できない" }]]),
    );
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("取得できない");
    expect(text).toContain("承認済みのため取得できない");
  });
});
