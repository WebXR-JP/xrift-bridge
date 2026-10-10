/**
 * 診断セッションの検証。接続開始・応答用 Session は試験用スタブで行う。
 *
 * 実ネットワークの確認は Unit F の範囲とし、ここでは相関・待機・終了時の
 * 結果不明・表示・後片付けの論理を検証する。スタブの応答挙動はサーバ側の
 * 診断ハンドラの厳密形状（echo は `{ op, id, value }` の3キー、ping は
 * `{ op, id }` の2キー、応答は同 `id` 付き）に合わせる。
 */
import { afterEach, expect, test } from "vite-plus/test";
import {
  WorldClientError,
  type ConnectionRequest,
  type ConnectOptions,
  type PairingInfo,
  type Session,
  type SessionDirection,
  type SessionEnd,
  type SessionKind,
  type SessionProvider,
} from "world-client";
import {
  DIAGNOSTIC_CONNECT_TIMEOUT_MS,
  DIAGNOSTIC_PROBE_TIMEOUT_MS,
  DiagnosticSession,
  errorHint,
  type DiagnosticEnv,
  type DiagnosticSnapshot,
} from "../src/diagnostic/session.ts";
import { formatPairingCode } from "../src/diagnostic/display.ts";
import type { DiagnosticBuildInfo } from "../src/build-info.ts";

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

const PAIRING: PairingInfo = {
  requestId: "pair-1",
  code: "123456",
  expiresAt: 9_999_999_999_999,
  expiresInMs: 120_000,
};

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
});

/** 受信値が対象の記録値か判定する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 試験用の Session。送受信・終端を手で操作する。
 *
 * 応答は `respond` へ委ね、診断ハンドラ相当の折り返し・無応答・改ざんを
 * 切り替える。送出と応答は別報告とし、送信完了だけでは応答にしない。
 */
class FakeSession implements Session {
  readonly sessionId: string;
  readonly kind: SessionKind;
  readonly direction: SessionDirection;
  private alive = true;
  readonly sent: unknown[] = [];
  respond: ((payload: unknown) => void) | null = null;
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();

  constructor(sessionId: string, kind: SessionKind, direction: SessionDirection) {
    this.sessionId = sessionId;
    this.kind = kind;
    this.direction = direction;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async sendReliable(value: unknown): Promise<void> {
    if (!this.alive) throw new Error("終端した Session には送れない。");
    this.sent.push(value);
    const respond = this.respond;
    if (respond !== null) {
      // ADR: 応答は送出の解決とは別の報告で行う。送信完了だけでは
      // 診断の一致・pong にしないことを検証できるよう分離する。
      setTimeout(() => {
        if (this.alive) respond(value);
      }, 0);
    }
  }

  sendLatest(value: unknown): void {
    if (!this.alive) throw new Error("終端した Session には送れない。");
    this.sent.push(value);
  }

  onMessage(handler: (payload: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onRemoteEnd(handler: () => void): () => void {
    this.remoteEndHandlers.add(handler);
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  onEnd(handler: (end: SessionEnd) => void): () => void {
    this.endHandlers.add(handler);
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  async closeWrite(): Promise<void> {
    if (!this.alive) throw new Error("終端した Session は終えられない。");
  }

  abort(): void {
    if (!this.alive) return;
    this.alive = false;
    this.fireEnd({ kind: "aborted" });
  }

  /** 相手 FIN を起こす。未完了要求は結果不明になる。 */
  fireRemoteEnd(): void {
    for (const handler of this.remoteEndHandlers) {
      try {
        handler();
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  /** 接続終了に伴う終端を起こす。 */
  fireConnectionClosed(): void {
    if (!this.alive) return;
    this.alive = false;
    this.fireEnd({ kind: "connection-closed" });
  }

  /** 受信 payload を流す。 */
  deliver(payload: unknown): void {
    if (!this.alive) return;
    for (const handler of this.messageHandlers) {
      try {
        handler(payload);
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  private fireEnd(end: SessionEnd): void {
    for (const handler of this.endHandlers) {
      try {
        handler(end);
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }
}

/** スタブ応答の振る舞い。 */
type StubBehavior = "echo-pong" | "silent" | "tamper-echo";

/**
 * 試験用の管理口。`tryCreateSession` で応答用 Session を開く。
 *
 * 診断ハンドラ相当の折り返し（echo・pong）・無応答・応答改ざんを
 * `behavior` で切り替える。形状外は当該 Session のみ中断する。
 */
class FakeProvider implements SessionProvider {
  readonly connectionId = "conn-test";
  private alive = true;
  readonly sessions = new Map<string, FakeSession>();
  private readonly closedHandlers = new Set<(cause: Error) => void>();
  behavior: StubBehavior = "echo-pong";

  get isAlive(): boolean {
    return this.alive;
  }

  async tryCreateSession(options: {
    sessionId: string;
    kind: SessionKind;
    direction: SessionDirection;
  }): Promise<Session> {
    if (!this.alive) {
      throw new WorldClientError("CONNECTION_CLOSED", "終端した接続では Session を開けない。");
    }
    if (this.sessions.has(options.sessionId)) {
      throw new WorldClientError("DUPLICATE_SESSION", "同名の Session がある。");
    }
    const session = new FakeSession(options.sessionId, options.kind, options.direction);
    session.respond = (payload) => {
      this.respond(session, payload);
    };
    this.sessions.set(options.sessionId, session);
    return session;
  }

  onSession(): () => void {
    return () => undefined;
  }

  onClosed(handler: (cause: Error) => void): () => void {
    this.closedHandlers.add(handler);
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const session of this.sessions.values()) {
      session.fireConnectionClosed();
    }
    const cause = new WorldClientError("CONNECTION_CLOSED", "利用者が接続を閉じた。");
    for (const handler of this.closedHandlers) {
      try {
        handler(cause);
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  /** 応答用 Session を取り出す。無い場合は失敗する。 */
  probeSession(id: string): FakeSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error(`応答用 Session がない: ${id}`);
    return session;
  }

  private respond(session: FakeSession, payload: unknown): void {
    if (this.behavior === "silent") return;
    if (!isRecord(payload)) {
      session.abort();
      return;
    }
    const keys = Object.keys(payload);
    if (payload["op"] === "echo" && keys.length === 3 && "id" in payload && "value" in payload) {
      const id = payload["id"];
      if (typeof id !== "string" || id.length === 0) {
        session.abort();
        return;
      }
      const value = payload["value"];
      if (this.behavior === "tamper-echo") {
        session.deliver({ op: "echo", id, value: "改ざん" });
        return;
      }
      session.deliver({ op: "echo", id, value });
      return;
    }
    if (payload["op"] === "ping" && keys.length === 2 && "id" in payload) {
      const id = payload["id"];
      if (typeof id !== "string" || id.length === 0) {
        session.abort();
        return;
      }
      session.deliver({ op: "pong", id });
      return;
    }
    session.abort();
  }
}

/** 接続開始スタブの操作口。 */
interface FakeWorld {
  readonly provider: FakeProvider;
  requestCount(): number;
  approve(): void;
  failConnect(code: string, message: string): void;
}

/**
 * 接続開始の差し替え口を作る。比較コードは手続きで解決し、認可は
 * 試験側の `approve()` まで待つ。取消合図では両約束を拒否する。
 */
function createFakeWorld(options?: { autoApprove?: boolean }): {
  createRequest: (requestOptions: ConnectOptions) => ConnectionRequest;
  world: FakeWorld;
} {
  const autoApprove = options?.autoApprove ?? true;
  const provider = new FakeProvider();
  let count = 0;
  let approve: (() => void) | null = null;
  let fail: ((error: WorldClientError) => void) | null = null;
  const cancelled = (): WorldClientError =>
    new WorldClientError("CONNECT_CANCELLED", "接続試行が取り消された。");
  const createRequest = (requestOptions: ConnectOptions): ConnectionRequest => {
    count += 1;
    const signal = requestOptions.signal;
    if (signal !== undefined && signal.aborted) {
      return {
        pairingInfo: Promise.reject(cancelled()),
        sessionProvider: Promise.reject(cancelled()),
      };
    }
    const pairingInfo = new Promise<PairingInfo>((resolve, reject) => {
      if (signal !== undefined && signal.aborted) {
        reject(cancelled());
        return;
      }
      const timer = setTimeout(() => {
        resolve({ ...PAIRING });
      }, 0);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(cancelled());
        },
        { once: true },
      );
    });
    const sessionProvider = new Promise<SessionProvider>((resolve, reject) => {
      approve = () => {
        resolve(provider);
      };
      fail = (error: WorldClientError) => {
        reject(error);
      };
      signal?.addEventListener(
        "abort",
        () => {
          reject(cancelled());
        },
        { once: true },
      );
    });
    if (autoApprove) {
      void pairingInfo.then(
        () => {
          queueMicrotask(() => {
            approve?.();
          });
        },
        () => undefined,
      );
    }
    // 両約束の扱いが必要な呼び出し側のため、参照を保持する。
    void sessionProvider.catch(() => undefined);
    return { pairingInfo, sessionProvider };
  };
  return {
    createRequest,
    world: {
      provider,
      requestCount: () => count,
      approve: () => {
        approve?.();
      },
      failConnect: (code: string, message: string) => {
        fail?.(new WorldClientError(code, message));
      },
    },
  };
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

function createSession(
  createRequest: (requestOptions: ConnectOptions) => ConnectionRequest,
  options?: { probeTimeoutMs?: number },
): DiagnosticSession {
  const session = new DiagnosticSession({
    endpoint: "ws://127.0.0.1:3100/v1",
    env: ENV,
    build: BUILD,
    createRequest,
    ...(options?.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
  });
  sessions.push(session);
  return session;
}

test("生成直後は未接続で、自動接続しない", async () => {
  const { createRequest, world } = createFakeWorld();
  const session = createSession(createRequest);
  expect(session.getSnapshot().phase).toBe("idle");
  expect(session.getSnapshot().connectionState).toBe("disconnected");
  expect(session.getSnapshot().pairing).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(world.requestCount()).toBe(0);
});

test("拒否では失敗し、承認し直しの案内を出す", async () => {
  const { createRequest, world } = createFakeWorld({ autoApprove: false });
  const session = createSession(createRequest);
  const pending = session.connect();
  const failed = pending.catch((error: unknown) => error);
  await waitForPairing(session);
  world.failConnect("PAIRING_REJECTED", "人間が拒否した。");
  await expect(pending).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
  expect(await failed).toMatchObject({ code: "PAIRING_REJECTED" });
  const snapshot = session.getSnapshot();
  expect(snapshot.phase).toBe("ended");
  expect(snapshot.lastError?.code).toBe("PAIRING_REJECTED");
  expect(snapshot.lastError?.hint).toContain("承認");
  expect(snapshot.pairing).toBeNull();
});

test("接続・認証・echo 一致・ping の pong が通る", async () => {
  const { createRequest } = createFakeWorld();
  const session = createSession(createRequest);
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
  const { createRequest, world } = createFakeWorld({ autoApprove: false });
  const session = createSession(createRequest);
  const seen: Array<DiagnosticSnapshot["pairing"]> = [];
  session.subscribe((snapshot) => {
    seen.push(snapshot.pairing);
  });
  const pending = session.connect();
  await waitForPairing(session);
  const pairing = session.getSnapshot().pairing;
  expect(pairing?.code).toBe("123456");
  expect(pairing?.requestId).toBe("pair-1");
  expect(session.getSnapshot().phase).toBe("awaiting_approval");
  expect(session.getSnapshot().connectionState).toBe("awaiting_approval");
  expect(formatPairingCode(pairing?.code ?? "")).toBe("123 456");
  // pairing 通知相当の写し更新を受けている。
  expect(seen.some((entry) => entry?.code === "123456")).toBe(true);
  // 認可前の echo・ping は禁止のままである。
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  // 承認で確定し、表示が消える。
  world.approve();
  await pending;
  expect(session.getSnapshot().phase).toBe("authorized");
  expect(session.getSnapshot().pairing).toBeNull();
});

test("未認証時の echo・ping は禁止する", async () => {
  const { createRequest } = createFakeWorld();
  const session = createSession(createRequest);
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  await expect(session.runPing()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

test("echo は相関応答でのみ一致にし、送信完了だけでは一致にしない", async () => {
  const { createRequest, world } = createFakeWorld();
  const session = createSession(createRequest);
  await session.connect();
  const echoSession = world.provider.probeSession("diag-echo");
  // 送出直後（相関応答の到達前）は実行中であり、一致にしない。
  const first = session.runEcho();
  expect(session.getSnapshot().echo.status).toBe("running");
  expect(await first).toBe(true);
  expect(session.getSnapshot().echo.status).toBe("matched");
  // 2件目も操作番号を進めて一致させる。相関は診断の待機表で行う。
  const second = session.runEcho();
  expect(await second).toBe(true);
  expect(session.getSnapshot().echo.opNo).toBe(2);
  expect(echoSession.sent).toHaveLength(2);
});

test("echo の応答改ざんは不一致にする", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "tamper-echo";
  const session = createSession(createRequest);
  await session.connect();
  expect(await session.runEcho()).toBe(false);
  expect(session.getSnapshot().echo.status).toBe("mismatched");
});

test("ping は pong 到達でのみ成功し、送信完了だけでは成功にしない", async () => {
  const { createRequest, world } = createFakeWorld();
  const session = createSession(createRequest);
  await session.connect();
  const pingSession = world.provider.probeSession("diag-ping");
  const probed = session.runPing();
  expect(session.getSnapshot().ping.status).toBe("running");
  expect(await probed).toBe(true);
  expect(session.getSnapshot().ping.status).toBe("pong");
  expect(session.getSnapshot().ping.opNo).toBe(1);
  // wire には業務 requestId を載せず、診断 payload 内の明示 id で送る。
  expect(pingSession.sent).toHaveLength(1);
  const sent = pingSession.sent[0];
  expect(isRecord(sent) ? sent["op"] : undefined).toBe("ping");
  expect(isRecord(sent) ? typeof sent["id"] : undefined).toBe("string");
});

test("複数のping待機は到着順ではなくidで対応付ける", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest);
  await session.connect();
  const pingSession = world.provider.probeSession("diag-ping");
  const first = session.runPing();
  const second = session.runPing();
  await waitFor(() => pingSession.sent.length === 2);
  const firstSent = pingSession.sent[0];
  const secondSent = pingSession.sent[1];
  expect(isRecord(firstSent) ? typeof firstSent["id"] : undefined).toBe("string");
  expect(isRecord(secondSent) ? typeof secondSent["id"] : undefined).toBe("string");
  const firstId = isRecord(firstSent) ? firstSent["id"] : undefined;
  const secondId = isRecord(secondSent) ? secondSent["id"] : undefined;
  expect(firstId).not.toBe(secondId);
  // 逆順で応答しても、各要求は自分の id の応答でのみ解決する。
  pingSession.deliver({ op: "pong", id: secondId });
  await expect(second).resolves.toBe(true);
  const raced = await Promise.race([
    first.then(
      () => "first",
      () => "first",
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 20)),
  ]);
  expect(raced).toBe("timeout");
  pingSession.deliver({ op: "pong", id: firstId });
  await expect(first).resolves.toBe(true);
});

test("時限切れのpingへの遅延pongは未知idとして無視する", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest, { probeTimeoutMs: 30 });
  await session.connect();
  const pingSession = world.provider.probeSession("diag-ping");
  await expect(session.runPing()).rejects.toMatchObject({ code: "PROBE_TIMEOUT" });
  expect(session.getSnapshot().ping.status).toBe("failed");
  const stale = pingSession.sent[0];
  expect(isRecord(stale) ? typeof stale["id"] : undefined).toBe("string");
  // 脱落した id への遅延応答は無視し、失敗表示を壊さない。
  pingSession.deliver({ op: "pong", id: isRecord(stale) ? stale["id"] : undefined });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(session.getSnapshot().ping.status).toBe("failed");
  // 次の ping は自分の id で解決する（遅延 pong の誤対応が無い）。
  world.provider.behavior = "echo-pong";
  await expect(session.runPing()).resolves.toBe(true);
  expect(session.getSnapshot().ping.status).toBe("pong");
  expect(session.getSnapshot().ping.opNo).toBe(2);
});

test("時限切れのechoへの遅延応答は未知idとして無視する", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest, { probeTimeoutMs: 30 });
  await session.connect();
  const echoSession = world.provider.probeSession("diag-echo");
  await expect(session.runEcho()).rejects.toMatchObject({ code: "PROBE_TIMEOUT" });
  expect(session.getSnapshot().echo.status).toBe("failed");
  const stale = echoSession.sent[0];
  expect(isRecord(stale) ? typeof stale["id"] : undefined).toBe("string");
  // 脱落した id への遅延応答は無視し、失敗表示を壊さない。
  echoSession.deliver({
    op: "echo",
    id: isRecord(stale) ? stale["id"] : undefined,
    value: isRecord(stale) ? stale["value"] : undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(session.getSnapshot().echo.status).toBe("failed");
  // 次の echo は自分の id で解決する（遅延応答の誤対応が無い）。
  world.provider.behavior = "echo-pong";
  await expect(session.runEcho()).resolves.toBe(true);
  expect(session.getSnapshot().echo.status).toBe("matched");
  expect(session.getSnapshot().echo.opNo).toBe(2);
});

test("証拠 JSON に比較コード・payload を含めない", async () => {
  const { createRequest, world } = createFakeWorld({ autoApprove: false });
  const session = createSession(createRequest);
  const pending = session.connect();
  await waitForPairing(session);
  // 承認待ちの時点でも証拠に比較コード本文を混ぜない。
  const waitingText = JSON.stringify(session.toResultJson());
  expect(waitingText).not.toContain("123456");
  expect(waitingText).not.toContain("123 456");
  expect(session.toResultJson().pairingShown).toBe(true);
  world.approve();
  await pending;
  await session.runEcho();
  await session.runPing();
  const text = JSON.stringify(session.toResultJson());
  expect(text).not.toContain("123456");
  expect(text).not.toContain("123 456");
  expect(text).not.toContain("payload");
  expect(session.toResultJson().connectTimeoutMs).toBe(DIAGNOSTIC_CONNECT_TIMEOUT_MS);
  expect(DIAGNOSTIC_CONNECT_TIMEOUT_MS).toBe(120_000);
  expect(session.toResultJson().probeTimeoutMs).toBe(DIAGNOSTIC_PROBE_TIMEOUT_MS);
});

test("取消で承認待ちの表示が消える", async () => {
  const { createRequest } = createFakeWorld({ autoApprove: false });
  const session = createSession(createRequest);
  const pending = session.connect();
  const failed = pending.catch((error: unknown) => error);
  await waitForPairing(session);
  expect(session.getSnapshot().pairing?.code).toBe("123456");
  session.cancel();
  await expect(pending).rejects.toMatchObject({ code: "CONNECT_CANCELLED" });
  expect(await failed).toMatchObject({ code: "CONNECT_CANCELLED" });
  await waitFor(() => session.getSnapshot().phase === "ended");
  expect(session.getSnapshot().pairing).toBeNull();
});

test("切断後は終了表示になり、再接続には再試行が必要", async () => {
  const { createRequest } = createFakeWorld();
  const session = createSession(createRequest);
  await session.connect();
  session.disconnect();
  await waitFor(() => session.getSnapshot().connectionState === "closed");
  expect(session.getSnapshot().phase).toBe("ended");
  // 切断で認可は失効するため、その後の操作は禁止する。
  await expect(session.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});

test("FIN で未完了要求は結果不明になり、送信完了だけでは成功にしない", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest);
  await session.connect();
  const echo = session.runEcho();
  const ping = session.runPing();
  const echoFailed = echo.catch((error: unknown) => error);
  const pingFailed = ping.catch((error: unknown) => error);
  expect(session.getSnapshot().echo.status).toBe("running");
  expect(session.getSnapshot().ping.status).toBe("running");
  world.provider.probeSession("diag-echo").fireRemoteEnd();
  world.provider.probeSession("diag-ping").fireRemoteEnd();
  await expect(echo).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  await expect(ping).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  expect(await echoFailed).toMatchObject({ code: "RESULT_UNKNOWN" });
  expect(await pingFailed).toMatchObject({ code: "RESULT_UNKNOWN" });
  expect(session.getSnapshot().echo.status).toBe("unknown");
  expect(session.getSnapshot().ping.status).toBe("unknown");
});

test("接続終了で未完了要求は結果不明になる", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest);
  await session.connect();
  const echo = session.runEcho();
  const ping = session.runPing();
  expect(session.getSnapshot().echo.status).toBe("running");
  world.provider.close();
  await expect(echo).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  await expect(ping).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  await waitFor(() => session.getSnapshot().phase === "ended");
  expect(session.getSnapshot().echo.status).toBe("unknown");
  expect(session.getSnapshot().ping.status).toBe("unknown");
});

test("応答待ちの時間切れは失敗になり、結果不明と区別する", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest, { probeTimeoutMs: 30 });
  await session.connect();
  await expect(session.runEcho()).rejects.toMatchObject({ code: "PROBE_TIMEOUT" });
  expect(session.getSnapshot().echo.status).toBe("failed");
  await expect(session.runPing()).rejects.toMatchObject({ code: "PROBE_TIMEOUT" });
  expect(session.getSnapshot().ping.status).toBe("failed");
});

test("dispose で未完了要求を結果不明にし、以降の操作と通知を止める", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.behavior = "silent";
  const session = createSession(createRequest);
  let notified = 0;
  const unsubscribe = session.subscribe(() => {
    notified += 1;
  });
  await session.connect();
  expect(notified).toBeGreaterThan(0);
  unsubscribe();
  const echo = session.runEcho();
  const failed = echo.catch((error: unknown) => error);
  session.dispose();
  await expect(echo).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  expect(await failed).toMatchObject({ code: "RESULT_UNKNOWN" });
  const frozen = notified;
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
  expect(errorHint("PROBE_TIMEOUT")).toContain("応答");
  expect(errorHint("RESULT_UNKNOWN")).toContain("不明");
  expect(errorHint("UNKNOWN_CODE")).toBeUndefined();
});

test("実在する全符号に案内が付く", () => {
  // サーバが実際に送る符号（受付・ペアリング・承認・境界違反）と、
  // 接続試行・診断待機の符号を網羅する。
  // 送らない符号（`PAIRING_LIMIT`・`PAIRING_CODE_UNAVAILABLE`）は含めない。
  // 0.3 で発生し得ない符号（`UNEXPECTED_SEQ`・`CREDIT_EXHAUSTED`・
  // `STREAM_LIMIT`・`QUEUE_FULL`）も含めない。
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
    "UNEXPECTED_DIRECTION",
    "SESSION_MISMATCH",
    "INVALID_JSON",
    "INVALID_MESSAGE",
    "VERSION_MISMATCH",
    "UNKNOWN_TYPE",
    "UNEXPECTED_BINARY",
    "UNEXPECTED_MESSAGE",
    "MUX_FAILURE",
    "PROBE_TIMEOUT",
    "RESULT_UNKNOWN",
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
  // 0.3 で発生し得ない符号の残骸は持たない。
  expect(errorHint("UNEXPECTED_SEQ")).toBeUndefined();
  expect(errorHint("CREDIT_EXHAUSTED")).toBeUndefined();
  expect(errorHint("STREAM_LIMIT")).toBeUndefined();
  expect(errorHint("QUEUE_FULL")).toBeUndefined();
});
