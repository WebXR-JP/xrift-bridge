import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { PluginViewState } from "../../plugin-view-state.ts";
import { PluginViewFallbackComponent } from "./plugin-view-fallback.component.ts";

// 子画面スロットの代替表示。共有の導出結果の文言・再試行・再読み込みだけであり、
// 子画面タグの生成・移動・`src` 再設定は行わないことを確かめる。

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [PluginViewFallbackComponent],
    providers: [provideZonelessChangeDetection()],
  });
});

/** 状態入力で部品を作る。 */
async function prepareWith(state: PluginViewState) {
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(PluginViewFallbackComponent);
  fixture.componentRef.setInput("state", state);
  fixture.detectChanges();
  return fixture;
}

describe("代替表示の文言", () => {
  it("読み込み中はその旨を出す", async () => {
    const fixture = await prepareWith({ kind: "loading" });
    expect(fixture.nativeElement.textContent).toContain("プラグインの状態を読み込んでいます…");
  });

  it("取得失敗はその旨と再読み込みを出す", async () => {
    const fixture = await prepareWith({ kind: "loadFailed" });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("プラグインの状態を取得できませんでした。");
    expect(root.textContent).toContain("再読み込み");
    let reloaded = 0;
    fixture.componentInstance.reloadRequested.subscribe(() => {
      reloaded += 1;
    });
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(reloaded).toBe(1);
  });

  it("所有0件はその旨を出す", async () => {
    const fixture = await prepareWith({ kind: "empty" });
    expect(fixture.nativeElement.textContent).toContain("起動中のプラグインはありません。");
  });

  it("起動中・準備中・終了中はその旨を出す", async () => {
    for (const [state, text] of [
      [{ kind: "starting" }, "プラグインを起動しています…"],
      [{ kind: "preparing" }, "子画面を準備しています…"],
      [{ kind: "releasing" }, "プラグインを終了しています…"],
    ] as const) {
      const fixture = await prepareWith(state);
      expect(fixture.nativeElement.textContent).toContain(text);
    }
  });

  it("終了処理の失敗は回収の案内を出し再試行を出さない", async () => {
    const fixture = await prepareWith({ kind: "cleanupFailed" });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("プラグインの終了処理に失敗しました。");
    expect(root.textContent).toContain(
      "このプラグインは操作できません。アプリ終了時に回収を試みます。",
    );
    expect(root.querySelector("button")).toBe(null);
    expect(root.querySelector("[data-plugin-view-retry]")).toBe(null);
  });

  it("応答済みでは状態文を出さず子画面のみにする", async () => {
    const fixture = await prepareWith({ kind: "answered" });
    const root = fixture.nativeElement as HTMLElement;
    expect((root.textContent ?? "").trim()).toBe("");
    expect(root.querySelector("button")).toBe(null);
  });
});

describe("失敗と再試行", () => {
  it("失敗は理由と再試行を出す", async () => {
    const fixture = await prepareWith({
      kind: "failed",
      reason: "生成待ちが失効した",
      retryPending: false,
      retryRequestFailed: false,
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("子画面を表示できませんでした。");
    expect(root.textContent).toContain("生成待ちが失効した");
    const retry = root.querySelector("[data-plugin-view-retry]") as HTMLButtonElement | null;
    expect(retry).not.toBe(null);
    expect(retry?.textContent).toContain("再試行");
    expect(retry?.disabled).toBe(false);
    let retried = 0;
    fixture.componentInstance.retryRequested.subscribe(() => {
      retried += 1;
    });
    retry?.click();
    expect(retried).toBe(1);
  });

  it("再試行要求中は失敗表示を残しボタンを無効化する", async () => {
    const fixture = await prepareWith({
      kind: "failed",
      reason: "生成待ちが失効した",
      retryPending: true,
      retryRequestFailed: false,
    });
    const root = fixture.nativeElement as HTMLElement;
    // 失敗表示は残る。
    expect(root.textContent).toContain("子画面を表示できませんでした。");
    expect(root.textContent).toContain("生成待ちが失効した");
    const retry = root.querySelector("[data-plugin-view-retry]") as HTMLButtonElement | null;
    expect(retry?.textContent).toContain("再試行中…");
    expect(retry?.disabled).toBe(true);
  });

  it("再試行要求自体の失敗は元の失敗表示に注記を足す", async () => {
    const fixture = await prepareWith({
      kind: "failed",
      reason: "生成待ちが失効した",
      retryPending: false,
      retryRequestFailed: true,
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("子画面を表示できませんでした。");
    expect(root.textContent).toContain("生成待ちが失効した");
    expect(root.textContent).toContain("再試行を開始できませんでした。もう一度お試しください。");
    expect(root.querySelector("[data-plugin-view-retry]")).not.toBe(null);
  });
});

// 代替表示は子画面タグと同一矩形に重なるため、受け口自体は操作を奪わず、
// 操作が必要な状態のボタンだけが操作を受け付けることを確かめる。
// native 子画面の実表示（重なり順・クリック受付）は自動化の対象外である。
describe("子画面への操作の透過", () => {
  it("応答済みでは受け口自体が操作を奪わず操作要素も無い", async () => {
    const fixture = await prepareWith({ kind: "answered" });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.style.pointerEvents).toBe("none");
    expect(root.querySelector("button")).toBe(null);
    expect(root.querySelector("[data-plugin-view-retry]")).toBe(null);
  });

  it("操作が必要な状態のボタンだけが操作を受け付ける", async () => {
    const retrying = await prepareWith({
      kind: "failed",
      reason: "生成待ちが失効した",
      retryPending: false,
      retryRequestFailed: false,
    });
    const retryRoot = retrying.nativeElement as HTMLElement;
    expect(retryRoot.style.pointerEvents).toBe("none");
    const retry = retryRoot.querySelector("[data-plugin-view-retry]") as HTMLButtonElement | null;
    expect(retry?.style.pointerEvents).toBe("auto");

    const reloading = await prepareWith({ kind: "loadFailed" });
    const reloadRoot = reloading.nativeElement as HTMLElement;
    expect(reloadRoot.style.pointerEvents).toBe("none");
    expect(
      (reloadRoot.querySelector("button") as HTMLButtonElement | null)?.style.pointerEvents,
    ).toBe("auto");
  });

  it("操作要素の無い状態では受け口全体が透過する", async () => {
    for (const state of [
      { kind: "loading" },
      { kind: "empty" },
      { kind: "starting" },
      { kind: "preparing" },
      { kind: "releasing" },
      { kind: "cleanupFailed" },
    ] as const) {
      const fixture = await prepareWith(state);
      const root = fixture.nativeElement as HTMLElement;
      expect(root.style.pointerEvents).toBe("none");
      expect(root.querySelector("button")).toBe(null);
    }
  });
});
