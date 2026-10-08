/**
 * 診断セッションの検証。試験用スタブと実 `world-client` で行う。
 *
 * ブラウザ実機の確認（LNA・混合コンテンツ・審査）は範囲外とし、
 * ここでは手順・表示・後片付けの論理を検証する。
 */
import { afterEach, expect, test } from "vite-plus/test";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseBridgeMessage } from "bridge-protocol";
import {
  DIAGNOSTIC_CONNECT_TIMEOUT_MS,
  DiagnosticSession,
  errorHint,
  type DiagnosticEnv,
} from "../src/diagnostic/session.ts";
import type { DiagnosticBuildInfo } from "../src/build-info.ts";

const servers: WebSocketServer[] = [];
const sessions: DiagnosticSession[] = [];

const ENV: DiagnosticEnv = {
  origin: "http://localhost:5173",
  secureContext: false,
  topLevel: true,
};

const BUILD: DiagnosticBuildInfo = {
  version: "0.0.0-test",
  commit: "test",
  builtAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** 受信値をテキスト化する。 */
function rawToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data).toString("utf-8");
}

interface Stub {
  readonly port: number;
  connectionCount(): number;
}

/** 認証・echo・ping に応答する試験用サーバを起動する。 */
function startStub(validSecret: string): Promise<Stub> {
  let count = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    count += 1;
    let authorized: string | null = null;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (authorized === null) {
        if (message.type === "auth" && message.secret === validSecret) {
          authorized = "session-stub";
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "auth_ok",
              sessionId: authorized,
              window: 16,
            }),
          );
        } else {
          // 認証失敗は接続試行の失敗として返す（bridge の UNAUTHORIZED 相当）。
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "error",
              code: "UNAUTHORIZED",
              message: "未知の秘密値である。",
            }),
          );
          socket.close(1008, "unauthorized");
        }
        return;
      }
      if (message.type === "echo") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId: authorized,
            streamId: message.streamId,
            kind: "reliable",
            seq: message.seq,
            requestId: message.requestId,
            payload: message.payload,
          }),
        );
      } else if (message.type === "command_request") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "command_response",
            sessionId: authorized,
            requestId: message.requestId,
            ok: message.command === "ping",
            ...(message.command === "ping"
              ? { result: "pong" }
              : { error: { code: "UNKNOWN_COMMAND", message: "unknown" } }),
          }),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({ port: address.port, connectionCount: () => count });
    });
  });
}

/** 条件を満たすまで待つ。 */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("待機が時間切れになった。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createSession(port: number): DiagnosticSession {
  const session = new DiagnosticSession({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    env: ENV,
    build: BUILD,
  });
  sessions.push(session);
  return session;
}

test("生成直後は未接続で、自動接続しない", async () => {
  const stub = await startStub("secret-1");
  const session = createSession(stub.port);
  expect(session.getSnapshot().phase).toBe("idle");
  expect(session.getSnapshot().connectionState).toBe("disconnected");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(stub.connectionCount()).toBe(0);
});

test("誤秘密値では失敗し、新規ペアリングの案内を出す", async () => {
  const stub = await startStub("correct");
  const session = createSession(stub.port);
  await expect(session.connect("wrong")).rejects.toThrow();
  const snapshot = session.getSnapshot();
  expect(snapshot.phase).toBe("ended");
  expect(snapshot.lastError?.code).toBe("UNAUTHORIZED");
  expect(snapshot.lastError?.hint).toContain("pair");
});

test("接続・認証・echo 一致・ping の pong が通る", async () => {
  const stub = await startStub("correct");
  const session = createSession(stub.port);
  await session.connect("correct");
  expect(session.getSnapshot().phase).toBe("authorized");
  expect(session.getSnapshot().connectionState).toBe("authorized");
  expect(await session.runEcho()).toBe(true);
  expect(session.getSnapshot().echo.status).toBe("matched");
  expect(await session.runPing()).toBe(true);
  expect(session.getSnapshot().ping.status).toBe("pong");
});

test("未認証時の echo・ping は禁止する", async () => {
  const stub = await startStub("correct");
  const session = createSession(stub.port);
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  await expect(session.runPing()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

test("証拠 JSON に秘密値・payload を含めない", async () => {
  const stub = await startStub("s3cr3t-value");
  const session = createSession(stub.port);
  await session.connect("s3cr3t-value");
  await session.runEcho();
  await session.runPing();
  const text = JSON.stringify(session.toResultJson());
  expect(text).not.toContain("s3cr3t-value");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("payload");
  expect(session.toResultJson().connectTimeoutMs).toBe(DIAGNOSTIC_CONNECT_TIMEOUT_MS);
  expect(DIAGNOSTIC_CONNECT_TIMEOUT_MS).toBe(120_000);
});

test("切断後は終了表示になり、再接続には再試行が必要", async () => {
  const stub = await startStub("correct");
  const session = createSession(stub.port);
  await session.connect("correct");
  session.disconnect();
  await waitFor(() => session.getSnapshot().connectionState === "closed");
  expect(session.getSnapshot().phase).toBe("ended");
  // 切断で認可は失効するため、その後の操作は禁止する。
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

test("dispose で購読を終え、以降の操作と通知を止める", async () => {
  const stub = await startStub("correct");
  const session = createSession(stub.port);
  let notified = 0;
  const unsubscribe = session.subscribe(() => {
    notified += 1;
  });
  await session.connect("correct");
  expect(notified).toBeGreaterThan(0);
  unsubscribe();
  const frozen = notified;
  session.dispose();
  await expect(session.connect("correct")).rejects.toMatchObject({ code: "DISPOSED" });
  expect(notified).toBe(frozen);
});

test("エラー符号に対応する案内を返す", () => {
  expect(errorHint("UNAUTHORIZED")).toContain("pair");
  expect(errorHint("CONNECT_TIMEOUT")).toContain("120秒");
  expect(errorHint("CONNECTION_CLOSED")).toContain("再ペアリング");
  expect(errorHint("NOT_AUTHORIZED")).toContain("認証");
  expect(errorHint("UNKNOWN_CODE")).toBeUndefined();
});
