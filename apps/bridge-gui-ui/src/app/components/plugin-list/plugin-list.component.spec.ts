import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type {
  OwnedPluginInstanceSummary,
  PluginKindSummary,
  SessionSummary,
} from "bridge-gui-contract/management";
import { PluginListComponent } from "./plugin-list.component.ts";

// プラグイン一覧の描画。左は登録種別だけを出し、右は所有個体だけを出す。
// 選択は行の一時状態であり、確定操作だけが割当て要求を送る。
// 解除は描画時の三識別子を送り、再割当ては送らない。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PluginListComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 試験用の登録種別。 */
function kindOf(overrides?: Partial<PluginKindSummary>): PluginKindSummary {
  return {
    pluginKind: "text",
    pluginId: "text",
    label: "テキスト",
    maxInstances: null,
    ...overrides,
  };
}

/** 試験用の生存セッション。 */
function sessionOf(localSessionId: string, sessionId = "main"): SessionSummary {
  return {
    localSessionId,
    sessionId,
    kind: "reliable",
    direction: "bidirectional",
    connectionId: "c1",
  };
}

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

/** 追加ボタンを求める。行の開閉だけに使い、RPC は送らない。 */
function addButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector(
    'section[aria-label="使用可能なプラグイン"] button[aria-label]',
  );
  if (button === null || !(button instanceof HTMLButtonElement)) {
    throw new Error("追加ボタンが無い");
  }
  return button;
}

describe("プラグイン一覧の種別表示", () => {
  it("登録種別だけを表示し未登録の既知種別は出さない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    // 登録した text は補助表の表示名で出る。
    expect(text).toContain("テキスト送信");
    // 登録していない diagnostic は静的表から出さない。
    expect(text).not.toContain("診断");
  });

  it("未知の登録種別はlabelと汎用表示で出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [
      kindOf({ pluginKind: "mystery", pluginId: "mystery-plugin", label: "神秘" }),
    ]);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("神秘");
  });

  it("上限に達した種別は追加を抑止する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf({ maxInstances: 1 })]);
    fixture.componentRef.setInput("instances", [instanceOf()]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(addButton(root).disabled).toBe(true);
    expect(root.textContent).toContain("上限");
  });

  it("上限なしの種別は所有があっても追加できる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf({ maxInstances: null })]);
    fixture.componentRef.setInput("instances", [instanceOf()]);
    fixture.detectChanges();
    expect(addButton(fixture.nativeElement as HTMLElement).disabled).toBe(false);
  });
});

describe("プラグイン一覧の追加フロー", () => {
  it("追加と選択だけでは割当て要求を送らない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const select = root.querySelector("select");
    if (select === null || !(select instanceof HTMLSelectElement)) {
      throw new Error("選択が開かない");
    }
    select.value = "s1";
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    expect(assigned).toEqual([]);
  });

  it("先頭候補を自動選択せず確定は押せない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const select = root.querySelector("select");
    if (select === null || !(select instanceof HTMLSelectElement)) {
      throw new Error("選択が開かない");
    }
    expect(select.value).toBe("");
    const confirm = root.querySelector("button:not([aria-label])");
    if (confirm === null || !(confirm instanceof HTMLButtonElement)) {
      throw new Error("確定ボタンが無い");
    }
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain("起動して割り当てる");
  });

  it("確定操作で選択した識別子を送る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1"), sessionOf("s2", "sub")]);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const select = root.querySelector("select");
    if (select === null || !(select instanceof HTMLSelectElement)) {
      throw new Error("選択が開かない");
    }
    select.value = "s2";
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    const buttons = [...root.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("起動して割り当てる"),
    );
    (buttons[0] as HTMLButtonElement).click();
    expect(assigned).toEqual([{ pluginKind: "text", localSessionId: "s2" }]);
  });

  it("選択変更と取消は割当て要求を送らない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1"), sessionOf("s2", "sub")]);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const select = root.querySelector("select");
    if (select === null || !(select instanceof HTMLSelectElement)) {
      throw new Error("選択が開かない");
    }
    select.value = "s1";
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    select.value = "s2";
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    const cancel = [...root.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("キャンセル"),
    );
    if (cancel === undefined || !(cancel instanceof HTMLButtonElement)) {
      throw new Error("取消ボタンが無い");
    }
    cancel.click();
    expect(assigned).toEqual([]);
  });

  it("使用中のセッションは候補から外れる", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf({ pluginKind: "diagnostic" })]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1"), sessionOf("s2", "sub")]);
    fixture.componentRef.setInput("assignments", [
      { localSessionId: "s1", instanceId: "i9", portId: "diagnostic" },
    ]);
    fixture.componentRef.setInput("instances", [
      instanceOf({
        pluginKind: "other",
        pluginId: "other",
        instanceId: "i9",
        localSessionId: "s1",
        portId: "diagnostic",
        phase: "active",
      }),
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const options = [...root.querySelectorAll("select option")].map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(options).toContain("");
    expect(options).toContain("s2");
    expect(options).not.toContain("s1");
  });

  it("候補が0件なら選べない旨を出して送信を抑止する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", []);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    expect(root.textContent).toContain("割り当て可能なセッションは無い");
    expect(root.querySelector("select")).toBe(null);
    expect(root.textContent).not.toContain("起動して割り当てる");
    expect(assigned).toEqual([]);
  });

  it("候補の消滅後は確定を抑止する", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const select = root.querySelector("select");
    if (select === null || !(select instanceof HTMLSelectElement)) {
      throw new Error("選択が開かない");
    }
    select.value = "s1";
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    // 下書き後に候補が消滅したら確定は押せない。
    fixture.componentRef.setInput("sessions", []);
    fixture.detectChanges();
    expect(root.textContent).toContain("割り当て可能なセッションは無い");
    expect(assigned).toEqual([]);
  });

  it("確定後に自動転送しない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1"), sessionOf("s2", "sub")]);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    addButton(root).click();
    fixture.detectChanges();
    const select = root.querySelector("select");
    if (select === null || !(select instanceof HTMLSelectElement)) {
      throw new Error("選択が開かない");
    }
    select.value = "s1";
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    const confirm = [...root.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("起動して割り当てる"),
    );
    if (confirm === undefined || !(confirm instanceof HTMLButtonElement)) {
      throw new Error("確定ボタンが無い");
    }
    confirm.click();
    fixture.detectChanges();
    // 拒否相当（snapshot 更新）があっても再送しない。
    fixture.componentRef.setInput("sessions", [sessionOf("s1"), sessionOf("s2", "sub")]);
    fixture.detectChanges();
    expect(assigned).toEqual([{ pluginKind: "text", localSessionId: "s1" }]);
  });
});

describe("プラグイン一覧の起動中表示", () => {
  it("無いときはその旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("起動中のプラグインは無い");
  });

  it("段階別に表示し稼働中はactiveのときだけ出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.componentRef.setInput("instances", [
      instanceOf({ instanceId: "i-active", phase: "active" }),
      instanceOf({ instanceId: "i-init", localSessionId: "s1", phase: "initializing" }),
      instanceOf({ instanceId: "i-rel", localSessionId: "s1", phase: "releasing" }),
      instanceOf({ instanceId: "i-fail", localSessionId: "s1", phase: "cleanupFailed" }),
    ]);
    fixture.componentRef.setInput("assignments", [
      { localSessionId: "s1", instanceId: "i-active", portId: "text" },
      { localSessionId: "s1", instanceId: "i-init", portId: "text" },
      { localSessionId: "s1", instanceId: "i-rel", portId: "text" },
      { localSessionId: "s1", instanceId: "i-fail", portId: "text" },
    ]);
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("稼働中");
    expect(text).toContain("起動処理中");
    expect(text).toContain("解除処理中");
    // 回収失敗は残し、成功として消さない。
    expect(text).toContain("回収失敗");
    // 「稼働中」は active の1件だけである。
    expect(text.match(/稼働中/g)?.length).toBe(1);
  });

  it("接続先を読み取り表示し変更には解除が要る旨を出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.componentRef.setInput("instances", [instanceOf()]);
    fixture.componentRef.setInput("assignments", [
      { localSessionId: "s1", instanceId: "i1", portId: "text" },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("接続先セッション");
    expect(root.textContent).toContain("s1");
    expect(root.textContent).toContain("変更には解除と新規セッションが必要");
    // 解除が対象セッションを中断する旨を出す。
    expect(root.textContent).toContain("中断");
    // 読取り専用であり、接続先の選択は置かない。
    expect(root.querySelector('section[aria-label="起動中のプラグイン"] select')).toBe(null);
  });

  it("解除は描画時の三識別子を送る", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.componentRef.setInput("instances", [instanceOf()]);
    fixture.componentRef.setInput("assignments", [
      { localSessionId: "s1", instanceId: "i1", portId: "text" },
    ]);
    fixture.detectChanges();
    const removed: unknown[] = [];
    fixture.componentInstance.unassignRequested.subscribe((request) => {
      removed.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    const remove = root.querySelector(
      'section[aria-label="起動中のプラグイン"] button[aria-label]',
    );
    if (remove === null || !(remove instanceof HTMLButtonElement)) {
      throw new Error("解除ボタンが無い");
    }
    remove.click();
    expect(removed).toEqual([{ instanceId: "i1", localSessionId: "s1", portId: "text" }]);
  });

  it("稼働中の操作は再割当てを送らない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.componentRef.setInput("instances", [instanceOf()]);
    fixture.componentRef.setInput("assignments", [
      { localSessionId: "s1", instanceId: "i1", portId: "text" },
    ]);
    fixture.detectChanges();
    const assigned: unknown[] = [];
    fixture.componentInstance.assignRequested.subscribe((request) => {
      assigned.push(request);
    });
    const root = fixture.nativeElement as HTMLElement;
    const buttons = root.querySelectorAll('section[aria-label="起動中のプラグイン"] button');
    expect(buttons.length).toBe(1);
    (buttons[0] as HTMLButtonElement).click();
    expect(assigned).toEqual([]);
  });

  it("割当ての対応が取れない個体は不明として出す", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    // 割当て写しが無い所有は捏造せず不明として出す。
    fixture.componentRef.setInput("instances", [instanceOf()]);
    fixture.componentRef.setInput("assignments", []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("割当て不明");
  });

  it("割当て写しだけでは個体を作らない", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(PluginListComponent);
    fixture.componentRef.setInput("kinds", [kindOf()]);
    fixture.componentRef.setInput("sessions", [sessionOf("s1")]);
    fixture.componentRef.setInput("instances", []);
    fixture.componentRef.setInput("assignments", [
      { localSessionId: "s1", instanceId: "i-ghost", portId: "text" },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("起動中のプラグインは無い");
    expect(root.textContent).not.toContain("i-ghost");
  });
});
