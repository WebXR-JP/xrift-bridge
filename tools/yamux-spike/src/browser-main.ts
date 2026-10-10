/**
 * ブラウザ確認口の画面処理。
 *
 * Node の yamux サーバ（spike-server）へブラウザ WebSocket でつなぎ、
 * 同じアダプタで mux が動くかを人間が実機で確かめる。自動化はしない。
 * 接続・応答の手順は `./browser-probe.ts` の再利用口に寄せる。
 *
 * @packageDocumentation
 */

import { runBrowserProbe } from "./browser-probe.ts";
import type { BrowserProbeSession } from "./browser-probe.ts";

const urlInput = document.getElementById("url") as HTMLInputElement;
const connectButton = document.getElementById("connect") as HTMLButtonElement;
const pingButton = document.getElementById("ping") as HTMLButtonElement;
const logPane = document.getElementById("log") as HTMLPreElement;

/** 画面へ1行出す。 */
function logLine(line: string): void {
  logPane.textContent += `${line}\n`;
  logPane.scrollTop = logPane.scrollHeight;
}

let session: BrowserProbeSession | undefined;

connectButton.addEventListener("click", () => {
  connectButton.disabled = true;
  void (async () => {
    try {
      session = await runBrowserProbe(urlInput.value, logLine);
      logLine("Ping ボタンで疎通を確かめられる。");
      pingButton.disabled = false;
    } catch (cause) {
      logLine(`失敗した: ${cause instanceof Error ? cause.message : String(cause)}`);
      connectButton.disabled = false;
    }
  })();
});

pingButton.addEventListener("click", () => {
  if (session === undefined) return;
  pingButton.disabled = true;
  void (async () => {
    try {
      await session.probeEchoPing();
    } catch (cause) {
      logLine(`失敗した: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      pingButton.disabled = false;
    }
  })();
});
