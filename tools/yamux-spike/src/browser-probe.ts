/**
 * ブラウザ WebSocket 上の yamux 探針（開発確認用の再利用口）。
 *
 * `browser-main.ts` の確認手順（接続→`pairing_start` 送信→`auth_ok` 受信→
 * 同一ソケットで yamux 開始→stream で framed echo→`ping()`）を抜き出し、
 * 診断ワールドの開発エントリからも同じ手順で確かめられるようにする。
 * 画面への表示は呼び出し側が渡す `onLog` へ集め、console・証拠へ
 * payload を残さない。成功は echo 応答の受信をもって判定し、送った値の
 * 配送完了では判定しない。
 *
 * @packageDocumentation
 */

import { yamux } from "@chainsafe/libp2p-yamux";
import type { StreamMuxerFactory } from "@libp2p/interface";
import { FrameDecoder, encodeFrameJson } from "./framing.ts";
import { wrapBrowserSocket } from "./browser-socket.ts";
import { WsMessageStream } from "./ws-transport.ts";
import { createSpikeLogger } from "./spike-logger.ts";

/** プリリュード（`pairing_start`→`auth_ok`）の受信期限。 */
const PRELUDE_TIMEOUT_MS = 5000;

/** echo 応答の受信期限。 */
const ECHO_TIMEOUT_MS = 5000;

/** 応答確認の結果。解決は echo 応答の受信を意味する。 */
export interface BrowserProbeEchoResult {
  /** yamux `ping()` の往復時間（ミリ秒）。 */
  readonly rttMs: number;
}

/** 確立済み探針の操作口。所有するソケットの後片付けは `close` が持つ。 */
export interface BrowserProbeSession {
  /**
   * stream を1本開き、framed echo の応答を受けて `ping()` を測る。
   *
   * @returns echo 応答の受信を意味する解決と ping 往復時間。
   */
  probeEchoPing(): Promise<BrowserProbeEchoResult>;
  /** ソケットを閉じる。繰り返し呼べる。 */
  close(): void;
}

/** ブラウザ側の muxer 型（`YamuxMuxer` は root から型輸出されないため取り出す）。 */
type BrowserMuxer = ReturnType<typeof yamux> extends () => StreamMuxerFactory<infer M> ? M : never;

/** ソケットを開き、`open` まで待つ。 */
function openSocket(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("接続できない")), { once: true });
  });
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

/** `auth_ok` の受信をもって認可済みとみなせるか。 */
function isAuthOk(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  return (parsed as Record<string, unknown>)["type"] === "auth_ok";
}

/**
 * 探針を接続し、同一ソケットで yamux を開始する。
 *
 * 以降の echo+ping は返す操作口で行う。確立・応答の報告は `onLog` へ出し、
 * 送受信した値の中身は出さない（応答の有無と ping 往復時間だけを残す）。
 *
 * @param wsUrl - 接続先（例: `ws://127.0.0.1:5180/spike`）。
 * @param onLog - 画面表示用の行出力。省略時は破棄する。
 * @returns 確立済み探針の操作口。使い終わったら `close` で閉じること。
 */
export async function runBrowserProbe(
  wsUrl: string,
  onLog?: (line: string) => void,
): Promise<BrowserProbeSession> {
  const log = onLog ?? ((): void => undefined);
  const ws = await openSocket(wsUrl);
  try {
    log("接続した。pairing_start を送る。");
    ws.send(JSON.stringify({ v: 0, type: "pairing_start" }));
    const raw = await receiveText(ws, PRELUDE_TIMEOUT_MS);
    if (!isAuthOk(raw)) throw new Error("auth_ok ではない応答が来た");
    log("認可された。同じソケットで mux を開始する。");
    // 以降のテキスト扱いを外し、バイナリ専用へ切り替える。
    ws.onmessage = null;
    const transport = new WsMessageStream(wrapBrowserSocket(ws), {
      direction: "outbound",
      log: createSpikeLogger("browser"),
    });
    const muxer: BrowserMuxer = yamux({ enableKeepAlive: false })().createStreamMuxer(transport);
    log("mux 開始した。");
    let closed = false;
    return {
      async probeEchoPing(): Promise<BrowserProbeEchoResult> {
        const stream = await muxer.createStream();
        try {
          const decoder = new FrameDecoder();
          const received = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("echo 応答が期限切れになった")),
              ECHO_TIMEOUT_MS,
            );
            stream.addEventListener("message", (event) => {
              const rawMessage = event.data;
              const bytes =
                rawMessage instanceof Uint8Array
                  ? rawMessage
                  : new Uint8Array(rawMessage.subarray());
              // 値の中身は使わない。応答が返ったことだけをもって成功とする。
              const values = decoder.push(bytes);
              if (values.length > 0) {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          // ADR: 送る値は固定の確認用であり、呼び出し側から受けない。
          // 受信側（spike-server）は受けた値をそのまま返すため、応答の有無が
          // 往復の証拠になる。値の中身はログ・戻り値に残さない。
          stream.send(encodeFrameJson({ hello: "browser-probe" }));
          await received;
          log("echo 応答を受けた。");
          const rtt = await muxer.ping();
          log(`ping 往復: ${String(rtt)}ms`);
          return { rttMs: rtt };
        } finally {
          await stream.close().catch(() => undefined);
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {
          // 閉じ済み・破棄済みの後片付けは無視する。
        }
      },
    };
  } catch (cause) {
    try {
      ws.close();
    } catch {
      // 確立失敗時の後片付けは無視する。
    }
    throw cause;
  }
}
