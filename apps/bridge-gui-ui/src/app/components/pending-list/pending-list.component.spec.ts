import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { PendingListComponent } from "./pending-list.component.ts";

// 保留一覧の描画と要求の送出。取得状態は入力で受け、行へ渡すだけである。
// 比較コードの入力欄は持たず、自動取得と再試行だけを配線する。

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

  it("入力欄と表示ボタンを持たない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: true, requestId: "r1", code: "x", displayCode: "y" }]]),
    );
    fixture.componentRef.setInput("fetchPending", []);
    fixture.componentRef.setInput("fetchFailed", []);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector("input")).toBe(null);
    const labels = Array.from(root.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );
    expect(labels.some((label) => label.includes("比較コードを表示する"))).toBe(false);
  });

  it("複数行の要求識別子ごとに操作を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }, { requestId: "r2" }]);
    fixture.componentRef.setInput(
      "views",
      new Map([
        ["r1", { available: true, requestId: "r1", code: "x", displayCode: "y1" }],
        ["r2", { available: true, requestId: "r2", code: "x", displayCode: "y2" }],
      ]),
    );
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("r1");
    expect(root.textContent).toContain("r2");
    expect(root.textContent).toContain("y1");
    expect(root.textContent).toContain("y2");
  });

  it("承認では要求識別子だけを載せる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: true, requestId: "r1", code: "x", displayCode: "y" }]]),
    );
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    let approved: unknown[] = [];
    fixture.componentInstance.approveRequested.subscribe((requestId) => {
      approved = [...approved, requestId];
    });
    const approveButton = Array.from(root.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("承認する"),
    );
    approveButton?.click();
    expect(approved).toEqual(["r1"]);
  });

  it("取得中は承認不可であり取得後は承認可である", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput("fetchPending", ["r1"]);
    fixture.detectChanges();
    let root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("取得しています");
    const fetchingApprove = Array.from(root.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("承認する"),
    );
    expect(fetchingApprove?.disabled).toBe(true);
    // 取得後は承認できる。
    fixture.componentRef.setInput("fetchPending", []);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: true, requestId: "r1", code: "x", displayCode: "y" }]]),
    );
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
    const readyApprove = Array.from(root.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("承認する"),
    );
    expect(readyApprove?.disabled).toBe(false);
  });

  it("取得失敗時は再試行の要求を送出する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput("fetchFailed", ["r1"]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("取得に失敗した");
    let retried: string[] = [];
    fixture.componentInstance.retryRequested.subscribe((requestId) => {
      retried = [...retried, requestId];
    });
    const retryButton = Array.from(root.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("再試行"),
    );
    retryButton?.click();
    expect(retried).toEqual(["r1"]);
  });

  it("状態更新でも行の同一性を保つ", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput("fetchPending", ["r1"]);
    fixture.detectChanges();
    const before = (fixture.nativeElement as HTMLElement).querySelector("app-pending-row");
    // 保留は同じで表示だけ更新する（改訂が進んだ場合の写し）。
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput("fetchPending", []);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: true, requestId: "r1", code: "x", displayCode: "y" }]]),
    );
    fixture.detectChanges();
    const after = (fixture.nativeElement as HTMLElement).querySelector("app-pending-row");
    expect(after?.isSameNode(before)).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("y");
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

  it("行の操作は helm ボタンで描画し承認だけが primary である", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PendingListComponent);
    fixture.componentRef.setInput("pending", [{ requestId: "r1" }]);
    fixture.componentRef.setInput(
      "views",
      new Map([["r1", { available: true, requestId: "r1", code: "x", displayCode: "y" }]]),
    );
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const byLabel = (label: string): HTMLButtonElement | undefined =>
      Array.from(root.querySelectorAll("button")).find((button) =>
        (button.textContent ?? "").includes(label),
      );
    const approve = byLabel("承認する");
    const reject = byLabel("取り下げる");
    expect(approve?.classList.contains("spartan-button-variant-default")).toBe(true);
    expect(reject?.classList.contains("spartan-button-variant-outline")).toBe(true);
  });
});
