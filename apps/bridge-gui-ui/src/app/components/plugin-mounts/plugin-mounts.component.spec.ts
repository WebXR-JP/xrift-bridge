import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { PluginMountsComponent } from "./plugin-mounts.component.ts";

// 実プラグイン配置・失敗一覧の描画と再試行要求の送出。本文は扱わない。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PluginMountsComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

describe("実プラグイン子画面一覧の表示", () => {
  it("配置も失敗も無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginMountsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("実プラグイン子画面は無い");
  });

  it("配置の種別・状態・改訂・割当て先を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginMountsComponent);
    fixture.componentRef.setInput("mounts", [
      {
        mountId: "plugin-text-1",
        kind: "text",
        initialUrl: "views://plugin-host/blank.html#mount=plugin-text-1",
        phase: "bound",
        ready: true,
        revision: 2,
        instanceId: "i1",
        localSessionId: "s1",
        portId: "text",
      },
    ]);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("plugin-text-1");
    expect(text).toContain("text");
    expect(text).toContain("準備完了");
    expect(text).toContain("rev 2");
    expect(text).toContain("s1");
  });

  it("失敗は種別と理由だけを出し再試行を要求できる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginMountsComponent);
    fixture.componentRef.setInput("failures", [
      { kind: "diagnostic", reason: "生成待ちが失効した", instanceId: null, localSessionId: null },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("失敗");
    expect(root.textContent).toContain("diagnostic");
    expect(root.textContent).toContain("生成待ちが失効した");
    let retried = 0;
    fixture.componentInstance.retryRequested.subscribe(() => {
      retried += 1;
    });
    root.querySelector("button")?.click();
    expect(retried).toBe(1);
  });
});
