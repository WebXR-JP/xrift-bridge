// @vitest-environment happy-dom
/**
 * UDP受信の React 結合の検証。生成・購読・破棄の所有を確かめる。
 *
 * 3D盤側だけが生成すること、専用セッションの異常を診断・接続へ波及させないこと、
 * 切断・再接続で直近を消すこと、表示更新の間引きでも統計が欠けないこと、
 * StrictMode 再実行・実アンマウントで残留しないことを、接続手順は試験用スタブで
 * 行い検証する。開発 DOM パネル側では生成しないため、ここでは3D盤相当の結線だけを扱う。
 * 試験データは固定値とし、実利用の payload は残さない。
 */
import { afterEach, expect, test } from "vite-plus/test";
import { StrictMode, useEffect, useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UDP_SESSION_ID, encodeUdpData } from "bridge-plugin-udp/contract";
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
import { useUdpReceiver } from "../src/udp/useUdpReceiver.ts";
import type { UdpReceiver } from "../src/udp/receiver.ts";
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
};

const diagnostics: DiagnosticSession[] = [];

/** 固定の試験バイト列。実利用の payload ではない。 */
const FIXED_BYTES = new Uint8Array([0x01, 0x02, 0xab, 0xff]);

/** 固定の試験転送を作る。 */
function datagram(data: Uint8Array): Record<string, unknown> {
  return {
    op: "datagram",
    dataBase64: encodeUdpData(data),
    source: { address: "127.0.0.1", port: 5123 },
  };
}

/**
 * 試験用の reliable セッション。送受信・終端を手で操作する。
 *
 * UDP専用セッションと診断の応答用セッションの双方に使う。
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
 * 試験用の管理口。診断の応答用セッションとUDP専用セッションを開く。
 *
 * 終端済みの同名セッションは作り直せる（StrictMode 再実行の付け替え用）。
 * UDP専用セッションの開設失敗の切替えを持ち、異常の局所化を検証する。
 */
class FakeProvider implements SessionProvider {
  readonly connectionId = "conn-test";
  private alive = true;
  readonly sessions = new Map<string, FakeSession>();
  private readonly closedHandlers = new Set<(cause: Error) => void>();
  closeCount = 0;
  failUdpOpen = false;

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
    if (options.sessionId === UDP_SESSION_ID && this.failUdpOpen) {
      throw new WorldClientError("UDP_OPEN_FAILED", "UDP専用セッションを開けない。");
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
  udpSession(): FakeSession {
    const session = this.sessions.get(UDP_SESSION_ID);
    if (session === undefined) throw new Error("UDP専用セッションがない。");
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
const seenReceivers: UdpReceiver[] = [];
let renderCount = 0;

/** 3D盤相当の結線。診断セッションを受け、UDP受信だけを所有する。 */
function UdpProbe(props: { readonly diagnostic: DiagnosticSession }): React.JSX.Element {
  const [diagSnapshot, setDiagSnapshot] = useState<DiagnosticSnapshot>(() =>
    props.diagnostic.getSnapshot(),
  );
  useEffect(() => props.diagnostic.subscribe(setDiagSnapshot), [props.diagnostic]);
  const { receiver, snapshot } = useUdpReceiver({
    session: props.diagnostic,
    snapshot: diagSnapshot,
  });
  useEffect(() => {
    if (receiver !== null) seenReceivers.push(receiver);
  }, [receiver]);
  useEffect(() => {
    renderCount += 1;
  });
  return (
    <div
      data-testid="udp-board"
      data-status={snapshot?.status ?? "none"}
      data-count={snapshot?.receivedCount ?? -1}
      data-invalid={snapshot?.invalidCount ?? -1}
      data-source={
        snapshot?.source === undefined || snapshot.source === null
          ? ""
          : `${snapshot.source.address}:${snapshot.source.port}`
      }
      data-preview={snapshot?.previewHex ?? ""}
    />
  );
}

function mount(diagnostic: DiagnosticSession, strict: boolean): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree = <UdpProbe diagnostic={diagnostic} />;
  act(() => {
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

/** 表示板の状態を読む。 */
function boardStatus(): string {
  return container?.querySelector('[data-testid="udp-board"]')?.getAttribute("data-status") ?? "";
}

/** 表示板の受信件数を読む。 */
function boardCount(): number {
  const raw =
    container?.querySelector('[data-testid="udp-board"]')?.getAttribute("data-count") ?? "-1";
  return Number(raw);
}

/** 表示板の不正件数を読む。 */
function boardInvalid(): number {
  const raw =
    container?.querySelector('[data-testid="udp-board"]')?.getAttribute("data-invalid") ?? "-1";
  return Number(raw);
}

/** 表示板の送信元を読む。 */
function boardSource(): string {
  return container?.querySelector('[data-testid="udp-board"]')?.getAttribute("data-source") ?? "";
}

/** 表示板の先頭プレビューを読む。 */
function boardPreview(): string {
  return container?.querySelector('[data-testid="udp-board"]')?.getAttribute("data-preview") ?? "";
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
function isReceiverDisposed(receiver: UdpReceiver): boolean {
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
  renderCount = 0;
  for (const diagnostic of diagnostics.splice(0)) {
    diagnostic.dispose();
  }
});

test("認可後にUDP専用セッションを別名で開く", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  const udp = world.provider.udpSession();
  expect(udp.kind).toBe("reliable");
  expect(udp.direction).toBe("bidirectional");
  // echo／ping とは別セッションである。
  expect(world.provider.sessions.has("diag-echo")).toBe(true);
  expect(world.provider.sessions.has("diag-ping")).toBe(true);
  expect(udp.sessionId).not.toBe("diag-echo");
  expect(udp.sessionId).not.toBe("diag-ping");
  await waitFor(() => boardStatus() === "waiting");
});

test("受信で統計・送信元・プレビューを表示し逆方向送信しない", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  const udp = world.provider.udpSession();
  act(() => {
    udp.deliver(datagram(FIXED_BYTES));
  });
  await waitFor(() => boardCount() === 1);
  expect(boardStatus()).toBe("received");
  expect(boardSource()).toBe("127.0.0.1:5123");
  expect(boardPreview()).toBe("0102abff");
  expect(udp.sent).toHaveLength(0);
  // 診断セッションは認可のままである。
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("連続受信を間引いても統計は全件計数する", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  const udp = world.provider.udpSession();
  const before = renderCount;
  act(() => {
    for (let index = 0; index < 25; index += 1) {
      udp.deliver(datagram(new Uint8Array([index % 256])));
    }
  });
  await waitFor(() => boardCount() === 25);
  expect(boardStatus()).toBe("received");
  // ADR: 表示更新は最大10Hzに間引くため、描画回数は受信件数を下回る。
  // 統計自体は全受信を計数する（最終写しが累計25件を持つ）。
  expect(renderCount - before).toBeLessThan(25);
});

test("不正な転送で診断も接続も維持する", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  const udp = world.provider.udpSession();
  act(() => {
    udp.deliver({ op: "datagram", dataBase64: "!!!", source: { address: "127.0.0.1", port: 1 } });
    udp.deliver({ op: "echo", id: "e1", value: "v" });
  });
  await waitFor(() => boardInvalid() === 2);
  expect(boardStatus()).toBe("waiting");
  expect(boardCount()).toBe(0);
  expect(udp.sent).toHaveLength(0);
  expect(udp.isAlive).toBe(true);
  expect(world.provider.isAlive).toBe(true);
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("UDPセッションの異常終了で診断も接続も閉じない", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  const udp = world.provider.udpSession();
  const echo = world.provider.sessions.get("diag-echo");
  act(() => {
    udp.deliver(datagram(FIXED_BYTES));
  });
  await waitFor(() => boardCount() === 1);
  act(() => {
    udp.fireRemoteEnd();
  });
  await waitFor(() => boardStatus() === "ended");
  // 直近表示は残し、診断・接続・他セッションは維持する。
  expect(boardPreview()).toBe("0102abff");
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
  expect(world.provider.isAlive).toBe(true);
  expect(world.provider.closeCount).toBe(0);
  expect(echo?.isAlive).toBe(true);
});

test("切断で直近を消す", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  act(() => {
    world.provider.udpSession().deliver(datagram(FIXED_BYTES));
  });
  await waitFor(() => boardCount() === 1);
  act(() => {
    diagnostic.disconnect();
  });
  await waitFor(() => boardStatus() === "none");
  expect(boardCount()).toBe(-1);
  expect(boardSource()).toBe("");
});

test("StrictMode の再実行では旧個体を破棄し同名重複を起こさない", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, true);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  await waitFor(() => boardStatus() === "waiting");
  expect(seenReceivers.length).toBeGreaterThanOrEqual(1);
  const latest = seenReceivers[seenReceivers.length - 1];
  expect(isReceiverDisposed(latest)).toBe(false);
  for (const older of seenReceivers.slice(0, -1)) {
    expect(isReceiverDisposed(older)).toBe(true);
  }
  // 最新個体だけが受信できる。
  act(() => {
    world.provider.udpSession().deliver(datagram(FIXED_BYTES));
  });
  await waitFor(() => boardCount() === 1);
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("アンマウントで専用セッションだけを中断し接続は維持する", async () => {
  const { diagnostic, world } = await createAuthorizedDiagnostic();
  mount(diagnostic, false);
  await waitFor(() => world.provider.sessions.has(UDP_SESSION_ID));
  const udp = world.provider.udpSession();
  const latest = (): UdpReceiver | undefined => seenReceivers[seenReceivers.length - 1];
  await waitFor(() => latest() !== undefined);
  act(() => {
    root?.unmount();
  });
  root = null;
  expect(udp.isAlive).toBe(false);
  expect(latest() !== undefined && isReceiverDisposed(latest()!)).toBe(true);
  // Connection や診断セッションは閉じない。
  expect(world.provider.isAlive).toBe(true);
  expect(world.provider.closeCount).toBe(0);
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
});

test("専用セッションの開設失敗で診断も接続も閉じない", async () => {
  const { createRequest, world } = createFakeWorld();
  world.provider.failUdpOpen = true;
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
  expect(boardCount()).toBe(0);
  expect(diagnostic.getSnapshot().phase).toBe("authorized");
  expect(world.provider.isAlive).toBe(true);
  expect(world.provider.closeCount).toBe(0);
});
