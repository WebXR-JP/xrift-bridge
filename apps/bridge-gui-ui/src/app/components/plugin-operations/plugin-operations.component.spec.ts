import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { OwnedPluginInstanceSummary } from "bridge-gui-contract/management";
import { PluginOperationsComponent } from "./plugin-operations.component.ts";

// プラグイン操作タブの描画。個体単位のタブ・選択通知だけであり、
// 見出し・マウント一覧・失敗一覧・再試行は出さず、子画面タグの移動・
// 業務 RPC は行わないことを確かめる。

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

describe("プラグイン操作タブの表示", () => {
  it("所有が無いときはタブを出さない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(root.querySelector('[role="tablist"]')).toBe(null);
  });

  it("二重見出しとマウント・失敗・再試行を出さない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [instanceOf({ instanceId: "i1" })]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.componentRef.setInput("failures", [
      {
        kind: "text",
        reason: "生成待ちが失効した",
        instanceId: "i1",
        localSessionId: null,
        viewGeneration: 1,
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector("h2")).toBe(null);
    expect(root.textContent).not.toContain("準備完了");
    expect(root.textContent).not.toContain("生成待ちが失効した");
    expect(root.querySelector("button")).not.toBe(null);
    // タブ以外のボタン（再試行）は無い。
    expect(root.querySelectorAll("button").length).toBe(1);
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

  it("末尾が衝突しても識別部分を延長し同じ札を許さない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "AA-abcdef" }),
      instanceOf({ instanceId: "BB-abcdef" }),
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const labels = [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "");
    expect(labels.length).toBe(2);
    // 末尾6文字だけでは衝突するため、区別できる長さまで延長する。
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels[0]).toContain("A-abcdef");
    expect(labels[1]).toContain("B-abcdef");
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

  it("マウント失敗の個体にだけ警告印と読み上げ文言を付ける", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.componentRef.setInput("failures", [
      {
        kind: "text",
        reason: "生成待ちが失効した",
        instanceId: "i2",
        localSessionId: null,
        viewGeneration: 1,
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    // 失敗の無い個体には付けない（準備中・ready と同様）。
    expect(tabs[0]?.textContent).not.toContain("要確認");
    // 失敗のある非選択個体には警告印と読み上げ文言を付ける。
    expect(tabs[1]?.textContent).toContain("要確認");
    expect(tabs[1]?.querySelector(".sr-only")?.textContent).toContain("要確認");
  });

  it("cleanupFailedの個体に警告印を付ける", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2", phase: "cleanupFailed" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.componentRef.setInput("failures", []);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs[0]?.textContent).not.toContain("要確認");
    expect(tabs[1]?.textContent).toContain("要確認");
  });

  it("特定不能の失敗はどのタブの警告にも波及しない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.componentRef.setInput("failures", [
      {
        kind: "text",
        reason: "生成待ちが失効した",
        instanceId: null,
        localSessionId: null,
        viewGeneration: null,
      },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    // `instanceId: null` はどの個体にも結び付かないため、警告印は付かない。
    expect(tabs[0]?.textContent).not.toContain("要確認");
    expect(tabs[1]?.textContent).not.toContain("要確認");
  });

  it("旧世代の失敗が剪定された後は成功個体に警告を付けずcleanupFailedには付ける", async () => {
    // B が世代 G1 で失敗し G2 で成功した場合、main が G1 の失敗を剪定する
    // ため一覧は空になる。選択中が応答済みなのにタブだけ警告、という矛盾を
    // 残さないことの表示側の受け皿である。cleanupFailed の警告は剪定と
    // 無関係に付く。
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.componentRef.setInput("failures", []);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs[0]?.textContent).not.toContain("要確認");
    expect(tabs[1]?.textContent).not.toContain("要確認");
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2", phase: "cleanupFailed" }),
    ]);
    fixture.detectChanges();
    const warned = [...root.querySelectorAll('[role="tab"]')];
    expect(warned[0]?.textContent).not.toContain("要確認");
    expect(warned[1]?.textContent).toContain("要確認");
  });

  it("tablistとtabの関連付けがあり選択だけがtabindex0である", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const list = root.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-label")).toContain("起動中のプラグイン");
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe("plugin-slot");
      expect(tab.getAttribute("id")).toContain("plugin-tab-");
    }
  });

  it("矢印とHomeEndでタブ移動し業務RPCを送らない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginOperationsComponent);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i1" }),
      instanceOf({ instanceId: "i2", localSessionId: "s2" }),
      instanceOf({ instanceId: "i3", localSessionId: "s3" }),
    ]);
    fixture.componentRef.setInput("selectedInstanceId", "i1");
    fixture.detectChanges();
    const selected: string[] = [];
    fixture.componentInstance.selectionRequested.subscribe((instanceId) => {
      selected.push(instanceId);
    });
    const root = fixture.nativeElement as HTMLElement;
    const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLElement[];
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(selected).toEqual(["i2"]);
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(selected).toEqual(["i2", "i3"]);
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(selected).toEqual(["i2", "i3", "i1"]);
    // 移動でタブの数は変わらない（再生成しない）。
    expect(root.querySelectorAll('[role="tab"]').length).toBe(3);
  });
});
