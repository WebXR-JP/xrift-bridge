/**
 * 認可プリリュードの境界（既存 JSON 相当 → 同じソケット上で yamux 開始）。
 *
 * 接続直後はテキストで `pairing_start` → `auth_ok` をやりとりし、認可後に
 * 同じソケットをバイナリ専用として mux へ渡す。テキストとバイナリが
 * 混ざらない切替がこの試作の確認点である。
 *
 * WebSocket は順序を保証するため、切替は「送った順・受けた順」で決める。
 * サーバは `auth_ok` の送出完了後に切替、クライアントは `auth_ok` の
 * 受信後に切替える。以降の相手のバイナリは必ず切替後に到着する。
 *
 * @packageDocumentation
 */

import type { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

/** プリリュードで使うメッセージの判別子。 */
export type PreludeType = "pairing_start" | "auth_ok";

/** プリリュードのテキスト1件分。 */
export interface PreludeMessage {
  readonly v: number;
  readonly type: PreludeType;
}

/** 試作のプリリュード版。製品の protocol とは無関係の固定値。 */
export const SPIKE_PRELUDE_VERSION = 0;

/** 不正なプリリュードを表す。接続を続けない根拠にする。 */
export class PreludeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreludeError";
  }
}

/**
 * 受信テキストを行い、想定の型でなければ拒否する。
 *
 * @param raw - 受信したテキスト。
 * @param expected - 想定する型。
 * @returns 検証済みメッセージ。
 * @throws `PreludeError` — 形式・型・版のいずれかが想定外の場合。
 */
export function parsePrelude(raw: string, expected: PreludeType): PreludeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PreludeError("プリリュードが JSON ではない");
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new PreludeError("プリリュードが物体ではない");
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== SPIKE_PRELUDE_VERSION) throw new PreludeError("プリリュードの版が違う");
  if (record["type"] !== expected) throw new PreludeError(`想定外の型: ${String(record["type"])}`);
  return { v: SPIKE_PRELUDE_VERSION, type: expected };
}

/** テキスト1件を送り、送出完了まで待つ（切替前の順序保証のため）。 */
function sendText(ws: NodeWebSocket, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(text, (cause?: Error) => {
      if (cause !== undefined && cause !== null) reject(cause);
      else resolve();
    });
  });
}

/** テキスト1件の受信を待つ。バイナリが先に来たら境界違反として拒否する。 */
function receiveText(ws: NodeWebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new PreludeError("プリリュードの受信が期限切れになった"));
    }, timeoutMs);
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (isBinary) {
        cleanup();
        reject(new PreludeError("テキスト待ちの間にバイナリが届いた"));
        return;
      }
      cleanup();
      resolve(String(data));
    };
    const onClose = (): void => {
      cleanup();
      reject(new PreludeError("プリリュードの途中で閉じた"));
    };
    const onError = (cause: Error): void => {
      cleanup();
      reject(cause);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

/**
 * サーバ側のプリリュードを実行する。
 *
 * `pairing_start` を待って `auth_ok` を送り、送出完了をもって mux 開始へ
 * 進める。呼び出し後はそのソケットでテキストを扱わないこと。
 *
 * @param ws - 接続済みのソケット。
 * @param timeoutMs - 受信の期限。
 */
export async function runPreludeServer(ws: NodeWebSocket, timeoutMs = 5000): Promise<void> {
  const raw = await receiveText(ws, timeoutMs);
  parsePrelude(raw, "pairing_start");
  await sendText(
    ws,
    JSON.stringify({ v: SPIKE_PRELUDE_VERSION, type: "auth_ok" } satisfies PreludeMessage),
  );
}

/**
 * クライアント側のプリリュードを実行する。
 *
 * `pairing_start` を送って `auth_ok` を待ち、受信をもって mux 開始へ
 * 進める。呼び出し後はそのソケットでテキストを扱わないこと。
 *
 * @param ws - 接続済みのソケット。
 * @param timeoutMs - 受信の期限。
 */
export async function runPreludeClient(ws: NodeWebSocket, timeoutMs = 5000): Promise<void> {
  await sendText(
    ws,
    JSON.stringify({ v: SPIKE_PRELUDE_VERSION, type: "pairing_start" } satisfies PreludeMessage),
  );
  const raw = await receiveText(ws, timeoutMs);
  parsePrelude(raw, "auth_ok");
}

/**
 * サーバの待ち受けを作り、最初の接続1件を取り出す。
 *
 * @param wss - 待ち受けサーバ。
 * @param timeoutMs - 接続待ちの期限。
 * @returns 接続済みソケット。
 */
export function waitForConnection(wss: WebSocketServer, timeoutMs = 5000): Promise<NodeWebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new PreludeError("接続待ちが期限切れになった"));
    }, timeoutMs);
    const onConnection = (ws: NodeWebSocket): void => {
      cleanup();
      resolve(ws);
    };
    const onError = (cause: Error): void => {
      cleanup();
      reject(cause);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      wss.off("connection", onConnection);
      wss.off("error", onError);
    };
    wss.on("connection", onConnection);
    wss.on("error", onError);
  });
}
