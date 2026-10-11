// @vitest-environment happy-dom
/**
 * テキスト受信の React 結合の検証。生成・購読・破棄の所有を確かめる。
 *
 * 3D盤側だけが生成すること、専用セッションの異常を診断・接続へ波及させないこと、
 * 切断・再接続で本文を消すこと、StrictMode 再実行・実アンマウントで残留しないことを、
 * 接続手順は試験用スタブで行い検証する。開発 DOM パネル側では生成しないため、
 * ここでは3D盤相当の結線だけを扱う。
 */
import { afterEach, expect, test } from "vite-plus/test";
import { StrictMode, useEffect, useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TEXT_SESSION_ID } from "bridge-app-core/text-contract";
import {
  WorldClientError,
  type ConnectionRequest,
  type ConnectOptions,
  type CreateSessionOptions,
  type InboundSession,
  type LatestCreateSessionRequest,
  type LatestSenderSession,
  type OutboundSession,
  type PairingInfo,
  type ReliableCreateSessionRequest,
  type ReliableSession,
  type SessionEnd,
  type SessionProvider,
} from "world-client";
import {
  DiagnosticSession,
  type DiagnosticEnv,
  type DiagnosticSnapshot,
} from "../src/diagnostic/session.ts";
import { useTextReceiver } from "../src/text/useTextReceiver.ts";
import type { TextReceiver } from "../src/text/receiver.ts";
import type { DiagnosticBuildInfo } from "../src/build-info.ts";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const diagnostics: DiagnosticSession[] = [];

/** 受信値が対象の記録値か判定する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 試験用の reliable セッション。送受信・終端を手で操作する。
 *
 * テキスト専用セッションと診断の応答用セッションの双方に使う。
 */
class FakeSession implements ReliableSession {
  readonly sessionId: string;
  readonly kind = "reliable" as const;
  readonly direction = "bidirectional" as const;
  readonly side = "client" as const;
  private alive = true;
  readonly sent: unknown[] = [];
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get receivedCount(): number {
    return 0;
  }

  get staleDroppedCount(): number {
    return 0;
  }

  get missingSeqCount(): number {
    return 0;
  }

  get lastRecvSeq(): number {
    return -1;
  }

  get writeEnded(): boolean {
    return false;
  }

  get peerEnded(): boolean {
    return false;
  }

  async sendReliable(value: unknown): Promise<void> {
    if (!this.alive) throw new Error("終端したセッションには送れない。");
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
    if (!this.alive) throw new Error("終端したセッションは終えられない。");
  }

  abort(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const handler of this.endHandlers) {
      try {
        handler({ kind: "aborted" });
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  /** 相手による終了を起こす。 */
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
    for (const handler of this.endHandlers) {
      try {
        handler({ kind: "connection-closed" });
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  /** 受信ペイロードを流す。 */
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
}

/**
 * 試験用の管理口。診断の応答用セッションとテキスト専用セッションを開く。
 *
 * 終端済みの同名セッションは作り直せる（StrictMode 再実行の付け替え用）。
 * テキスト専用セッションの開設失敗の切替えを持ち、異常の局所化を検証する。
 */
class FakeProvider implements SessionProvider {
  readonly connectionId = "conn-test";
  private alive = true;
  readonly sessions = new Map<string, FakeSession>();
  private readonly closedHandlers = new Set<(cause: Error) => void>();
  closeCount = 0;
  failTextOpen = false;

  get isAlive(): boolean {
    return this.alive;
  }

  async tryCreateSession(options: ReliableCreateSessionRequest): Promise<ReliableSession>;
  async tryCreateSession(
    options: LatestCreateSessionRequest<"client">,
  ): Promise<LatestSenderSession>;
  async tryCreateSession(options: CreateSessionOptions): Promise<OutboundSession>;
  async tryCreateSession(options: CreateSessionOptions): Promise<OutboundSession> {
    if (!this.alive) {
      throw new WorldClientError("CONNECTION_CLOSED", "終端した接続では開けない。");
    }
    if (options.kind !== "reliable" || options.direction !== "bidirectional") {
      throw new WorldClientError("UNEXPECTED_DIRECTION", "想定外の方向の要求である。");
    }
    if (options.sessionId === TEXT_SESSION_ID && this.failTextOpen) {
      throw new WorldClientError("TEXT_OPEN_FAILED", "テキスト専用セッションを開けない。");
    }
    const existing = this.sessions.get(options.sessionId);
    if (existing !== undefined && existing.isAlive) {
      throw new WorldClientError("DUPLICATE_SESSION", "同名のセッションがある。");
    }
    const session = new FakeSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  onSession(_handler: (session: InboundSession) => void): () => void {
    return () => undefined;
  }

  onClosed(handler: (cause: Error) => void): () => void {
    this.closedHandlers.add(handler);
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  close(): void {
    this.closeCount += 1;
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

  /** 開設済みセッションを取り出す。無い場合は失敗する。 */
  textSession(): FakeSession {
    const session = this.sessions.get(TEXT_SESSION_ID);
    if (session === undefined) throw new Error("テキスト専用セッションがない。");
    return session;
  }
}

/** 接続開始スタブの操作口。 */
interface FakeWorld {
  readonly provider: FakeProvider;
}

/**
 * 接続開始の差し替え口を作る。比較コードは手続きで解決し、認可は
 * 自動承認で行う。
 */
function createFakeWorld(): {
  createRequest: (requestOptions: ConnectOptions) => ConnectionRequest;
  world: FakeWorld;
} {
  const provider = new FakeProvider();
  const createRequest = (requestOptions: ConnectOptions): ConnectionRequest => {
    const signal = requestOptions.signal;
    const cancelled = (): WorldClientError =>
      new WorldClientError("CONNECT_CANCELLED", "接続試行が取り消された。");
    if (signal !== undefined && signal.aborted) {
      return {
        pairingInfo: Promise.reject(cancelled()),
        sessionProvider: Promise.reject(cancelled()),
      };
    }
    const pairingInfo = new Promise<PairingInfo>((resolve, reject) => {
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
      const timer = setTimeout(() => {
        resolve(provider);
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
    void sessionProvider.catch(() => undefined);
    return { pairingInfo, sessionProvider };
  };
  return { createRequest, world: { provider } };
}

/** 条件を満たすまで待つ。 */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("待機が時間切れになった。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
const seenReceivers: TextReceiver[] = [];

/** 3D盤相当の結線。診断セッションを受け、テキスト受信だけを所有する。 */
function TextProbe(props: { readonly diagnostic: DiagnosticSession }): React.JSX.Element {
  const [diagSnapshot, setDiagSnapshot] = useState<DiagnosticSnapshot>(() =>
    props.diagnostic.getSnapshot(),
  );
  useEffect(() => props.diagnostic.subscribe(setDiagSnapshot), [props.diagnostic]);
  const { receiver, snapshot } = useTextReceiver({
    session: props.diagnostic,
    snapshot: diagSnapshot,
  });
  useEffect(() => {
    if (receiver !== null) seenReceivers.push(receiver);
  }, [receiver]);
  return (
    <div
      data-testid="text-board"
      data-status={snapshot?.status ?? "none"}
      data-text={snapshot?.text ?? ""}
    />
  );
}

function mount(diagnostic: DiagnosticSession, strict: boolean): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree = <TextProbe diagnostic={diagnostic} />;
  act(() => {
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

/** 表示板の状態を読む。 */
function boardStatus(): string {
  return container?.querySelector('[data-testid="text-board"]')?.getAttribute("data-status") ?? "";
}

/** 表示板の本文を読む。 */
function boardText(): string {
  return container?.querySelector('[data-testid="text-board"]')?.getAttribute("data-text") ?? "";
}

/** 認可済みの診断セッションを作る。 */
async function createAuthorizedDiagnostic(): Promise<{
  diagnostic: DiagnosticSession;
  world: FakeWorld;
}> {
  const { createRequest, world } = createFakeWorld();
  const diagnostic = new DiagnosticSession({
    endpoint: "ws://127.0.0.1:3100/v1",
    env: ENV,
    build: BUILD,
    createRequest,
  });
  diagnostics.push(diagnostic);
  await diagnostic.connect();
  return { diagnostic, world };
}

/** 破棄済みかを受信購読の可否で判定する。 */
function isReceiverDisposed(receiver: TextReceiver): boolean {
  try {
    const unsubscribe = receiver.subscribe(() => {});
    unsubscribe();
    return false;
  } catch {
    return true;
  }
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  seenReceivers.splice(0);
  for (const diagnostic of diagnostics.splice(0)) {
    diagnostic.dispose();
  }
});

test("認可後にテキスト専用セッションを別名で開く", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  const text = world.provider.textSession();
  expect(text.kind).toBe("reliable");
  expect(text.direction).toBe("bidirectional");
  // echo／ping とは別セッションである。
  expect(world.provider.sessions.has("diag-echo")).toBe(true);
  expect(world.provider.sessions.has("diag-ping")).toBe(true);
  expect(text.sessionId).not.toBe("diag-echo");
  expect(text.sessionId).not.toBe("diag-ping");
  await waitFor(() => boardStatus() === "waiting");
});

test("受信で本文を表示し確認応答を返す", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  const text = world.provider.textSession();
  act(() => {
    text.deliver({ op: "show", id: "t1", text: "表示する本文" });
  });
  await waitFor(() => boardText() === "表示する本文");
  expect(boardStatus()).toBe("received");
  expect(text.sent).toHaveLength(1);
  expect(isRecord(text.sent[0]) ? text.sent[0]["op"] : undefined).toBe("shown");
  expect(isRecord(text.sent[0]) ? text.sent[0]["id"] : undefined).toBe("t1");
  // 診断セッションは認可のままである。
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("不正な表示要求で診断も接続も維持する", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  const text = world.provider.textSession();
  act(() => {
    text.deliver({ op: "show", id: "", text: "識別子なし" });
    text.deliver({ op: "show", id: "t1", text: "" });
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(boardStatus()).toBe("waiting");
  expect(text.sent).toHaveLength(0);
  expect(text.isAlive).toBe(true);
  expect(world.provider.isAlive).toBe(true);
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("テキストセッションの異常終了で診断も接続も閉じない", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  const text = world.provider.textSession();
  const echo = world.provider.sessions.get("diag-echo");
  act(() => {
    text.deliver({ op: "show", id: "t1", text: "残す本文" });
  });
  await waitFor(() => boardText() === "残す本文");
  act(() => {
    text.fireRemoteEnd();
  });
  await waitFor(() => boardStatus() === "ended");
  // 直近本文は残し、診断・接続・他セッションは維持する。
  expect(boardText()).toBe("残す本文");
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
  expect(world.provider.isAlive).toBe(true);
  expect(world.provider.closeCount).toBe(0);
  expect(echo?.isAlive).toBe(true);
});

test("切断で本文を消す", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  act(() => {
    world.provider.textSession().deliver({ op: "show", id: "t1", text: "消える本文" });
  });
  await waitFor(() => boardText() === "消える本文");
  act(() => {
    diagnostic.disconnect();
  });
  await waitFor(() => boardStatus() === "none");
  expect(boardText()).toBe("");
});

test("再接続相当の新規セッションでは本文を引き継がない", async () => {
  const first = await createAuthorizedDiagnostic();
  mount(first.diagnostic, false);
  await waitFor(() => first.world.provider.sessions.has(TEXT_SESSION_ID));
  act(() => {
    first.world.provider.textSession().deliver({ op: "show", id: "t1", text: "旧接続の本文" });
  });
  await waitFor(() => boardText() === "旧接続の本文");
  act(() => {
    root?.unmount();
  });
  root = null;
  const second = await createAuthorizedDiagnostic();
  mount(second.diagnostic, false);
  // 新規セッションの表示板に旧本文は載らない。
  expect(boardStatus()).toBe("none");
  expect(boardText()).toBe("");
  await waitFor(() => second.world.provider.sessions.has(TEXT_SESSION_ID));
  await waitFor(() => boardStatus() === "waiting");
});

test("StrictMode の再実行では旧個体を破棄し同名重複を起こさない", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, true);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  await waitFor(() => boardStatus() === "waiting");
  expect(seenReceivers.length).toBeGreaterThanOrEqual(1);
  const latest = seenReceivers[seenReceivers.length - 1];
  expect(isReceiverDisposed(latest)).toBe(false);
  for (const older of seenReceivers.slice(0, -1)) {
    expect(isReceiverDisposed(older)).toBe(true);
  }
  // 最新個体だけが受信できる。
  act(() => {
    world.provider.textSession().deliver({ op: "show", id: "t1", text: "再生成後の本文" });
  });
  await waitFor(() => boardText() === "再生成後の本文");
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("アンマウントで専用セッションだけを中断し接続は維持する", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(TEXT_SESSION_ID));
  const text = world.provider.textSession();
  const latest = (): TextReceiver | undefined => seenReceivers[seenReceivers.length - 1];
  await waitFor(() => latest() !== undefined);
  act(() => {
    root?.unmount();
  });
  root = null;
  expect(text.isAlive).toBe(false);
  expect(latest() !== undefined && isReceiverDisposed(latest()!)).toBe(true);
  // Connection や診断セッションは閉じない。
  expect(world.provider.isAlive).toBe(true);
  expect(world.provider.closeCount).toBe(0);
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("専用セッションの開設失敗で診断も接続も閉じない", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.failTextOpen = true;
  const diagnostic = new DiagnosticSession({
    endpoint: "ws://127.0.0.1:3100/v1",
    env: ENV,
    build: BUILD,
    createRequest,
  });
  diagnostics.push(diagnostic);
  await diagnostic.connect();
  mount(diagnostic, false);
  await waitFor(() => boardStatus() === "ended");
  expect(boardText()).toBe("");
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
  expect(world.provider.isAlive).toBe(true);
  expect(world.provider.closeCount).toBe(0);
});
