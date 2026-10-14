import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { OwnedPluginInstanceSummary } from "bridge-gui-contract/management";
import { PluginOperationsComponent } from "./plugin-operations.component.ts";

// プラグイン操作タブの描画。個体単位のタブ・選択通知だけであり、
// 子画面タグの移動・業務 RPC は行わないことを確かめる。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PluginOperationsComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 試験用の所有個体。 */
function instanceOf(overrides?: Partial<OwnedPluginInstanceSummary>): OwnedPluginInstanceSummary {
  return {
    pluginKind: "text",
    pluginId: "text",
    instanceId: "i1",
    localSessionId: "s1",
    portId: "text",
    phase: "active",
    ...overrides,
  };
}

/** 配置の試験値。 */
function mountOf(instanceId: string, mountId = `plugin-text-${instanceId}`) {
  return {
    mountId,
    kind: "text",
    initialUrl: `views://plugin-host/blank.html#mount=${mountId}`,
    phase: "bound" as const,
    ready: true,
    revision: 1,
    instanceId,
    localSessionId: "s1",
    portId: "text",
  };
}

describe("プラグイン操作タブの表示", () => {
  it("所有が無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("起動中のプラグインは無い");
  });

  it("タブはインスタンス単位で既知種別は表示名で出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i-text", pluginKind: "text" }),
      instanceOf({ instanceId: "i-diag", pluginKind: "diagnostic" }),
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBe(2);
    expect(root.textContent).toContain("テキスト送信");
    expect(root.textContent).toContain("診断");
  });

  it("未知種別はlabelで出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("kinds", [
      { pluginKind: "mystery", pluginId: "mystery-plugin", label: "神秘", maxInstances: null },
    ]);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i-x", pluginKind: "mystery" }),
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("神秘");
  });

  it("同種が複数ある場合は短い識別を添えて区別する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "instance-aaa111" }),
      instanceOf({ instanceId: "instance-bbb222" }),
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const labels = [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "");
    expect(labels.length).toBe(2);
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels[0]).toContain("aaa111".slice(-6));
    expect(labels[1]).toContain("bbb222".slice(-6));
  });

  it("タブ選択は識別子を載せて出すだけであり業務RPCを送らない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.detectChanges();
    const selected: string[] = [];
    fixture.componentInstance.selectionRequested.subscribe((instanceId) => {
      selected.push(instanceId);
    });
    const root = fixture.nativeElement as HTMLElement;
    const before = root.querySelectorAll('[role="tab"]').length;
    // 2番目のタブを押す。タグの移動は部品の責務外であり、DOM の所有は変わらない。
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    (tabs[1] as HTMLButtonElement).click();
    expect(selected).toEqual(["i2"]);
    expect(root.querySelectorAll('[role="tab"]').length).toBe(before);
  });

  it("選択中個体の準備中・失敗を出し勝手に作り直さない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [instanceOf({ instanceId: "i1" })]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.componentRef.setInput("mounts", []);
    fixture.componentRef.setInput("failures", []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("準備中");
    fixture.componentRef.setInput("mounts", [mountOf("i1")]);
    fixture.componentRef.setInput("failures", [
      { kind: "text", reason: "生成待ちが失効した", instanceId: "i1", localSessionId: null },
    ]);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("準備完了");
    expect(text).toContain("失敗");
    // 再試行は要求だけであり、配置の再生成は行わない。
    let retried = 0;
    fixture.componentInstance.retryRequested.subscribe(() => {
      retried += 1;
    });
    const root = fixture.nativeElement as HTMLElement;
    [...root.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("作り直す"))
      ?.click();
    expect(retried).toBe(1);
    expect(fixture.componentInstance.selectedMounts().length).toBe(1);
  });
});
