/**
 * CLI の診断実行状態の検証。
 *
 * 偽サーバー管理境界に対し、`apps/bridge-cli` の `startDiagnostics` が
 * Session ごとの診断インスタンス生成・割当て、累積統計、Session 終了での
 * 回収、未割当ての扱い、終了処理を行うことを確かめる。`status` 表示の
 * 診断項目の有無は実サーバで確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import type {
  BridgeServer,
  BridgeSessionInfo,
  LocalSessionId,
  ManagementEvent,
  ManagementListener,
  ServerSession,
} from "bridge-server";
import type { SessionEnd } from "bridge-protocol/transport";
import { createBridgeServer, type BridgeServer as RealBridgeServer } from "bridge-server";
import { TEXT_SESSION_ID } from "bridge-app-core";
import { handleCommand } from "../src/index.ts";
import { startDiagnostics, type BridgeDiagnostics } from "../src/diagnostics.ts";

/** 偽の Session（サーバー側・reliable 双方向または latest 受信）。 */
class FakeSession {
  isAlive = true;
  /** `sendReliable` で受けた値の記録。 */
  readonly sent: unknown[] = [];
  /** `abort` で受けた原因の記録。 */
  readonly aborted: Error[] = [];
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();

  constructor(
    readonly sessionId: string,
    readonly kind: "reliable" | "latest",
  ) {}

  get direction(): "bidirectional" | "to_server" {
    return this.kind === "reliable" ? "bidirectional" : "to_server";
  }

  /** 受信 payload を購読する。 */
  onMessage(handler: (payload: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /** 全体終端を購読する。 */
  onEnd(handler: (end: SessionEnd) => void): () => void {
    this.endHandlers.add(handler);
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  /** 相手 FIN を購読する。 */
  onRemoteEnd(handler: () => void): () => void {
    this.remoteEndHandlers.add(handler);
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  /** 確実送信の記録。終了済みなら拒否する。 */
  sendReliable(value: unknown): Promise<void> {
    if (!this.isAlive) return Promise.reject(new Error("偽セッションは終了済みである。"));
    this.sent.push(value);
    return Promise.resolve();
  }

  /** 送信終了の記録。 */
  closeWrite(): Promise<void> {
    if (!this.isAlive) return Promise.reject(new Error("偽セッションは終了済みである。"));
    return Promise.resolve();
  }

  /** 即時中断し、終端購読者へ通知する。 */
  abort(error?: Error): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    const cause = error ?? new Error("偽セッションの中断");
    this.aborted.push(cause);
    this.notifyEnd({ kind: "aborted", error: cause });
  }

  /** 受信データを届ける。 */
  emitMessage(payload: unknown): void {
    if (!this.isAlive) return;
    for (const handler of [...this.messageHandlers]) {
      handler(payload);
    }
  }

  /** 外部要因の終端を通知する。 */
  notifyEnd(end: SessionEnd): void {
    this.isAlive = false;
    for (const handler of [...this.endHandlers]) {
      handler(end);
    }
  }
}

/** 偽のサーバー管理境界。開始は登録確定後に通知し、終了は除外後に一度だけ通知する。 */
class FakeServer {
  private nextSeq = 1;
  private readonly sessions = new Map<
    LocalSessionId,
    { readonly info: BridgeSessionInfo; readonly session: FakeSession }
  >();
  private readonly listeners = new Set<ManagementListener>();

  /** 生存セッションの一覧の写し。 */
  listSessions(): readonly BridgeSessionInfo[] {
    return [...this.sessions.values()].map((record) => record.info);
  }

  /** 生存セッションをローカル識別子で取り出す。 */
  getSession(localSessionId: LocalSessionId): ServerSession | undefined {
    const found = this.sessions.get(localSessionId)?.session;
    return found as unknown as ServerSession | undefined;
  }

  /** 管理通知を受け取る。 */
  onManagementEvent(listener: ManagementListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** `BridgeServer` として渡す。利用するのは管理境界の3口のみである。 */
  asBridgeServer(): BridgeServer {
    return this as unknown as BridgeServer;
  }

  /** reliable セッションを開始する。 */
  startReliable(sessionId: string): {
    readonly info: BridgeSessionInfo;
    readonly session: FakeSession;
  } {
    return this.register(sessionId, "reliable");
  }

  /** latest セッションを開始する。 */
  startLatest(sessionId: string): {
    readonly info: BridgeSessionInfo;
    readonly session: FakeSession;
  } {
    return this.register(sessionId, "latest");
  }

  /** 偽 Session に受信データを届ける。 */
  deliver(localSessionId: LocalSessionId, payload: unknown): void {
    const record = this.sessions.get(localSessionId);
    if (record === undefined) throw new Error("偽サーバーに存在しないセッションである。");
    record.session.emitMessage(payload);
  }

  /** セッションを終了させる。一覧から外してから一度だけ通知する。 */
  end(localSessionId: LocalSessionId, end: SessionEnd = { kind: "closed" }): void {
    const record = this.sessions.get(localSessionId);
    if (record === undefined) throw new Error("偽サーバーに存在しないセッションである。");
    this.sessions.delete(localSessionId);
    record.session.notifyEnd(end);
    this.emit({ kind: "session-ended", session: record.info, end });
  }

  /** 未割当ての公開情報の終了通知を送る（取得できない Session の扱いの試験用）。 */
  notifyEndedUnknown(): void {
    const info: BridgeSessionInfo = {
      localSessionId: "local-存在しない",
      connectionId: "conn-1",
      sessionId: "unknown",
      kind: "reliable",
      direction: "bidirectional",
    };
    this.emit({ kind: "session-ended", session: info, end: { kind: "closed" } });
  }

  private register(
    sessionId: string,
    kind: "reliable" | "latest",
  ): { readonly info: BridgeSessionInfo; readonly session: FakeSession } {
    const localSessionId: LocalSessionId = `local-${this.nextSeq++}`;
    const session = new FakeSession(sessionId, kind);
    const info: BridgeSessionInfo =
      kind === "reliable"
        ? { localSessionId, connectionId: "conn-1", sessionId, kind, direction: "bidirectional" }
        : { localSessionId, connectionId: "conn-1", sessionId, kind, direction: "to_server" };
    this.sessions.set(localSessionId, { info, session });
    this.emit({ kind: "session-started", session: info });
    return { info, session };
  }

  private emit(event: ManagementEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

const diagnosticsList: BridgeDiagnostics[] = [];
const servers: RealBridgeServer[] = [];

afterEach(async () => {
  for (const diagnostics of diagnosticsList.splice(0)) {
    try {
      diagnostics.close();
    } catch {
      // 終了済みは無視する。
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function startOn(fake: FakeServer): BridgeDiagnostics {
  const diagnostics = startDiagnostics(fake.asBridgeServer());
  diagnosticsList.push(diagnostics);
  return diagnostics;
}

test("reliable Sessionごとに診断応答し統計を返す", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);
  const started = fake.startReliable("diag");

  fake.deliver(started.info.localSessionId, { op: "echo", id: "応答-1", value: { あ: 1 } });
  fake.deliver(started.info.localSessionId, { op: "ping", id: "応答-2" });
  expect(started.session.sent).toEqual([
    { op: "echo", id: "応答-1", value: { あ: 1 } },
    { op: "pong", id: "応答-2" },
  ]);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 1, diagnosticPing: 1 });
});

test("複数Sessionの統計を合算する", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);
  const first = fake.startReliable("diag-1");
  const second = fake.startReliable("diag-2");

  // 一つの接続口へ複数は付けず、Session ごとに1インスタンスで応答する。
  fake.deliver(first.info.localSessionId, { op: "echo", id: "合算-1", value: 1 });
  fake.deliver(second.info.localSessionId, { op: "echo", id: "合算-2", value: 2 });
  fake.deliver(second.info.localSessionId, { op: "ping", id: "合算-3" });
  expect(first.session.sent).toEqual([{ op: "echo", id: "合算-1", value: 1 }]);
  expect(second.session.sent).toEqual([
    { op: "echo", id: "合算-2", value: 2 },
    { op: "pong", id: "合算-3" },
  ]);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 2, diagnosticPing: 1 });
});

test("Session終了で統計を累積値へ回収し再接続へ継承しない", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);
  const started = fake.startReliable("diag");

  fake.deliver(started.info.localSessionId, { op: "echo", id: "回収-1", value: 1 });
  fake.end(started.info.localSessionId);
  // 終了後も統計は累積値に残る。
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 1, diagnosticPing: 0 });

  // 再接続の同名セッションは新規に数え、割当てを継承しない。
  const next = fake.startReliable("diag");
  expect(next.info.localSessionId).not.toBe(started.info.localSessionId);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 1, diagnosticPing: 0 });
  fake.deliver(next.info.localSessionId, { op: "ping", id: "回収-2" });
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 1, diagnosticPing: 1 });
});

test("latestセッションは診断対象にしない", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);
  const started = fake.startLatest("pose");

  fake.deliver(started.info.localSessionId, { x: 7 });
  expect(started.session.sent).toEqual([]);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });
  fake.end(started.info.localSessionId);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });
});

test("テキスト表示用セッションは診断対象にしない", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);
  // 論理名 `text` の reliable セッションを開始しても診断は割り当てない。
  const started = fake.startReliable(TEXT_SESSION_ID);

  fake.deliver(started.info.localSessionId, { op: "echo", id: "対象外-1", value: 1 });
  fake.deliver(started.info.localSessionId, { op: "ping", id: "対象外-2" });
  expect(started.session.sent).toEqual([]);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });
  fake.end(started.info.localSessionId);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });
});

test("開始前に存在したセッションも初期走査で割り当てる", () => {
  const fake = new FakeServer();
  const started = fake.startReliable("diag");
  const diagnostics = startOn(fake);

  fake.deliver(started.info.localSessionId, { op: "ping", id: "初期走査-1" });
  expect(started.session.sent).toEqual([{ op: "pong", id: "初期走査-1" }]);
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 0, diagnosticPing: 1 });
});

test("未割当ての終了通知では統計を壊さない", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);

  // 割り当てたことのない Session の終了通知は無視する。
  fake.notifyEndedUnknown();
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });
});

test("closeでapp-coreを閉じ累積値を保つ", () => {
  const fake = new FakeServer();
  const diagnostics = startOn(fake);
  const started = fake.startReliable("diag");
  fake.deliver(started.info.localSessionId, { op: "echo", id: "終了-1", value: 1 });

  diagnostics.close();
  // 生存分の統計は累積値に残り、二重終了も安全である。
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 1, diagnosticPing: 0 });
  diagnostics.close();
  expect(diagnostics.getStats()).toEqual({ diagnosticEcho: 1, diagnosticPing: 0 });
});

/** 対話命令の表示先を集める試験用の出力先。 */
function captureOutput(): { output: string[]; out: { write(text: string): void } } {
  const output: string[] = [];
  return {
    output,
    out: {
      write: (text: string): void => {
        output.push(text);
      },
    },
  };
}

test("statusは診断取得口がある場合に診断項目を出す", async () => {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: ["https://app.xrift.net"],
  });
  servers.push(server);
  const captured = captureOutput();

  handleCommand("status", server, captured.out, {
    getStats: () => ({ diagnosticEcho: 2, diagnosticPing: 3 }),
  });
  const text = captured.output.join("");
  expect(text).toContain("latestStored=0");
  expect(text).toContain("diagnosticEcho=2");
  expect(text).toContain("diagnosticPing=3");
});

test("statusは診断取得口がない場合に診断項目を出さない", async () => {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: ["https://app.xrift.net"],
  });
  servers.push(server);
  const captured = captureOutput();

  // 第4引数なしの既存呼び出しは維持する。
  handleCommand("status", server, captured.out);
  const text = captured.output.join("");
  expect(text).toContain("latestStored=0");
  expect(text).not.toContain("diagnosticEcho=");
  expect(text).not.toContain("diagnosticPing=");
});
