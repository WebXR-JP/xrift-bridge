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
  type ConnectionId,
  type DataMessage,
  type ErrorMessage,
  type PairingCode,
  type PairingPendingMessage,
  type PairingRequestId,
  type PairingStartMessage,
  type SessionDirection,
  type SessionId,
  type SessionKind,
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

/** セッション識別子（論理名）の書式。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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

// ADR: 各種別の許可キーを明示し、削除済み・未知のキーを黙って受理しない。
// `window`・`sessionId`（auth_ok の旧形）・`streamId`・`kind`（data に載せない）
// などはここで拒否する。`data.seq` の要否（latest 必須・reliable 禁止）は
// Session が `kind` を保持して判断するため、ここでは形式のみ検証する。
function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProtocolError("INVALID_MESSAGE", `未知のフィールドである: \`${key}\`。`);
    }
  }
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

function readConnectionId(value: Record<string, unknown>, field: string): ConnectionId {
  return readId(value, field);
}

function readSessionId(value: Record<string, unknown>, field: string): SessionId {
  return readId(value, field, SESSION_ID_PATTERN);
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

function readKind(value: Record<string, unknown>): SessionKind {
  const raw: unknown = value["kind"];
  if (raw !== "reliable" && raw !== "latest") {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      "フィールド `kind` は `reliable` または `latest` であること。",
    );
  }
  return raw;
}

function readDirection(value: Record<string, unknown>): SessionDirection {
  const raw: unknown = value["direction"];
  if (raw !== "to_client" && raw !== "to_server" && raw !== "bidirectional") {
    throw new ProtocolError(
      "INVALID_MESSAGE",
      "フィールド `direction` は `to_client`・`to_server`・`bidirectional` のいずれかであること。",
    );
  }
  return raw;
}

// `data.seq` は存在する場合のみ形式を検証する。要否の判断は Session 境界に委ねる。
function readOptionalSeq(value: Record<string, unknown>): number | undefined {
  if (!("seq" in value) || value["seq"] === undefined) return undefined;
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

function readPayload(value: Record<string, unknown>): unknown {
  if (!("payload" in value) || !isJsonValue(value["payload"])) {
    throw new ProtocolError("INVALID_MESSAGE", "フィールド `payload` は JSON 値であること。");
  }
  return value["payload"];
}

/**
 * 受信した生データ（文字列または未知値）を v0.3 メッセージとして検証する。
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
      assertOnlyKeys(value, new Set(["v", "type"]));
      return {
        v,
        type: "pairing_start",
      } satisfies PairingStartMessage;
    }
    case "pairing_pending": {
      assertOnlyKeys(
        value,
        new Set(["v", "type", "requestId", "code", "expiresAt", "expiresInMs"]),
      );
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
      assertOnlyKeys(value, new Set(["v", "type", "requestId", "connectionId"]));
      return {
        v,
        type: "auth_ok",
        requestId: readPairingRequestId(value, "requestId"),
        connectionId: readConnectionId(value, "connectionId"),
      } satisfies AuthOkMessage;
    }
    case "create_session": {
      assertOnlyKeys(
        value,
        new Set(["v", "type", "connectionId", "sessionId", "kind", "direction"]),
      );
      const connectionId = readConnectionId(value, "connectionId");
      const sessionId = readSessionId(value, "sessionId");
      const kind = readKind(value);
      const direction = readDirection(value);
      // ADR: `kind` と `direction` の組合せは型でも表すが、外部入力はここで
      // 検証する。reliable は双方向のみ、latest は一方向のみである。
      if (kind === "reliable") {
        if (direction !== "bidirectional") {
          throw new ProtocolError(
            "INVALID_MESSAGE",
            "reliable セッションの `direction` は `bidirectional` であること。",
          );
        }
        return { v, type: "create_session", connectionId, sessionId, kind, direction };
      }
      if (direction === "bidirectional") {
        throw new ProtocolError(
          "INVALID_MESSAGE",
          "latest セッションの `direction` は `to_client` または `to_server` であること。",
        );
      }
      return { v, type: "create_session", connectionId, sessionId, kind, direction };
    }
    case "data": {
      assertOnlyKeys(value, new Set(["v", "type", "connectionId", "sessionId", "payload", "seq"]));
      const seq = readOptionalSeq(value);
      const base = {
        v,
        type: "data",
        connectionId: readConnectionId(value, "connectionId"),
        sessionId: readSessionId(value, "sessionId"),
        payload: readPayload(value),
      } as const;
      return (seq === undefined ? { ...base } : { ...base, seq }) satisfies DataMessage;
    }
    case "error": {
      assertOnlyKeys(value, new Set(["v", "type", "code", "message", "connectionId", "requestId"]));
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
      // ADR: 任意の connectionId/requestId は存在すれば検証し、不正な値を黙って
      // 省略しない。`undefined` は JSON 往復で消えるため欠落として扱う。
      // `error.requestId` はペアリング相関専用であり業務相関には使わないため、
      // ペアリング要求 ID の書式で検証する。
      const withConnection =
        "connectionId" in value && value["connectionId"] !== undefined
          ? { ...message, connectionId: readConnectionId(value, "connectionId") }
          : message;
      return "requestId" in value && value["requestId"] !== undefined
        ? { ...withConnection, requestId: readPairingRequestId(value, "requestId") }
        : withConnection;
    }
    default:
      throw new ProtocolError("UNKNOWN_TYPE", `未知のメッセージ種別である: ${value["type"]}`);
  }
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
 * @param message - 送信する v0.3 メッセージ。
 * @returns JSON 文字列。`payload` 等は JSON 値であることが前提。
 */
export function stringifyBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify(message);
}
