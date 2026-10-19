import { isSignal, provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LocalMcpStatus } from "bridge-gui-contract/management";
import { LocalMcpPanelComponent } from "./local-mcp-panel.component.ts";

// 製品向け MCP の操作・表示部品。状態・URL の表示と要求の送出だけを担い、
// 取得・操作は行わないこと、接続に必要なのが URL のみであることを確かめる。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [LocalMcpPanelComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

afterEach(() => {
  // 試験用の clipboard 差替えを消し、他試験に残さない。
  const holder = navigator as unknown as Record<string, unknown>;
  if ("clipboard" in holder && holder["clipboard"] !== undefined) {
    try {
      delete holder.clipboard;
    } catch {
      // 削除できない環境では残す（試験の合否に影響しない）。
    }
  }
});

/** 試験用の公開状態。 */
function statusOf(overrides?: Partial<LocalMcpStatus>): LocalMcpStatus {
  return {
    enabled: false,
    port: null,
    url: null,
    startFailed: false,
    cleanupPending: false,
    revision: 0,
    ...overrides,
  };
}

/** clipboard.writeText の代役を差し込む。 */
function stubClipboard(): { written: string[] } {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: vi.fn(async (text: string) => {
        written.push(text);
      }),
    },
    configurable: true,
  });
  return { written };
}

/** 状態・失敗表示を入れて描画する。 */
async function preparePanel(options?: { status?: LocalMcpStatus | null; error?: string }) {
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(LocalMcpPanelComponent);
  fixture.componentRef.setInput("status", options?.status ?? null);
  fixture.componentRef.setInput("error", options?.error ?? "");
  fixture.detectChanges();
  return fixture;
}

/** ボタンを名前で求める。無ければ試験が落ちる。 */
function buttonOf(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes(name),
  );
  if (found === undefined || !(found instanceof HTMLButtonElement)) {
    throw new Error(`ボタンが無い: ${name}`);
  }
  return found;
}

describe("ローカル MCP の状態表示", () => {
  it("未取得の間は状態を断定せず操作できない", async () => {
    const fixture = await preparePanel();
    const root = fixture.nativeElement as HTMLElement;
    // 状態行だけを見る（説明文の「無効」やボタンの「有効化する」と混同しない）。
    const state = root.querySelector("section > div > span")?.textContent ?? "";
    expect(state).toContain("—");
    expect(state).not.toContain("有効");
    expect(state).not.toContain("無効");
    expect(state).not.toContain("開始に失敗した");
    expect(buttonOf(root, "有効化する").disabled).toBe(true);
    expect(buttonOf(root, "停止する").disabled).toBe(true);
  });

  it("無効のときは接続先 URL を出さない", async () => {
    const fixture = await preparePanel({ status: statusOf() });
    const root = fixture.nativeElement as HTMLElement;
    const state = root.querySelector("section > div > span")?.textContent ?? "";
    expect(state).toContain("無効");
    expect(root.querySelector("#local-mcp-url")).toBe(null);
    expect(buttonOf(root, "有効化する").disabled).toBe(false);
    expect(buttonOf(root, "停止する").disabled).toBe(true);
  });

  it("有効のときは接続先 URL を出す", async () => {
    const fixture = await preparePanel({
      status: statusOf({
        enabled: true,
        port: 4321,
        url: "http://127.0.0.1:4321/mcp",
        revision: 1,
      }),
    });
    const root = fixture.nativeElement as HTMLElement;
    const state = root.querySelector("section > div > span")?.textContent ?? "";
    expect(state).toContain("有効");
    // URL は読取り専用の入力欄の値として出す（複写の対象である）。
    const urlInput = root.querySelector("#local-mcp-url") as HTMLInputElement | null;
    expect(urlInput?.value).toBe("http://127.0.0.1:4321/mcp");
    expect(buttonOf(root, "有効化する").disabled).toBe(true);
    expect(buttonOf(root, "停止する").disabled).toBe(false);
  });

  it("開始失敗は分かるように出す", async () => {
    const fixture = await preparePanel({ status: statusOf({ startFailed: true, revision: 1 }) });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent ?? "").toContain("開始に失敗した");
  });

  it("停止の未完了は分かるように出し再試行できる", async () => {
    const fixture = await preparePanel({ status: statusOf({ cleanupPending: true, revision: 2 }) });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent ?? "").toContain("停止が未完了である");
    // 未完了の間は停止の再試行だけが有効であり、有効化は無効である。
    expect(buttonOf(root, "停止する").disabled).toBe(false);
    expect(buttonOf(root, "有効化する").disabled).toBe(true);
  });

  it("停止の未完了の間は有効化できない", async () => {
    const fixture = await preparePanel({
      status: statusOf({ enabled: true, cleanupPending: true, revision: 2 }),
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(buttonOf(root, "停止する").disabled).toBe(false);
    expect(buttonOf(root, "有効化する").disabled).toBe(true);
  });

  it("実行中の操作はその操作のボタンだけを無効にする", async () => {
    const enabled = statusOf({
      enabled: true,
      port: 4321,
      url: "http://127.0.0.1:4321/mcp",
      revision: 1,
    });
    const enabledFixture = await preparePanel({ status: enabled, error: "" });
    enabledFixture.componentRef.setInput("disablePending", true);
    enabledFixture.detectChanges();
    const enabledRoot = enabledFixture.nativeElement as HTMLElement;
    // 停止の実行中は停止だけが無効であり、有効化は元から無効のまま残る。
    expect(buttonOf(enabledRoot, "停止する").disabled).toBe(true);

    const disabledFixture = await preparePanel({ status: statusOf() });
    disabledFixture.componentRef.setInput("enablePending", true);
    disabledFixture.detectChanges();
    const disabledRoot = disabledFixture.nativeElement as HTMLElement;
    // 有効化の実行中は有効化が無効になり、停止は元から無効のまま残る。
    expect(buttonOf(disabledRoot, "有効化する").disabled).toBe(true);
    expect(buttonOf(disabledRoot, "停止する").disabled).toBe(true);
  });

  it("有効化の実行中は停止を止めない", async () => {
    const fixture = await preparePanel({
      status: statusOf({
        enabled: true,
        port: 4321,
        url: "http://127.0.0.1:4321/mcp",
        revision: 1,
      }),
    });
    fixture.componentRef.setInput("enablePending", true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    // 種類の異なる操作は互いを止めない（有効化の実行中も停止は押せる）。
    expect(buttonOf(root, "停止する").disabled).toBe(false);
    expect(buttonOf(root, "有効化する").disabled).toBe(true);
  });

  it("実行単位・保存なし・自動再開なし・残存リスクを示す", async () => {
    const fixture = await preparePanel({ status: statusOf() });
    const text = fixture.nativeElement.textContent ?? "";
    expect(text).toContain("既定は無効");
    expect(text).toContain("実行単位");
    expect(text).toContain("保存しない");
    expect(text).toContain("自動で再開しない");
    expect(text).toContain("同じ PC のローカルプロセスは利用者を問わず接続できる");
    expect(text).toContain("古い URL が別の実行に一致し得る");
    expect(text).toContain("URL のみで接続でき");
    // 接続設定の表示・複写は URL のみである。
    expect(text).not.toContain("資格情報");
    expect(text).not.toContain("Bearer");
  });
});

describe("ローカル MCP の要求送出", () => {
  it("押すと有効化の要求が出る", async () => {
    const fixture = await preparePanel({ status: statusOf() });
    let requested = 0;
    fixture.componentInstance.enableRequested.subscribe(() => {
      requested += 1;
    });
    buttonOf(fixture.nativeElement as HTMLElement, "有効化する").click();
    expect(requested).toBe(1);
  });

  it("押すと停止の要求が出る", async () => {
    const fixture = await preparePanel({
      status: statusOf({
        enabled: true,
        port: 4321,
        url: "http://127.0.0.1:4321/mcp",
        revision: 1,
      }),
    });
    let requested = 0;
    fixture.componentInstance.disableRequested.subscribe(() => {
      requested += 1;
    });
    buttonOf(fixture.nativeElement as HTMLElement, "停止する").click();
    expect(requested).toBe(1);
  });

  it("未完了の間も停止の再試行の要求が出る", async () => {
    const fixture = await preparePanel({
      status: statusOf({ enabled: false, cleanupPending: true, revision: 2 }),
    });
    let requested = 0;
    fixture.componentInstance.disableRequested.subscribe(() => {
      requested += 1;
    });
    buttonOf(fixture.nativeElement as HTMLElement, "停止する").click();
    expect(requested).toBe(1);
  });

  it("接続設定は URL のみである", async () => {
    const fixture = await preparePanel({
      status: statusOf({
        enabled: true,
        port: 4321,
        url: "http://127.0.0.1:4321/mcp",
        revision: 1,
      }),
    });
    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? "";
    expect(text).not.toContain("資格情報");
    expect(text).not.toContain("Bearer");
    // 入力欄は URL の1件だけである。
    const inputs = root.querySelectorAll("input");
    expect(inputs.length).toBe(1);
    expect(inputs[0]?.id).toBe("local-mcp-url");
  });
});

describe("ローカル MCP の URL の複写", () => {
  it("合図は signal で保持する（通常のプロパティでは zoneless の変更検知が走らないため）", async () => {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(LocalMcpPanelComponent);
    // TestBed の自動検知は通常のプロパティでも描画を進めるため、振る舞い試験
    // だけでは通常のプロパティへの退行を検出できない。合図の保持が signal
    // であること自体を固定する（製品の実行時は TestBed の自動検知が無い）。
    expect(isSignal(fixture.componentInstance.copiedKey)).toBe(true);
  });

  it("URL を複写できる", async () => {
    const { written } = stubClipboard();
    const fixture = await preparePanel({
      status: statusOf({
        enabled: true,
        port: 4321,
        url: "http://127.0.0.1:4321/mcp",
        revision: 1,
      }),
    });
    const root = fixture.nativeElement as HTMLElement;
    const urlInput = root.querySelector("#local-mcp-url") as HTMLInputElement | null;
    expect(urlInput?.value).toBe("http://127.0.0.1:4321/mcp");
    buttonOf(root, "コピー").click();
    await fixture.whenStable();
    expect(written).toContain("http://127.0.0.1:4321/mcp");
  });

  it("複写の合図は自動検知で出て時間で戻る", async () => {
    stubClipboard();
    const fixture = await preparePanel({
      status: statusOf({
        enabled: true,
        port: 4321,
        url: "http://127.0.0.1:4321/mcp",
        revision: 1,
      }),
    });
    const root = fixture.nativeElement as HTMLElement;
    vi.useFakeTimers();
    try {
      // 手動の detectChanges を挟まず、zoneless の自動検知だけに頼る。
      // 通常のプロパティでは合図が出ない退行を検出できる。
      buttonOf(root, "コピー").click();
      await vi.advanceTimersByTimeAsync(0);
      // signal の更新で表示が追随する（通常のプロパティでは追随しない）。
      expect(root.textContent ?? "").toContain("コピーしました");
      expect(fixture.componentInstance.copiedKey()).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      // 一定時間で合図の状態が戻る（表示の追随は上の表示確認で固定する）。
      expect(fixture.componentInstance.copiedKey()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
