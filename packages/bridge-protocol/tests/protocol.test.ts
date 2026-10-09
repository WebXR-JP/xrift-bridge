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

function validEcho(): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: "session-1",
    streamId: "main",
    kind: "reliable",
    seq: 0,
    requestId: "req-1",
    payload: { text: "hello" },
  };
}

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

test("echo 要求を受理する", () => {
  const message = parseBridgeMessage(JSON.stringify(validEcho()));
  expect(message.type).toBe("echo");
  if (message.type === "echo") {
    expect(message.seq).toBe(0);
    expect(message.payload).toEqual({ text: "hello" });
  }
});

test("ペアリング開始・保留・認証応答・コマンド・データ・クレジット・エラー型を受理する", () => {
  const samples: Array<{ raw: unknown; type: BridgeMessage["type"] }> = [
    { raw: { v: PROTOCOL_VERSION, type: "pairing_start" }, type: "pairing_start" },
    { raw: validPairingPending(), type: "pairing_pending" },
    {
      raw: { v: PROTOCOL_VERSION, type: "auth_ok", requestId: "pair-1", sessionId: "s", window: 8 },
      type: "auth_ok",
    },
    {
      raw: { ...validEcho(), type: "echo_response" },
      type: "echo_response",
    },
    {
      raw: { ...validEcho(), type: "command_request", command: "ping" },
      type: "command_request",
    },
    {
      raw: {
        v: PROTOCOL_VERSION,
        type: "command_response",
        sessionId: "s",
        requestId: "r",
        ok: true,
        result: "pong",
      },
      type: "command_response",
    },
    {
      raw: {
        v: PROTOCOL_VERSION,
        type: "command_response",
        sessionId: "s",
        requestId: "r",
        ok: false,
        error: { code: "UNKNOWN_COMMAND", message: "ng" },
      },
      type: "command_response",
    },
    {
      raw: { ...validEcho(), type: "data", kind: "latest", seq: 3 },
      type: "data",
    },
    {
      raw: { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: 4 },
      type: "credit",
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
        sessionId: "s",
        requestId: "pair-1",
      },
      type: "error",
    },
  ];
  for (const sample of samples) {
    expect(parseBridgeMessage(JSON.stringify(sample.raw)).type).toBe(sample.type);
  }
});

test("旧 auth は未知種別として拒否する", () => {
  let error: unknown;
  try {
    parseBridgeMessage(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth", secret: "s" }));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProtocolError);
  expect((error as ProtocolError).code).toBe("UNKNOWN_TYPE");
});

test("版不一致・未知種別・JSON 異常を拒否する", () => {
  expect(PROTOCOL_VERSION).toBe("0.2.0");
  const cases: Array<{ raw: unknown; code: ProtocolError["code"] }> = [
    { raw: { ...validEcho(), v: "9.9.9" }, code: "VERSION_MISMATCH" },
    // 旧版 0.1.0 は版判定で拒否する。
    { raw: { ...validEcho(), v: "0.1.0" }, code: "VERSION_MISMATCH" },
    // 旧版の credit 形式は版判定で拒否する（limit 欠落でも版不一致が先に検出される）。
    {
      raw: { v: "0.0.0", type: "credit", sessionId: "s", window: 4 },
      code: "VERSION_MISMATCH",
    },
    { raw: { ...validEcho(), type: "teleport" }, code: "UNKNOWN_TYPE" },
    { raw: "{not json", code: "INVALID_JSON" },
  ];
  for (const { raw, code } of cases) {
    let error: unknown;
    try {
      parseBridgeMessage(typeof raw === "string" ? raw : JSON.stringify(raw));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
});

test("フィールド不足・型不正・不正連番・不正ストリーム名を拒否する", () => {
  const bad: unknown[] = [
    { ...validEcho(), seq: undefined },
    { ...validEcho(), seq: -1 },
    { ...validEcho(), seq: 1.5 },
    { ...validEcho(), kind: "latest" },
    { ...validEcho(), streamId: "../evil" },
    { ...validEcho(), streamId: "" },
    { ...validEcho(), payload: undefined },
    { ...validEcho(), requestId: "" },
    { ...validEcho(), type: "data", kind: "sometimes" },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s" },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: -1 },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: 1.5 },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: "4" },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: null },
    // auth_ok は requestId が必須である。
    { v: PROTOCOL_VERSION, type: "auth_ok", sessionId: "s", window: 8 },
    { v: PROTOCOL_VERSION, type: "auth_ok", requestId: "", sessionId: "s", window: 8 },
    { v: PROTOCOL_VERSION, type: "auth_ok", requestId: "a/b", sessionId: "s", window: 8 },
    { v: PROTOCOL_VERSION, type: "auth_ok", requestId: 42, sessionId: "s", window: 8 },
    42,
    null,
    [],
  ];
  for (const raw of bad) {
    let error: unknown;
    try {
      parseBridgeMessage(JSON.stringify(raw));
    } catch (caught) {
      error = caught;
    }
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
    let error: unknown;
    try {
      parseBridgeMessage(JSON.stringify(raw));
    } catch (caught) {
      error = caught;
    }
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

test("error の任意 sessionId/requestId が不正なら拒否し黙って省略しない", () => {
  const bad: unknown[] = [
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", sessionId: "" },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", sessionId: 42 },
    {
      v: PROTOCOL_VERSION,
      type: "error",
      code: "E",
      message: "m",
      sessionId: "x".repeat(129),
    },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId: "" },
    { v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId: 42 },
    {
      v: PROTOCOL_VERSION,
      type: "error",
      code: "E",
      message: "m",
      requestId: "x".repeat(129),
    },
  ];
  for (const raw of bad) {
    let error: unknown;
    try {
      parseBridgeMessage(JSON.stringify(raw));
    } catch (caught) {
      error = caught;
    }
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
  const message: BridgeMessage = {
    v: PROTOCOL_VERSION,
    type: "echo",
    sessionId: "s",
    streamId: "main",
    kind: "reliable",
    seq: 7,
    requestId: "r",
    payload: [1, 2, 3],
  };
  expect(parseBridgeMessage(stringifyBridgeMessage(message))).toEqual(message);
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

test("業務IDの空白・`/` は echo/command_request と error では受理する", () => {
  for (const requestId of ["a b", "a/b"]) {
    const echo = parseBridgeMessage(JSON.stringify({ ...validEcho(), requestId }));
    expect(echo.type).toBe("echo");
    if (echo.type === "echo") {
      expect(echo.requestId).toBe(requestId);
    }
    const command = parseBridgeMessage(
      JSON.stringify({ ...validEcho(), type: "command_request", command: "ping", requestId }),
    );
    expect(command.type).toBe("command_request");
    const error = parseBridgeMessage(
      JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: "E", message: "m", requestId }),
    );
    expect(error.type).toBe("error");
    if (error.type === "error") {
      expect(error.requestId).toBe(requestId);
    }
  }
});

test("業務IDの空白・`/` は pairing_pending/auth_ok では拒否する", () => {
  for (const requestId of ["a b", "a/b"]) {
    for (const raw of [
      { ...validPairingPending(), requestId },
      { v: PROTOCOL_VERSION, type: "auth_ok", requestId, sessionId: "s", window: 8 },
    ]) {
      let error: unknown;
      try {
        parseBridgeMessage(JSON.stringify(raw));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("INVALID_MESSAGE");
    }
  }
});

test("error の sessionId/requestId の長さ境界・不正型・欠落を扱う", () => {
  // 境界受理: 1 文字と 128 文字。
  for (const id of ["x", "x".repeat(128)]) {
    for (const field of ["sessionId", "requestId"] as const) {
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
    for (const field of ["sessionId", "requestId"] as const) {
      let error: unknown;
      try {
        parseBridgeMessage(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "error",
            code: "E",
            message: "m",
            [field]: id,
          }),
        );
      } catch (caught) {
        error = caught;
      }
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
    expect(omitted.sessionId).toBeUndefined();
    expect(omitted.requestId).toBeUndefined();
  }
  const undefineded = parseBridgeMessage({
    v: PROTOCOL_VERSION,
    type: "error",
    code: "E",
    message: "m",
    sessionId: undefined,
    requestId: undefined,
  });
  expect(undefineded.type).toBe("error");
  if (undefineded.type === "error") {
    expect(undefineded.sessionId).toBeUndefined();
    expect(undefineded.requestId).toBeUndefined();
  }
});
