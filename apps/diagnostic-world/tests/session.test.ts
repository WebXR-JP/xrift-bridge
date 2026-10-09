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
  type DiagnosticSnapshot,
} from "../src/diagnostic/session.ts";
import { formatPairingCode } from "../src/diagnostic/display.ts";
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

const PAIRING_CODE = "123456";
const PAIRING_REQUEST_ID = "pair-1";

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

interface PairingStub {
  readonly port: number;
  connectionCount(): number;
  approve(): void;
  sendError(code: string, message: string): void;
}

/**
 * 比較コード発行・承認に応答する試験用サーバを起動する。
 *
 * `pairing_start` に `pairing_pending` を返し、自動承認ありでは直後に
 * `auth_ok` を送る。手動承認では試験側の `approve()` まで承認待ちに留める。
 */
function startPairingStub(options?: {
  autoApprove?: boolean;
  code?: string;
  requestId?: string;
  sessionId?: string;
}): Promise<PairingStub> {
  const autoApprove = options?.autoApprove ?? true;
  const code = options?.code ?? PAIRING_CODE;
  const requestId = options?.requestId ?? PAIRING_REQUEST_ID;
  const sessionId = options?.sessionId ?? "session-stub";
  let count = 0;
  let active: WebSocket | null = null;
  let approved = false;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    count += 1;
    active = socket;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (!approved) {
        if (message.type === "pairing_start") {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "pairing_pending",
              requestId,
              code,
              expiresAt: 9_999_999_999_999,
              expiresInMs: 120_000,
            }),
          );
          if (autoApprove) {
            setImmediate(() => {
              try {
                socket.send(
                  JSON.stringify({
                    v: PROTOCOL_VERSION,
                    type: "auth_ok",
                    requestId,
                    sessionId,
                    window: 16,
                  }),
                );
                approved = true;
              } catch {
                // 閉塞後の送出失敗は無視する。
              }
            });
          }
          return;
        }
        return;
      }
      if (message.type === "echo") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId,
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
            sessionId,
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
      resolve({
        port: address.port,
        connectionCount: () => count,
        approve: () => {
          if (active === null) throw new Error("接続前に承認はできない。");
          approved = true;
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "auth_ok",
              requestId,
              sessionId,
              window: 16,
            }),
          );
        },
        sendError: (errorCode: string, message: string) => {
          if (active === null) throw new Error("接続前に失敗通知はできない。");
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "error",
              code: errorCode,
              message,
              requestId,
            }),
          );
        },
      });
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

/** 比較コードの表示を写しで待つ。 */
async function waitForPairing(session: DiagnosticSession, timeoutMs = 2000): Promise<void> {
  await waitFor(() => session.getSnapshot().pairing !== null, timeoutMs);
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
  const stub = await startPairingStub();
  const session = createSession(stub.port);
  expect(session.getSnapshot().phase).toBe("idle");
  expect(session.getSnapshot().connectionState).toBe("disconnected");
  expect(session.getSnapshot().pairing).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(stub.connectionCount()).toBe(0);
});

test("拒否では失敗し、承認し直しの案内を出す", async () => {
  const stub = await startPairingStub({ autoApprove: false });
  const session = createSession(stub.port);
  const pending = session.connect();
  await waitForPairing(session);
  stub.sendError("PAIRING_REJECTED", "人間が拒否した。");
  await expect(pending).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
  const snapshot = session.getSnapshot();
  expect(snapshot.phase).toBe("ended");
  expect(snapshot.lastError?.code).toBe("PAIRING_REJECTED");
  expect(snapshot.lastError?.hint).toContain("承認");
  expect(snapshot.pairing).toBeNull();
});

test("接続・認証・echo 一致・ping の pong が通る", async () => {
  const stub = await startPairingStub();
  const session = createSession(stub.port);
  await session.connect();
  expect(session.getSnapshot().phase).toBe("authorized");
  expect(session.getSnapshot().connectionState).toBe("authorized");
  expect(session.getSnapshot().pairing).toBeNull();
  expect(await session.runEcho()).toBe(true);
  expect(session.getSnapshot().echo.status).toBe("matched");
  expect(await session.runPing()).toBe(true);
  expect(session.getSnapshot().ping.status).toBe("pong");
});

test("比較コードが写し・イベント・承認待ちに反映される", async () => {
  const stub = await startPairingStub({ autoApprove: false });
  const session = createSession(stub.port);
  const seen: Array<DiagnosticSnapshot["pairing"]> = [];
  session.subscribe((snapshot) => {
    seen.push(snapshot.pairing);
  });
  const pending = session.connect();
  await waitForPairing(session);
  const pairing = session.getSnapshot().pairing;
  expect(pairing?.code).toBe(PAIRING_CODE);
  expect(pairing?.requestId).toBe(PAIRING_REQUEST_ID);
  expect(session.getSnapshot().phase).toBe("awaiting_approval");
  expect(session.getSnapshot().connectionState).toBe("awaiting_approval");
  expect(formatPairingCode(pairing?.code ?? "")).toBe("123 456");
  // pairing イベント相当の写し更新を受けている。
  expect(seen.some((entry) => entry?.code === PAIRING_CODE)).toBe(true);
  // 認可前の echo・ping は禁止のままである。
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  // 承認で確定し、表示が消える。
  stub.approve();
  await pending;
  expect(session.getSnapshot().phase).toBe("authorized");
  expect(session.getSnapshot().pairing).toBeNull();
});

test("未認証時の echo・ping は禁止する", async () => {
  const stub = await startPairingStub();
  const session = createSession(stub.port);
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  await expect(session.runPing()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

test("証拠 JSON に比較コード・payload を含めない", async () => {
  const stub = await startPairingStub({ autoApprove: false });
  const session = createSession(stub.port);
  const pending = session.connect();
  await waitForPairing(session);
  // 承認待ちの時点でも証拠に比較コード本文を混ぜない。
  const waitingText = JSON.stringify(session.toResultJson());
  expect(waitingText).not.toContain(PAIRING_CODE);
  expect(waitingText).not.toContain("123 456");
  expect(session.toResultJson().pairingShown).toBe(true);
  stub.approve();
  await pending;
  await session.runEcho();
  await session.runPing();
  const text = JSON.stringify(session.toResultJson());
  expect(text).not.toContain(PAIRING_CODE);
  expect(text).not.toContain("123 456");
  expect(text).not.toContain("payload");
  expect(session.toResultJson().connectTimeoutMs).toBe(DIAGNOSTIC_CONNECT_TIMEOUT_MS);
  expect(DIAGNOSTIC_CONNECT_TIMEOUT_MS).toBe(120_000);
});

test("取消で承認待ちの表示が消える", async () => {
  const stub = await startPairingStub({ autoApprove: false });
  const session = createSession(stub.port);
  const pending = session.connect();
  await waitForPairing(session);
  expect(session.getSnapshot().pairing?.code).toBe(PAIRING_CODE);
  session.cancel();
  await expect(pending).rejects.toThrow();
  await waitFor(() => session.getSnapshot().phase === "ended");
  expect(session.getSnapshot().pairing).toBeNull();
});

test("切断後は終了表示になり、再接続には再試行が必要", async () => {
  const stub = await startPairingStub();
  const session = createSession(stub.port);
  await session.connect();
  session.disconnect();
  await waitFor(() => session.getSnapshot().connectionState === "closed");
  expect(session.getSnapshot().phase).toBe("ended");
  // 切断で認可は失効するため、その後の操作は禁止する。
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

test("dispose で購読を終え、以降の操作と通知を止める", async () => {
  const stub = await startPairingStub();
  const session = createSession(stub.port);
  let notified = 0;
  const unsubscribe = session.subscribe(() => {
    notified += 1;
  });
  await session.connect();
  expect(notified).toBeGreaterThan(0);
  unsubscribe();
  const frozen = notified;
  session.dispose();
  await expect(session.connect()).rejects.toMatchObject({ code: "DISPOSED" });
  expect(notified).toBe(frozen);
});

test("エラー符号に対応する案内を返す", () => {
  expect(errorHint("PAIRING_REJECTED")).toContain("承認");
  expect(errorHint("PAIRING_EXPIRED")).toContain("期限");
  expect(errorHint("APPROVAL_RESPONSE_TIMEOUT")).toContain("承認応答");
  expect(errorHint("CONNECT_CANCELLED")).toContain("取り消");
  expect(errorHint("CONNECT_TIMEOUT")).toContain("120秒");
  expect(errorHint("CONNECTION_CLOSED")).toContain("新規");
  expect(errorHint("NOT_AUTHORIZED")).toContain("認証");
  expect(errorHint("UNKNOWN_CODE")).toBeUndefined();
});

test("実在する全符号に案内が付く", () => {
  // サーバが実際に送る符号（`apps/bridge/src/server.ts` の error 終端・応答と
  // verify 拒否・レート拒否・承認失敗）と、接続試行の符号を網羅する。
  // 送らない符号（`PAIRING_LIMIT`・`PAIRING_CODE_UNAVAILABLE`）は含めない。
  const realCodes = [
    "PAIRING_REJECTED",
    "PAIRING_EXPIRED",
    "ACCEPTANCE_CLOSED",
    "PENDING_FULL",
    "CODE_GENERATION_FAILED",
    "PAIRING_START_TIMEOUT",
    "DUPLICATE_PAIRING_START",
    "APPROVAL_RESPONSE_TIMEOUT",
    "CONNECT_TIMEOUT",
    "CONNECT_CANCELLED",
    "CONNECTION_CLOSED",
    "ORIGIN_RATE_LIMITED",
    "TOTAL_RATE_LIMITED",
    "TOO_MANY_CONNECTIONS",
    "TOO_MANY_UNAUTHORIZED",
    "NOT_PENDING",
    "INVALID_CODE",
    "CODE_MISMATCH",
    "CONNECTION_GONE",
    "CONNECTION_CHECK_ERROR",
    "NOT_AUTHORIZED",
    "NOT_CONNECTED",
    "UNEXPECTED_SEQ",
    "UNEXPECTED_DIRECTION",
    "SESSION_MISMATCH",
    "CREDIT_EXHAUSTED",
    "STREAM_LIMIT",
    "QUEUE_FULL",
    "INVALID_JSON",
    "INVALID_MESSAGE",
    "VERSION_MISMATCH",
    "UNKNOWN_TYPE",
  ];
  for (const code of realCodes) {
    expect(errorHint(code), code).toBeDefined();
  }
  // 切断コードの派生形は汎用の案内に落ちる。
  expect(errorHint("CLOSED_1008")).toBeDefined();
  // 未知符号には案内を付けない。
  expect(errorHint("UNKNOWN_CODE")).toBeUndefined();
  // 送らない符号には案内を持たない（死に分岐の混入検出）。
  expect(errorHint("PAIRING_LIMIT")).toBeUndefined();
  expect(errorHint("PAIRING_CODE_UNAVAILABLE")).toBeUndefined();
});
