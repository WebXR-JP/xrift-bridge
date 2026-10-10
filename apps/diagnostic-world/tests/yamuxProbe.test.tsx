// @vitest-environment happy-dom
/**
 * yamux 探針の開発専用操作盤の検証。描画時の安定した操作口を確かめる。
 *
 * 接続はボタン操作時のみ行うため、描画だけでは通信しない。
 * 送受信した値の中身を扱わないため、秘密値の検証は持たない。
 */
import { afterEach, expect, test } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { YamuxProbe, YAMUX_PROBE_DEFAULT_URL } from "../src/components/YamuxProbe.tsx";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<YamuxProbe />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("接続と応答確認の操作口が安定した識別子と表示で並ぶ", () => {
  mount();
  const connect = document.getElementById("yamux-connect");
  const ping = document.getElementById("yamux-ping");
  expect(connect?.textContent).toBe("Yamux接続");
  expect(ping?.textContent).toBe("Yamux echo+ping");
  const field = document.querySelector(".yamux-url") as HTMLInputElement | null;
  expect(field?.value).toBe(YAMUX_PROBE_DEFAULT_URL);
  expect(field?.value).toBe("ws://127.0.0.1:5180/spike");
  expect(document.querySelector(".yamux-panel pre.diag-log")).not.toBeNull();
});

test("描画だけでは接続を開始しない", () => {
  mount();
  // 未接続のため応答確認は押せず、行ログは空のままである。
  expect((document.getElementById("yamux-ping") as HTMLButtonElement | null)?.disabled).toBe(true);
  expect(document.querySelector(".yamux-panel pre.diag-log")?.textContent).toBe("");
});
