import { expect, test } from "vite-plus/test";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  isJsonValue,
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

test("echo 要求を受理する", () => {
  const message = parseBridgeMessage(JSON.stringify(validEcho()));
  expect(message.type).toBe("echo");
  if (message.type === "echo") {
    expect(message.seq).toBe(0);
    expect(message.payload).toEqual({ text: "hello" });
  }
});

test("認証・応答・コマンド・データ・クレジット・エラー型を受理する", () => {
  const samples: Array<{ raw: unknown; type: BridgeMessage["type"] }> = [
    { raw: { v: PROTOCOL_VERSION, type: "auth", secret: "s" }, type: "auth" },
    {
      raw: { v: PROTOCOL_VERSION, type: "auth_ok", sessionId: "s", window: 8 },
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
  ];
  for (const sample of samples) {
    expect(parseBridgeMessage(JSON.stringify(sample.raw)).type).toBe(sample.type);
  }
});

test("版不一致・未知種別・JSON 異常を拒否する", () => {
  const cases: Array<{ raw: unknown; code: ProtocolError["code"] }> = [
    { raw: { ...validEcho(), v: "9.9.9" }, code: "VERSION_MISMATCH" },
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
    { ...validEcho(), type: "auth", secret: "" },
    { ...validEcho(), type: "data", kind: "sometimes" },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s" },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: -1 },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: 1.5 },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: "4" },
    { v: PROTOCOL_VERSION, type: "credit", sessionId: "s", limit: null },
    42,
    null,
    [],
  ];
  for (const raw of bad) {
    expect(() => parseBridgeMessage(JSON.stringify(raw))).toThrowError(ProtocolError);
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
