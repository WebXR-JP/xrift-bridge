/**
 * 受信メッセージの実行時検証。
 *
 * 外部入力は境界で `unknown` として受け、ここで妥当性を検査してから内部の型へ
 * 変換する。型注釈や型アサーションは検証にならない。
 *
 * @packageDocumentation
 */
import {
  PAIRING_CODE_LENGTH,
  PROTOCOL_VERSION,
  type AuthOkMessage,
  type BridgeMessage,
  type CommandRequestMessage,
  type CommandResponseMessage,
  type CreditMessage,
  type DataMessage,
  type EchoMessage,
  type EchoResponseMessage,
  type ErrorMessage,
  type PairingCode,
  type PairingPendingMessage,
  type PairingRequestId,
  type PairingStartMessage,
} from "./messages.ts";

/** 検証失敗の符号。 */
export type ProtocolErrorCode =
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "VERSION_MISMATCH"
  | "UNKNOWN_TYPE";

/** 受信検証の失敗。回復不能な入力異常として扱い呼び出し側で切断等を選ぶ。 */
export class ProtocolError extends Error {
  /** 機械可読の符号。 */
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** 識別子に使える文字の上限。 */
export const MAX_ID_LENGTH = 128;

/** ストリーム識別子の書式。 */
const STREAM_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 比較コードの書式。ASCII 数字のみで長さは `PAIRING_CODE_LENGTH` に従う。 */
const PAIRING_CODE_PATTERN = new RegExp(`^[0-9]{${PAIRING_CODE_LENGTH}}$`);

/** ペアリング要求 ID の書式。1〜128 文字の範囲は `readId` の長さ検査で担う。 */
const PAIRING_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** JSON 値として送受信できるか判定する。 */
export function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
      return true;
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      // ADR: プレーンオブジェクトのみ許可する。class 实例や特殊組込み型の
      // 暗黙変換を避けるため prototype で判定する。
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    }
    default:
      // undefined・function・symbol・bigint は JSON 化できないため拒否する。
      return false;
  }
}

/**
 * 比較コード（ASCII 数字 6 文字、`000000` を含む）か判定する。
 *
 * @param value - 検査する未知値。
 * @returns ASCII 数字のみで `PAIRING_CODE_LENGTH` 文字の場合に真。
 */
export function isPairingCode(value: unknown): value is PairingCode {
  return (
    typeof value === "string" &&
    value.length === PAIRING_CODE_LENGTH &&
    PAIRING_CODE_PATTERN.test(value)
  );
}

/**
 * ペアリング要求 ID（1〜128 文字の `[A-Za-z0-9._-]`）か判定する。
 *
 * @param value - 検査する未知値。
 * @returns 要求 ID 書式を満たす場合に真。
 */
export function isPairingRequestId(value: unknown): value is PairingRequestId {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    PAIRING_REQUEST_ID_PATTERN.test(value)
  );
}

/**
 * 比較コードを人間が照合しやすい共有形式に変換する。
 *
 * @param code - ASCII 数字 6 文字の比較コード。事前検証済みでも未検証でもよい。
 * @returns 3 桁区切りの表示形（例: `"000123"` → `"000 123"`、半角スペース）。
 * @throws `RangeError` — `code` が比較コード書式でない場合。
 */
export function formatPairingCode(code: string): string {
  if (!isPairingCode(code)) {
    throw new RangeError("比較コードは ASCII 数字 6 文字であること。");
  }
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readVersion(value: Record<string, unknown>): string {
  if (typeof value["v"] !== "string") {
    throw new ProtocolError("INVALID_MESSAGE", "フィールド `v` は文字列であること。");
  }
  if (value["v"] !== PROTOCOL_VERSION) {
    throw new ProtocolError("VERSION_MISMATCH", `未対応の protocol version である: ${value["v"]}`);
  }
  return value["v"];
}

function readId(value: Record<string, unknown>, field: string, pattern?: RegExp): string {
  const raw: unknown = value[field];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ID_LENGTH) {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      `フィールド \`${field}\` は 1〜${MAX_ID_LENGTH} 文字の文字列であること。`,
    );
  }
  if (pattern !== undefined && !pattern.test(raw)) {
    throw new ProtocolError("INVALID_MESSAGE", `フィールド \`${field}\` の書式が不正である。`);
  }
  return raw;
}

function readPairingCode(value: Record<string, unknown>, field: string): PairingCode {
  const raw: unknown = value[field];
  if (!isPairingCode(raw)) {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      `フィールド \`${field}\` は ASCII 数字 ${PAIRING_CODE_LENGTH} 文字であること。`,
    );
  }
  return raw;
}

function readPairingRequestId(value: Record<string, unknown>, field: string): PairingRequestId {
  return readId(value, field, PAIRING_REQUEST_ID_PATTERN);
}

function readSeq(value: Record<string, unknown>): number {
  const raw: unknown = value["seq"];
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > Number.MAX_SAFE_INTEGER
  ) {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      "フィールド `seq` は 0 以上の安全な整数であること。",
    );
  }
  return raw;
}

function readKind(value: Record<string, unknown>): "reliable" | "latest" {
  const raw: unknown = value["kind"];
  if (raw !== "reliable" && raw !== "latest") {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      "フィールド `kind` は `reliable` または `latest` であること。",
    );
  }
  return raw;
}

function readPayload(value: Record<string, unknown>): unknown {
  if (!("payload" in value) || !isJsonValue(value["payload"])) {
    throw new ProtocolError("INVALID_MESSAGE", "フィールド `payload` は JSON 値であること。");
  }
  return value["payload"];
}

function readOptionalPayload(value: Record<string, unknown>): unknown {
  if (!("params" in value) && !("result" in value)) return undefined;
  const raw: unknown = "params" in value ? value["params"] : value["result"];
  if (raw === undefined) return undefined;
  if (!isJsonValue(raw)) {
    throw new ProtocolError("INVALID_MESSAGE", "任意フィールドは JSON 値であること。");
  }
  return raw;
}

/**
 * 受信した生データ（文字列または未知値）を v0.2 メッセージとして検証する。
 *
 * @param raw - WebSocket 受信値。文字列は JSON として構文解析する。
 * @returns 検証済みのメッセージ。
 * @throws `ProtocolError` — JSON 異常・フィールド不足・型不正・版不一致・未知種別の場合。
 */
export function parseBridgeMessage(raw: unknown): BridgeMessage {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new ProtocolError("INVALID_JSON", "JSON として構文解析できない。");
    }
  }
  if (!isRecord(value)) {
    throw new ProtocolError("INVALID_MESSAGE", "メッセージは JSON オブジェクトであること。");
  }
  if (typeof value["type"] !== "string") {
    throw new ProtocolError("INVALID_MESSAGE", "フィールド `type` は文字列であること。");
  }
  const v = readVersion(value);
  switch (value["type"]) {
    case "pairing_start": {
      return {
        v,
        type: "pairing_start",
      } satisfies PairingStartMessage;
    }
    case "pairing_pending": {
      return {
        v,
        type: "pairing_pending",
        requestId: readPairingRequestId(value, "requestId"),
        code: readPairingCode(value, "code"),
        expiresAt: readCount(value, "expiresAt"),
        expiresInMs: readPositiveCount(value, "expiresInMs"),
      } satisfies PairingPendingMessage;
    }
    case "auth_ok": {
      const window = readWindow(value);
      return {
        v,
        type: "auth_ok",
        requestId: readPairingRequestId(value, "requestId"),
        sessionId: readId(value, "sessionId"),
        window,
      } satisfies AuthOkMessage;
    }
    case "echo": {
      return {
        v,
        type: "echo",
        sessionId: readId(value, "sessionId"),
        streamId: readId(value, "streamId", STREAM_ID_PATTERN),
        kind: readReliable(value),
        seq: readSeq(value),
        requestId: readId(value, "requestId"),
        payload: readPayload(value),
      } satisfies EchoMessage;
    }
    case "echo_response": {
      return {
        v,
        type: "echo_response",
        sessionId: readId(value, "sessionId"),
        streamId: readId(value, "streamId", STREAM_ID_PATTERN),
        kind: readReliable(value),
        seq: readSeq(value),
        requestId: readId(value, "requestId"),
        payload: readPayload(value),
      } satisfies EchoResponseMessage;
    }
    case "command_request": {
      const message: CommandRequestMessage = {
        v,
        type: "command_request",
        sessionId: readId(value, "sessionId"),
        streamId: readId(value, "streamId", STREAM_ID_PATTERN),
        kind: readReliable(value),
        seq: readSeq(value),
        requestId: readId(value, "requestId"),
        command: readId(value, "command"),
      };
      const params = readOptionalPayload(value);
      return params === undefined ? message : { ...message, params };
    }
    case "command_response": {
      if (typeof value["ok"] !== "boolean") {
        throw new ProtocolError("INVALID_MESSAGE", "フィールド `ok` は真偽値であること。");
      }
      const message: CommandResponseMessage = {
        v,
        type: "command_response",
        sessionId: readId(value, "sessionId"),
        requestId: readId(value, "requestId"),
        ok: value["ok"],
      };
      if ("result" in value && value["result"] !== undefined) {
        if (!isJsonValue(value["result"])) {
          throw new ProtocolError("INVALID_MESSAGE", "フィールド `result` は JSON 値であること。");
        }
        return { ...message, result: value["result"] };
      }
      if ("error" in value && value["error"] !== undefined) {
        if (
          !isRecord(value["error"]) ||
          typeof value["error"]["code"] !== "string" ||
          typeof value["error"]["message"] !== "string"
        ) {
          throw new ProtocolError("INVALID_MESSAGE", "フィールド `error` は符号と説明を持つこと。");
        }
        return {
          ...message,
          error: {
            code: value["error"]["code"],
            message: value["error"]["message"],
          },
        };
      }
      return message;
    }
    case "data": {
      return {
        v,
        type: "data",
        sessionId: readId(value, "sessionId"),
        streamId: readId(value, "streamId", STREAM_ID_PATTERN),
        kind: readKind(value),
        seq: readSeq(value),
        payload: readPayload(value),
      } satisfies DataMessage;
    }
    case "credit": {
      return {
        v,
        type: "credit",
        sessionId: readId(value, "sessionId"),
        limit: readCount(value, "limit"),
      } satisfies CreditMessage;
    }
    case "error": {
      if (
        typeof value["code"] !== "string" ||
        value["code"].length === 0 ||
        typeof value["message"] !== "string"
      ) {
        throw new ProtocolError("INVALID_MESSAGE", "フィールド `code`・`message` が不正である。");
      }
      const message: ErrorMessage = {
        v,
        type: "error",
        code: value["code"],
        message: value["message"],
      };
      // ADR: 任意の sessionId/requestId は存在すれば検証し、不正な値を黙って
      // 省略しない。`undefined` は JSON 往復で消えるため欠落として扱う。
      // `error.requestId` は業務相関ID（汎用 `RequestId`）とペアリングID
      // （`PairingRequestId`）の両方を運ぶため、共通フィールドでは文字列・
      // 長さ1〜128のみを検証し、ドメインは処理文脈で判断する。
      const withSession =
        "sessionId" in value && value["sessionId"] !== undefined
          ? { ...message, sessionId: readId(value, "sessionId") }
          : message;
      return "requestId" in value && value["requestId"] !== undefined
        ? { ...withSession, requestId: readId(value, "requestId") }
        : withSession;
    }
    default:
      throw new ProtocolError("UNKNOWN_TYPE", `未知のメッセージ種別である: ${value["type"]}`);
  }
}

function readReliable(value: Record<string, unknown>): "reliable" {
  if (value["kind"] !== "reliable") {
    throw new ProtocolError("INVALID_MESSAGE", "この種別は `kind: reliable` のみ扱う。");
  }
  return "reliable";
}

function readWindow(value: Record<string, unknown>): number {
  return readCount(value, "window");
}

/** 累積付与などの件数を 0 以上の安全な整数として読む。 */
function readCount(value: Record<string, unknown>, field: string): number {
  const raw: unknown = value[field];
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > Number.MAX_SAFE_INTEGER
  ) {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      `フィールド \`${field}\` は 0 以上の安全な整数であること。`,
    );
  }
  return raw;
}

/** 残り時間などの件数を正の安全な整数として読む。 */
function readPositiveCount(value: Record<string, unknown>, field: string): number {
  const raw: unknown = value[field];
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    raw > Number.MAX_SAFE_INTEGER
  ) {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      `フィールド \`${field}\` は正の安全な整数であること。`,
    );
  }
  return raw;
}

/**
 * 送信メッセージを wire 形式の文字列へ変換する。
 *
 * @param message - 送信する v0.2 メッセージ。
 * @returns JSON 文字列。`payload` 等は JSON 値であることが前提。
 */
export function stringifyBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify(message);
}
