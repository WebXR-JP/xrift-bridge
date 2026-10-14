import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SpikeSectionComponent } from "./spike-section.component.ts";

// 段0スパイク一覧の描画と操作要求の送出。本文は扱わない。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [SpikeSectionComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("段0スパイク一覧の表示", () => {
  it("所有が無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SpikeSectionComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("子画面は無い");
  });

  it("状態と改訂を書き分けて出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SpikeSectionComponent);
    fixture.componentRef.setInput("spikes", [
      {
        mountId: "spike-1",
        initialUrl: "views://plugin-host/blank.html#mount=spike-1",
        phase: "pending",
        ready: false,
        revision: 1,
      },
      {
        mountId: "spike-2",
        initialUrl: "views://plugin-host/blank.html#mount=spike-2",
        phase: "bound",
        ready: true,
        revision: 3,
      },
    ]);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("spike-1");
    expect(text).toContain("生成待ち");
    expect(text).toContain("spike-2");
    expect(text).toContain("準備完了");
    expect(text).toContain("rev 3");
  });

  it("送る・外す・作る・全て外すを要求できる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SpikeSectionComponent);
    fixture.componentRef.setInput("spikes", [
      {
        mountId: "spike-1",
        initialUrl: "views://plugin-host/blank.html#mount=spike-1",
        phase: "bound",
        ready: false,
        revision: 2,
      },
    ]);
    fixture.detectChanges();
    const pushed: string[] = [];
    const destroyed: string[] = [];
    let created = 0;
    let reset = 0;
    fixture.componentInstance.pushRequested.subscribe((mountId) => {
      pushed.push(mountId);
    });
    fixture.componentInstance.destroyRequested.subscribe((mountId) => {
      destroyed.push(mountId);
    });
    fixture.componentInstance.createRequested.subscribe(() => {
      created += 1;
    });
    fixture.componentInstance.resetRequested.subscribe(() => {
      reset += 1;
    });
    const root = fixture.nativeElement as HTMLElement;
    const buttons = [...root.querySelectorAll("button")];
    // ADR: helm 化後の整形でボタン文の前後に空白が入るため、照合は前後空白を除く。
    buttons.find((button) => button.textContent?.trim() === "送る")?.click();
    buttons.find((button) => button.textContent?.trim() === "外す")?.click();
    buttons.find((button) => button.textContent?.trim() === "子画面を作る")?.click();
    buttons.find((button) => button.textContent?.trim() === "子画面を全て外す")?.click();
    expect(pushed).toEqual(["spike-1"]);
    expect(destroyed).toEqual(["spike-1"]);
    expect(created).toBe(1);
    expect(reset).toBe(1);
  });
});
