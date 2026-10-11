import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SessionListComponent } from "./session-list.component.ts";

// 生存セッション一覧の描画。テキスト表示用は診断割当ての対象外である。

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
    let assigned: string[] = [];
    fixture.componentInstance.assignRequested.subscribe((localSessionId) => {
      assigned = [...assigned, localSessionId];
    });
    root.querySelector("button")?.click();
    expect(assigned).toEqual(["s1"]);
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
});
