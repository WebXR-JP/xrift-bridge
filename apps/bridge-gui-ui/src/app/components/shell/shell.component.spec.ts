import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ShellComponent } from "./shell.component.ts";
import type { ShellStatus } from "./shell.component.ts";
import { VIEW_DEFINITIONS } from "../../view-config.ts";
import type { ViewKey } from "../../view-config.ts";

// 管理画面シェルの描画。画面定義・選択・件数・状態値の表示と、選択／終了の
// 通知だけを担い、取得・操作は行わないことを確かめる。

/** 試験用の件数。接続とセッションだけに件数があり、他は無い。 */
function countsOf(
  overrides?: Partial<Record<ViewKey, number | null>>,
): Record<ViewKey, number | null> {
  return {
    connections: 2,
    sessions: 1,
    plugins: null,
    operations: null,
    log: null,
    ...overrides,
  };
}

/** 試験用の状態値。 */
function statusOf(overrides?: Partial<ShellStatus>): ShellStatus {
  return {
    accepting: false,
    pendingCount: 1,
    connectionCount: 2,
    sessionCount: 3,
    ...overrides,
  };
}

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [ShellComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 入力付きでシェルを作る。 */
async function prepareShell(options?: {
  selectedKey?: ViewKey;
  counts?: Record<ViewKey, number | null>;
  status?: ShellStatus;
}) {
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(ShellComponent);
  fixture.componentRef.setInput("views", VIEW_DEFINITIONS);
  fixture.componentRef.setInput("selectedKey", options?.selectedKey ?? "connections");
  fixture.componentRef.setInput("counts", options?.counts ?? countsOf());
  fixture.componentRef.setInput("status", options?.status ?? statusOf());
  fixture.detectChanges();
  return fixture;
}

describe("シェルのナビとヘッダ", () => {
  it("5画面のナビ項目と選択中の題・副題を出す", async () => {
    const fixture = await prepareShell();
    const root = fixture.nativeElement as HTMLElement;
    const navButtons = root.querySelectorAll("nav button[data-nav-key]");
    expect(navButtons.length).toBe(5);
    const labels = [...navButtons].map((button) => button.textContent ?? "");
    expect(labels[0]).toContain("接続");
    expect(labels[1]).toContain("セッション一覧");
    expect(labels[2]).toContain("プラグイン一覧");
    expect(labels[3]).toContain("プラグイン操作");
    expect(labels[4]).toContain("受信記録");
    expect(root.querySelector("header h1")?.textContent).toContain("接続");
    expect(root.querySelector("header p")?.textContent).toContain(
      "接続の受け入れと確立、現在の状態。",
    );
  });

  it("件数がある画面だけに件数を出す", async () => {
    const fixture = await prepareShell();
    const root = fixture.nativeElement as HTMLElement;
    const byKey = (key: string) =>
      root.querySelector(`nav button[data-nav-key="${key}"]`)?.textContent ?? "";
    expect(byKey("connections")).toContain("2 件");
    expect(byKey("sessions")).toContain("1 件");
    expect(byKey("plugins")).not.toContain("件");
    expect(byKey("operations")).not.toContain("件");
    expect(byKey("log")).not.toContain("件");
  });

  it("未取得の間は件数も受付状態も断定しない", async () => {
    const fixture = await prepareShell({
      counts: countsOf({ connections: null, sessions: null }),
      status: statusOf({
        accepting: null,
        pendingCount: null,
        connectionCount: null,
        sessionCount: null,
      }),
    });
    const root = fixture.nativeElement as HTMLElement;
    const text: string = root.textContent ?? "";
    expect(text).not.toContain("件");
    expect(text).not.toContain("受付中");
    expect(text).not.toContain("受付停止中");
    expect(text).toContain("—");
  });

  it("選択中の項目だけにaria-currentを付ける", async () => {
    const fixture = await prepareShell({ selectedKey: "sessions" });
    const root = fixture.nativeElement as HTMLElement;
    expect(
      root.querySelector('nav button[data-nav-key="sessions"]')?.getAttribute("aria-current"),
    ).toBe("page");
    expect(
      root.querySelector('nav button[data-nav-key="connections"]')?.getAttribute("aria-current"),
    ).toBe(null);
    expect(root.querySelector("header h1")?.textContent).toContain("セッション一覧");
  });

  it("押すと選択要求と終了要求が出て業務処理はしない", async () => {
    const fixture = await prepareShell();
    const selected: ViewKey[] = [];
    fixture.componentInstance.selectRequested.subscribe((key) => {
      selected.push(key);
    });
    let quitCount = 0;
    fixture.componentInstance.quitRequested.subscribe(() => {
      quitCount += 1;
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('nav button[data-nav-key="log"]') as HTMLButtonElement).click();
    (root.querySelector('button[data-action="quit"]') as HTMLButtonElement).click();
    expect(selected).toEqual(["log"]);
    expect(quitCount).toBe(1);
  });
});
