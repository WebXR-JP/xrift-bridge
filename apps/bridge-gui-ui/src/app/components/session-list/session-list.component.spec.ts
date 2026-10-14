import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SessionListComponent } from "./session-list.component.ts";

// セッション一覧の表示専用化。読み取り表示だけであり、操作ボタンは置かない。
// 割当て・解除はプラグイン一覧で行う。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [SessionListComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("セッション一覧の表示", () => {
  it("生存セッションが無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector("h2")?.textContent).toContain("セッション一覧");
    expect(root.textContent).toContain("生存セッションは無い");
    expect(root.querySelector("button")).toBe(null);
  });

  it("行に識別子と論理名・種別・方向・接続を出しボタンを置かない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.componentRef.setInput("sessions", [
      {
        localSessionId: "s1",
        sessionId: "main",
        kind: "reliable",
        direction: "bidirectional",
        connectionId: "c1",
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const text: string = root.textContent ?? "";
    expect(text).toContain("s1");
    expect(text).toContain("論理名 main・reliable・bidirectional・接続 c1");
    // 表示専用のため、割当て・解除のいずれのボタンも置かない。
    expect(root.querySelector("button")).toBe(null);
    expect(root.querySelector("select")).toBe(null);
    expect(root.querySelector("input")).toBe(null);
  });

  it("複数行を出す場合も操作要素を持たない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SessionListComponent);
    fixture.componentRef.setInput("sessions", [
      {
        localSessionId: "s1",
        sessionId: "main",
        kind: "reliable",
        direction: "bidirectional",
        connectionId: "c1",
      },
      {
        localSessionId: "s2",
        sessionId: "sub",
        kind: "latest",
        direction: "to_server",
        connectionId: "c2",
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll("li").length).toBe(2);
    expect(root.querySelector("button")).toBe(null);
  });
});
