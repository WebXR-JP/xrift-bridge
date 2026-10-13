import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SessionListComponent } from "./session-list.component.ts";

// 生存セッション一覧の描画。テキスト表示用は診断割当ての対象外である。
// 所有中の診断現割当てには同行的な機械的解除ボタンを出す。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [SessionListComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("生存セッション一覧の表示", () => {
  it("生存セッションが無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("生存セッションは無い");
  });

  it("通常のセッションは診断割当てを要求できる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.componentRef.setInput("sessions", [
      {
        localSessionId: "s1",
        sessionId: "main",
        kind: "reliable",
        direction: "outgoing",
        connectionId: "c1",
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("s1");
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    root.querySelector("button")?.click();
    expect(assigned).toEqual([{ pluginKind: "diagnostic", localSessionId: "s1" }]);
  });

  it("テキスト表示用セッションは診断対象外と出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.componentRef.setInput("sessions", [
      {
        localSessionId: "s9",
        sessionId: "text",
        kind: "reliable",
        direction: "outgoing",
        connectionId: "c1",
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("診断対象外");
    expect(root.querySelector("button")).toBe(null);
  });

  it("所有中の診断現割当てには解除ボタンを出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.componentRef.setInput("sessions", [
      {
        localSessionId: "s1",
        sessionId: "main",
        kind: "reliable",
        direction: "outgoing",
        connectionId: "c1",
      },
    ]);
    fixture.componentRef.setInput("diagnosticBindings", [
      { localSessionId: "s1", instanceId: "i1", portId: "diagnostic" },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("診断割当て中");
    const unassigned: unknown[] = [];
    fixture.componentInstance.unassignRequested.subscribe((request) => {
      unassigned.push(request);
    });
    root.querySelector("button")?.click();
    expect(unassigned).toEqual([{ instanceId: "i1", localSessionId: "s1", portId: "diagnostic" }]);
  });
});
