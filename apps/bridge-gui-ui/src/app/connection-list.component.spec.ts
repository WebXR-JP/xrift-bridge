import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ConnectionListComponent } from "./connection-list.component.ts";

// 接続一覧の描画と切断要求の送出。認可状態・段階を示す。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [ConnectionListComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("接続一覧の表示", () => {
  it("接続が無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(ConnectionListComponent);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("接続は無い");
  });

  it("識別子・接続元・認可状態・段階を出し切断を要求できる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(ConnectionListComponent);
    fixture.componentRef.setInput("connections", [
      { connectionId: "c1", origin: "https://example.test", authorized: true, phase: "ready" },
      { connectionId: "c2", origin: "https://other.test", authorized: false, phase: "pairing" },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const text: string = root.textContent ?? "";
    expect(text).toContain("c1");
    expect(text).toContain("https://example.test");
    expect(text).toContain("認可済み");
    expect(text).toContain("c2");
    expect(text).toContain("未認可");
    let disconnected: string[] = [];
    fixture.componentInstance.disconnectRequested.subscribe((connectionId) => {
      disconnected = [...disconnected, connectionId];
    });
    const buttons = Array.from(root.querySelectorAll("button"));
    buttons[1]?.click();
    expect(disconnected).toEqual(["c2"]);
  });
});
