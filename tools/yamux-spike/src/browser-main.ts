/**
 * ブラウザ確認口の画面処理。
 *
 * Node の yamux サーバ（spike-server）へブラウザ WebSocket でつなぎ、
 * 同じアダプタで mux が動くかを人間が実機で確かめる。自動化はしない。
 *
 * @packageDocumentation
 */

import { yamux } from "@chainsafe/libp2p-yamux";
import type { StreamMuxerFactory } from "@libp2p/interface";
import { FrameDecoder, encodeFrameJson } from "./framing.ts";
import { wrapBrowserSocket } from "./browser-socket.ts";
import { WsMessageStream } from "./ws-transport.ts";
import { createSpikeLogger } from "./spike-logger.ts";

const urlInput = document.getElementById("url") as HTMLInputElement;
const connectButton = document.getElementById("connect") as HTMLButtonElement;
const pingButton = document.getElementById("ping") as HTMLButtonElement;
const logPane = document.getElementById("log") as HTMLPreElement;

/** 画面へ1行出す。 */
function logLine(line: string): void {
  logPane.textContent += `${line}\n`;
  logPane.scrollTop = logPane.scrollHeight;
}

/** プリリュードのテキスト1件の受信を待つ。 */
function receiveText(ws: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("auth_ok の受信が期限切れになった"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        cleanup();
        reject(new Error("テキスト待ちの間にバイナリが届いた"));
        return;
      }
      cleanup();
      resolve(event.data);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("途中で閉じた"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

/** ブラウザ側の muxer 型（`YamuxMuxer` は root から型輸出されないため取り出す）。 */
type BrowserMuxer = ReturnType<typeof yamux> extends () => StreamMuxerFactory<infer M> ? M : never;

let muxer: BrowserMuxer | undefined;

connectButton.addEventListener("click", () => {
  connectButton.disabled = true;
  void (async () => {
    try {
      const ws = new WebSocket(urlInput.value);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("接続できない")), { once: true });
      });
      logLine("接続した。pairing_start を送る。");
      ws.send(JSON.stringify({ v: 0, type: "pairing_start" }));
      const raw = await receiveText(ws, 5000);
      logLine(`受信: ${raw}`);
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>)["type"] !== "auth_ok"
      ) {
        throw new Error("auth_ok ではない応答が来た");
      }
      logLine("認可された。同じソケットで mux を開始する。");
      // 以降のテキスト扱いを外し、バイナリ専用へ切り替える。
      ws.onmessage = null;
      const transport = new WsMessageStream(wrapBrowserSocket(ws), {
        direction: "outbound",
        log: createSpikeLogger("browser"),
      });
      muxer = yamux({ enableKeepAlive: false })().createStreamMuxer(transport);
      logLine("mux 開始した。Ping ボタンで疎通を確かめられる。");
      pingButton.disabled = false;
    } catch (cause) {
      logLine(`失敗した: ${cause instanceof Error ? cause.message : String(cause)}`);
      connectButton.disabled = false;
    }
  })();
});

pingButton.addEventListener("click", () => {
  if (muxer === undefined) return;
  pingButton.disabled = true;
  void (async () => {
    try {
      const stream = await muxer!.createStream();
      const decoder = new FrameDecoder();
      const received = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("echo 応答が期限切れになった")), 5000);
        stream.addEventListener("message", (event) => {
          const raw = event.data;
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw.subarray());
          const values = decoder.push(bytes);
          if (values.length > 0) {
            clearTimeout(timer);
            resolve(values[0]);
          }
        });
      });
      stream.send(encodeFrameJson({ hello: "browser" }));
      const echoed = await received;
      logLine(`echo 応答: ${JSON.stringify(echoed)}`);
      const rtt = await muxer!.ping();
      logLine(`ping 往復: ${rtt}ms`);
      await stream.close().catch(() => undefined);
    } catch (cause) {
      logLine(`失敗した: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      pingButton.disabled = false;
    }
  })();
});
