/**
 * サーバ側の診断ハンドラ（reliable Session 上の限定応答）。
 *
 * reliable Session で届く payload を検証し、echo 相当（受信値の返送）と
 * ping 相当（固定応答）だけに応答する。業務 requestId を wire に追加せず、
 * 応答相関は Session（yamux stream 単位）に委ねる。任意ローカル操作の
 * 実行口は持たせず、ペイロードは診断用途に限定する。
 *
 * 診断 payload の形状：
 * - echo: `{ "op": "echo", "value": <JSON 値> }` → `{ "op": "echo", "value": <同じ値> }`
 * - ping: `{ "op": "ping" }` → `{ "op": "pong" }`
 *
 * 不正形状は当該 Session のみ中断（RST）し、他 Session と Connection は維持する。
 *
 * @packageDocumentation
 */
import { isJsonValue } from "bridge-protocol";
import type { Session } from "bridge-protocol/transport";

/** 診断応答の計数口。 */
export interface DiagnosticCounter {
  /** echo 応答を1件数える。 */
  recordEcho(): void;
  /** ping 応答を1件数える。 */
  recordPing(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 診断 payload を検証し、応答 payload を作る。
 *
 * @param payload - 受信した JSON 値。
 * @returns 応答 payload。想定外なら `null`。
 */
function toDiagnosticResponse(payload: unknown): {
  readonly ok: boolean;
  readonly response: unknown;
} {
  if (!isRecord(payload)) return { ok: false, response: null };
  const keys = Object.keys(payload);
  const op: unknown = payload["op"];
  if (op === "ping") {
    // ping は `op` のみ許し、余分なキーを黙って受理しない。
    if (keys.length !== 1) return { ok: false, response: null };
    return { ok: true, response: { op: "pong" } };
  }
  if (op === "echo") {
    if (keys.length !== 2) return { ok: false, response: null };
    if (!("value" in payload)) return { ok: false, response: null };
    const value: unknown = payload["value"];
    if (!isJsonValue(value)) return { ok: false, response: null };
    return { ok: true, response: { op: "echo", value } };
  }
  return { ok: false, response: null };
}

/**
 * reliable Session の受信 payload を診断応答する。
 *
 * @param session - 応答に使う Session（送信側であること）。
 * @param payload - 受信した JSON 値。
 * @param counter - 応答の計数口。
 */
export function handleDiagnosticPayload(
  session: Session,
  payload: unknown,
  counter: DiagnosticCounter,
): void {
  const result = toDiagnosticResponse(payload);
  if (!result.ok) {
    // ADR: 不正形状は当該 Session のみ中断し、Connection・他 Session は維持する。
    // Connection 終端・WS 切断は行わない。
    try {
      session.abort(new Error("診断 payload の形状が不正である。"));
    } catch {
      // 中断の失敗は無視する。
    }
    return;
  }
  const response = result.response as Record<string, unknown>;
  if (response["op"] === "pong") {
    counter.recordPing();
  } else {
    counter.recordEcho();
  }
  // ADR: 応答の送出失敗は Session 終端として扱い、呼び出し側で RST する。
  // 未決着の約束は transport（B2）が拒否し、ここで待機を作らない。
  void session.sendReliable(response).catch(() => {
    // 送出失敗は Session が既に終端している場合が多く、何もしない。
  });
}
