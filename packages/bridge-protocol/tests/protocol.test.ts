import { expect, test } from "vite-plus/test";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  formatPairingCode,
  isJsonValue,
  isPairingCode,
  isPairingRequestId,
  parseBridgeMessage,
  stringifyBridgeMessage,
  type BridgeMessage,
} from "../src/index.ts";

function validPairingPending(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "pairing_pending",
    requestId: "pair-1",
    code: "000123",
    expiresAt: 1700000000000,
    expiresInMs: 120000,
  };
}

function validAuthOk(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "auth_ok",
    requestId: "pair-1",
    connectionId: "conn-1",
  };
}

function validCreateReliable(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "create_session",
    connectionId: "conn-1",
    sessionId: "main",
    kind: "reliable",
    direction: "bidirectional",
  };
}

function validCreateLatest(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "create_session",
    connectionId: "conn-1",
    sessionId: "pose",
    kind: "latest",
    direction: "to_client",
  };
}

function validReliableData(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "data",
    connectionId: "conn-1",
    sessionId: "main",
    payload: { text: "hello" },
  };
}

function validLatestData(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "data",
    connectionId: "conn-1",
    sessionId: "pose",
    seq: 3,
    payload: { x: 1 },
  };
}

function parseError(raw: unknown): ProtocolError | undefined {
  try {
    // ADR: JSON 化できない値（NaN・関数）の検証を素通しさせないため、
    // 文字列化せず生値のまま検証する。文字列入力の JSON 異常系は別途文字列で渡す。
    parseBridgeMessage(raw);
  } catch (caught) {
    return caught as ProtocolError;
  }
  return undefined;
}

test("ペアリング開始を受理する", () => {
  const message = parseBridgeMessage(
    JSON.stringify({ v: PROTOCOL_VERSION, type: "pairing_start" }),
  );
  expect(message.type).toBe("pairing_start");
});

test("ペアリング保留・認証応答・セッション作成・データ・エラー型を受理する", () => {
  const samples: Array<{ raw: unknown; type: BridgeMessage["type"] }> = [
    { raw: { v: PROTOCOL_VERSION, type: "pairing_start" }, type: "pairing_start" },
    { raw: validPairingPending(), type: "pairing_pending" },
    { raw: validAuthOk(), type: "auth_ok" },
    { raw: validCreateReliable(), type: "create_session" },
    { raw: validCreateLatest(), type: "create_session" },
    { raw: validReliableData(), type: "data" },
    { raw: validLatestData(), type: "data" },
    {
      raw: { ...validReliableData(), payload: null },
      type: "data",
    },
    {
      raw: { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m" },
      type: "error",
    },
    {
      raw: {
        v: PROTOCOL_VERSION,
        type: "error",
        code: "E",
        message: "m",
        connectionId: "conn-1",
        requestId: "pair-1",
      },
      type: "error",
    },
  ];
  for (const sample of samples) {
    expect(parseBridgeMessage(JSON.stringify(sample.raw)).type).toBe(sample.type);
  }
});

test("削除済み種別を未知種別として拒否する", () => {
  const raws: unknown[] = [
    { v: PROTOCOL_VERSION, type: "credit", connectionId: "c", limit: 4 },
    {
      v: PROTOCOL_VERSION,
      type: "echo",
      connectionId: "c",
      sessionId: "s",
      seq: 0,
      requestId: "r",
      payload: 1,
    },
    {
      v: PROTOCOL_VERSION,
      type: "echo_response",
      connectionId: "c",
      sessionId: "s",
      seq: 0,
      requestId: "r",
      payload: 1,
    },
    {
      v: PROTOCOL_VERSION,
      type: "command_request",
      connectionId: "c",
      sessionId: "s",
      seq: 0,
      requestId: "r",
      command: "ping",
    },
    {
      v: PROTOCOL_VERSION,
      type: "command_response",
      connectionId: "c",
      requestId: "r",
      ok: true,
    },
    { v: PROTOCOL_VERSION, type: "auth", secret: "s" },
  ];
  for (const raw of raws) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("UNKNOWN_TYPE");
  }
});

test("版不一致・未知種別・JSON 異常を拒否する", () => {
  expect(PROTOCOL_VERSION).toBe("0.3.0");
  const cases: Array<{ raw: unknown; code: ProtocolError["code"] }> = [
    { raw: { ...validReliableData(), v: "9.9.9" }, code: "VERSION_MISMATCH" },
    // 旧版 0.2.0 は版判定で拒否する。
    { raw: { ...validReliableData(), v: "0.2.0" }, code: "VERSION_MISMATCH" },
    // 旧版の credit 形式は版判定で拒否する（limit 欠落でも版不一致が先に検出される）。
    {
      raw: { v: "0.0.0", type: "credit", sessionId: "s", window: 4 },
      code: "VERSION_MISMATCH",
    },
    { raw: { ...validReliableData(), type: "teleport" }, code: "UNKNOWN_TYPE" },
    { raw: "{not json", code: "INVALID_JSON" },
  ];
  for (const { raw, code } of cases) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
});

test("create_session の方向制約を検証する", () => {
  // 受理する組合せ。
  for (const raw of [
    validCreateReliable(),
    validCreateLatest(),
    { ...validCreateLatest(), direction: "to_server" },
  ]) {
    expect(parseBridgeMessage(JSON.stringify(raw)).type).toBe("create_session");
  }
  // 不整合・不正値は拒否する。
  const bad: unknown[] = [
    // reliable は bidirectional のみ。
    { ...validCreateReliable(), direction: "to_client" },
    { ...validCreateReliable(), direction: "to_server" },
    // latest は一方向のみ。
    { ...validCreateLatest(), direction: "bidirectional" },
    { ...validCreateLatest(), kind: "latest", direction: "sideways" },
    { ...validCreateReliable(), kind: "sometimes", direction: "bidirectional" },
    { ...validCreateReliable(), direction: undefined },
    { ...validCreateReliable(), kind: undefined },
    // 識別子の不足・書式不正。
    { ...validCreateReliable(), connectionId: "" },
    { ...validCreateReliable(), connectionId: undefined },
    { ...validCreateReliable(), sessionId: "" },
    { ...validCreateReliable(), sessionId: "../evil" },
    { ...validCreateReliable(), sessionId: "x".repeat(65) },
    { ...validCreateReliable(), sessionId: undefined },
  ];
  for (const raw of bad) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
  }
});

test("data の payload 必須と seq 形式を検証する", () => {
  // `null` の payload は受理する。
  const nulled = parseBridgeMessage(JSON.stringify({ ...validReliableData(), payload: null }));
  expect(nulled.type).toBe("data");
  // seq の有無は形式のみ検証し要否は Session 境界に委ねるため、欠落は受理する。
  const omitted = parseBridgeMessage(JSON.stringify(validReliableData()));
  expect(omitted.type).toBe("data");
  if (omitted.type === "data" && "seq" in omitted) {
    throw new Error("reliable 形状に seq が含まれないこと。");
  }
  const sequenced = parseBridgeMessage(JSON.stringify(validLatestData()));
  expect(sequenced.type).toBe("data");
  if (sequenced.type === "data" && "seq" in sequenced) {
    expect(sequenced.seq).toBe(3);
  } else {
    throw new Error("latest 形状に seq が含まれること。");
  }
  const bad: unknown[] = [
    // payload は存在必須（null は許可）。
    { ...validReliableData(), payload: undefined },
    { ...validReliableData(), payload: Number.NaN },
    { ...validReliableData(), payload: () => {} },
    { ...validLatestData(), payload: undefined },
    // seq が存在する場合は 0 以上の安全な整数であること。
    { ...validLatestData(), seq: -1 },
    { ...validLatestData(), seq: 1.5 },
    { ...validLatestData(), seq: "3" },
    { ...validLatestData(), seq: null },
    // 削除フィールド・未知キーは黙って受理しない。
    { ...validReliableData(), kind: "reliable" },
    { ...validLatestData(), kind: "latest" },
    { ...validReliableData(), unknownField: "extra" },
    { ...validReliableData(), window: 8 },
    // 識別子の不足・書式不正。
    { ...validReliableData(), connectionId: "" },
    { ...validReliableData(), sessionId: "" },
    { ...validReliableData(), sessionId: "../evil" },
    { ...validReliableData(), sessionId: undefined },
    42,
    null,
    [],
  ];
  for (const raw of bad) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
  }
});

test("auth_ok の旧フィールドを拒否する", () => {
  const bad: unknown[] = [
    // 0.3 の auth_ok は requestId と connectionId のみ。旧 sessionId・window は拒否する。
    { ...validAuthOk(), sessionId: "s" },
    { ...validAuthOk(), window: 8 },
    { v: PROTOCOL_VERSION, type: "auth_ok", requestId: "pair-1", sessionId: "s", window: 8 },
    // 必須の欠落・書式不正。
    { v: PROTOCOL_VERSION, type: "auth_ok", connectionId: "conn-1" },
    { v: PROTOCOL_VERSION, type: "auth_ok", requestId: "pair-1" },
    { ...validAuthOk(), requestId: "" },
    { ...validAuthOk(), requestId: "a/b" },
    { ...validAuthOk(), requestId: 42 },
    { ...validAuthOk(), connectionId: "" },
    { ...validAuthOk(), connectionId: 42 },
  ];
  for (const raw of bad) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
  }
});

test("pairing_start の余分なフィールドを拒否する", () => {
  const bad: unknown[] = [
    { v: PROTOCOL_VERSION, type: "pairing_start", sessionId: "s" },
    { v: PROTOCOL_VERSION, type: "pairing_start", connectionId: "c" },
    { v: PROTOCOL_VERSION, type: "pairing_start", window: 8 },
  ];
  for (const raw of bad) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
  }
});

test("pairing_pending の不正値を拒否する", () => {
  const bad: unknown[] = [
    // requestId の欠落・書式不正。
    { ...validPairingPending(), requestId: undefined },
    { ...validPairingPending(), requestId: "" },
    { ...validPairingPending(), requestId: "a b" },
    { ...validPairingPending(), requestId: "a/b" },
    { ...validPairingPending(), requestId: 42 },
    { ...validPairingPending(), requestId: "x".repeat(129) },
    // code の桁数違い・数値・空白混入。
    { ...validPairingPending(), code: undefined },
    { ...validPairingPending(), code: "12345" },
    { ...validPairingPending(), code: "1234567" },
    { ...validPairingPending(), code: 123456 },
    { ...validPairingPending(), code: "12 456" },
    { ...validPairingPending(), code: "12345a" },
    { ...validPairingPending(), code: "１２３４５６" },
    { ...validPairingPending(), code: "" },
    // expiresAt は 0 以上の安全な整数。
    { ...validPairingPending(), expiresAt: undefined },
    { ...validPairingPending(), expiresAt: -1 },
    { ...validPairingPending(), expiresAt: 1.5 },
    { ...validPairingPending(), expiresAt: "1700000000000" },
    // expiresInMs は正の安全な整数。
    { ...validPairingPending(), expiresInMs: undefined },
    { ...validPairingPending(), expiresInMs: 0 },
    { ...validPairingPending(), expiresInMs: -1 },
    { ...validPairingPending(), expiresInMs: 1.5 },
    { ...validPairingPending(), expiresInMs: "120000" },
  ];
  for (const raw of bad) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
  }
});

test("pairing_pending の比較コード境界を受理する", () => {
  for (const code of ["000000", "000123", "999999"]) {
    const message = parseBridgeMessage(JSON.stringify({ ...validPairingPending(), code }));
    expect(message.type).toBe("pairing_pending");
    if (message.type === "pairing_pending") {
      expect(message.code).toBe(code);
    }
  }
});

test("error の任意 connectionId/requestId が不正なら拒否し黙って省略しない", () => {
  const bad: unknown[] = [
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", connectionId: "" },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", connectionId: 42 },
    {
      v: PROTOCOL_VERSION,
      type: "error",
      code: "E",
      message: "m",
      connectionId: "x".repeat(129),
    },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId: "" },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId: 42 },
    // requestId はペアリング相関専用のため業務 ID の書式は拒否する。
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId: "a b" },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId: "a/b" },
    {
      v: PROTOCOL_VERSION,
      type: "error",
      code: "E",
      message: "m",
      requestId: "x".repeat(129),
    },
    // 旧 sessionId は未知フィールドとして拒否する。
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", sessionId: "s" },
  ];
  for (const raw of bad) {
    const error = parseError(raw);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
  }
});

test("比較コードと要求 ID の判定関数が書式を検証する", () => {
  expect(isPairingCode("000000")).toBe(true);
  expect(isPairingCode("000123")).toBe(true);
  expect(isPairingCode("999999")).toBe(true);
  expect(isPairingCode("12345")).toBe(false);
  expect(isPairingCode("1234567")).toBe(false);
  expect(isPairingCode(123456)).toBe(false);
  expect(isPairingCode("12 456")).toBe(false);
  expect(isPairingCode("12345a")).toBe(false);
  expect(isPairingRequestId("pair-1")).toBe(true);
  expect(isPairingRequestId("A.Z_0-9")).toBe(true);
  expect(isPairingRequestId("")).toBe(false);
  expect(isPairingRequestId("a b")).toBe(false);
  expect(isPairingRequestId("a/b")).toBe(false);
  expect(isPairingRequestId("x".repeat(129))).toBe(false);
});

test("比較コードの共有形式が 3 桁区切りになる", () => {
  expect(formatPairingCode("000123")).toBe("000 123");
  expect(formatPairingCode("000000")).toBe("000 000");
  expect(formatPairingCode("999999")).toBe("999 999");
  for (const code of ["12345", "12345a", "", "12 456"]) {
    let error: unknown;
    try {
      formatPairingCode(code);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RangeError);
  }
});

test("JSON 化できない payload 値を検出する", () => {
  expect(isJsonValue({ a: [1, "x", null, true] })).toBe(true);
  expect(isJsonValue(Number.NaN)).toBe(false);
  expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
  expect(isJsonValue(undefined)).toBe(false);
  expect(isJsonValue(() => {})).toBe(false);
  expect(isJsonValue({ nested: { fn: () => {} } })).toBe(false);
});

test("送信変換が往復する", () => {
  const reliable: BridgeMessage = {
    v: PROTOCOL_VERSION,
    type: "data",
    connectionId: "conn-1",
    sessionId: "main",
    payload: [1, 2, 3],
  };
  expect(parseBridgeMessage(stringifyBridgeMessage(reliable))).toEqual(reliable);
  const latest: BridgeMessage = {
    v: PROTOCOL_VERSION,
    type: "data",
    connectionId: "conn-1",
    sessionId: "pose",
    seq: 7,
    payload: [1, 2, 3],
  };
  expect(parseBridgeMessage(stringifyBridgeMessage(latest))).toEqual(latest);
  const created: BridgeMessage = {
    v: PROTOCOL_VERSION,
    type: "create_session",
    connectionId: "conn-1",
    sessionId: "main",
    kind: "reliable",
    direction: "bidirectional",
  };
  expect(parseBridgeMessage(stringifyBridgeMessage(created))).toEqual(created);
});

test("ペアリング往復が変換できる", () => {
  const start: BridgeMessage = { v: PROTOCOL_VERSION, type: "pairing_start" };
  expect(parseBridgeMessage(stringifyBridgeMessage(start))).toEqual(start);
  const pending: BridgeMessage = {
    v: PROTOCOL_VERSION,
    type: "pairing_pending",
    requestId: "pair-1",
    code: "000123",
    expiresAt: 1700000000000,
    expiresInMs: 120000,
  };
  expect(parseBridgeMessage(stringifyBridgeMessage(pending))).toEqual(pending);
});

test("error の connectionId/requestId の長さ境界・不正型・欠落を扱う", () => {
  // 境界受理: 1 文字と 128 文字。
  for (const id of ["x", "x".repeat(128)]) {
    for (const field of ["connectionId", "requestId"] as const) {
      const message = parseBridgeMessage(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "error",
          code: "E",
          message: "m",
          [field]: id,
        }),
      );
      expect(message.type).toBe("error");
      if (message.type === "error") {
        expect(message[field]).toBe(id);
      }
    }
  }
  // 境界拒否: 空文字・129 文字・非文字列は INVALID_MESSAGE。
  for (const id of ["", "x".repeat(129), 42, null]) {
    for (const field of ["connectionId", "requestId"] as const) {
      const error = parseError({
        v: PROTOCOL_VERSION,
        type: "error",
        code: "E",
        message: "m",
        [field]: id,
      });
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
    }
  }
  // 欠落と `undefined` は任意フィールドなしとして受理する。
  const omitted = parseBridgeMessage(
    JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: "E", message: "m" }),
  );
  expect(omitted.type).toBe("error");
  if (omitted.type === "error") {
    expect(omitted.connectionId).toBeUndefined();
    expect(omitted.requestId).toBeUndefined();
  }
  const undefineded = parseBridgeMessage({
    v: PROTOCOL_VERSION,
    type: "error",
    code: "E",
    message: "m",
    connectionId: undefined,
    requestId: undefined,
  });
  expect(undefineded.type).toBe("error");
  if (undefineded.type === "error") {
    expect(undefineded.connectionId).toBeUndefined();
    expect(undefineded.requestId).toBeUndefined();
  }
});
