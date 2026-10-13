import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { AcceptanceToggleComponent } from "./acceptance-toggle.component.ts";
import { makeSnapshot } from "../../snapshot-fixture.ts";

// 受付操作部品。押せるかは表示状態の有無で決まることを確かめる。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [AcceptanceToggleComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 描画された有効化・無効化の順のボタンを返す。 */
function readButtons(fixture: { nativeElement: unknown }): [HTMLButtonElement, HTMLButtonElement] {
  const root = fixture.nativeElement as HTMLElement;
  const buttons = root.querySelectorAll("button");
  return [buttons[0], buttons[1]];
}

describe("受付操作の表示", () => {
  it("未取得の間は両方の操作が押せない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AcceptanceToggleComponent);
    fixture.detectChanges();
    const [enable, disable] = readButtons(fixture);
    expect(enable.disabled).toBe(true);
    expect(disable.disabled).toBe(true);
  });

  it("取得済みなら操作でき受付状態が出る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AcceptanceToggleComponent);
    fixture.componentRef.setInput("snapshot", makeSnapshot({ admission: { accepting: true } }));
    fixture.detectChanges();
    const [enable, disable] = readButtons(fixture);
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(enable.disabled).toBe(false);
    expect(disable.disabled).toBe(false);
    expect(text).toContain("受付中");
  });

  it("押すと有効化の要求が出る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AcceptanceToggleComponent);
    fixture.componentRef.setInput("snapshot", makeSnapshot({ admission: { accepting: false } }));
    fixture.detectChanges();
    let requested = 0;
    fixture.componentInstance.enableRequested.subscribe(() => {
      requested += 1;
    });
    const [enable] = readButtons(fixture);
    enable.click();
    expect(requested).toBe(1);
  });

  it("押すと無効化の要求が出る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AcceptanceToggleComponent);
    fixture.componentRef.setInput("snapshot", makeSnapshot({ admission: { accepting: true } }));
    fixture.detectChanges();
    let requested = 0;
    fixture.componentInstance.disableRequested.subscribe(() => {
      requested += 1;
    });
    const [, disable] = readButtons(fixture);
    disable.click();
    expect(requested).toBe(1);
  });
});
