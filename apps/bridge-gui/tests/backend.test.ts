/**
 * GUI バックエンドの統合検証。
 *
 * バックエンドを直接生成し、`world-client` を Node の `origin` 指定で動かして、
 * 実 WebSocket・既存 `ws`・yamux で受付から承認・診断往復・切断・再接続までを通す。
 * Bun 独自 WebSocket への置換で代用しない（実 `ws` を通す）。
 * 比較コード本文・業務 payload は記録に残さない（照合は値の一致で行う）。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { formatPairingCode } from "bridge-protocol";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";

const TEST_ORIGIN = "https://gui-test.invalid";

const backends: GuiBackend[] = [];
const providers: SessionProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

/**
 * 試験用のバックエンドを生成する。待ち受けは空きポート自動選択である。
 */
async function startBackend(): Promise<GuiBackend> {
  const backend = await GuiBackend.create({ port: 0, allowedOrigins: [TEST_ORIGIN] });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  return backend;
}

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 承認前に管理口が解決しないことを bounded に確かめる。 */
async function expectPendingProvider(request: {
  sessionProvider: Promise<SessionProvider>;
}): Promise<void> {
  let settled = false;
  void request.sessionProvider.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // 比較コード通知済みの loopback では、誤った早期解決はこの待ちで検出できる。
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(settled).toBe(false);
}

/**
 * 受付→比較コード受信まで進める。
 *
 * 両方の約束に扱いを付け、未処理の拒否を残さない。
 */
async function receivePairing(backend: GuiBackend): Promise<{
  requestId: string;
  code: string;
  sessionProvider: Promise<SessionProvider>;
}> {
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({
    endpoint: endpoint.url,
    origin: TEST_ORIGIN,
  });
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  expect(pairing.code).toMatch(/^[0-9]{6}$/);
  return {
    requestId: pairing.requestId,
    code: pairing.code,
    sessionProvider: request.sessionProvider,
  };
}

/** Session の受信 payload を集める。到着待ちは出来事の到達で確定する。 */
function collectSession(session: ReliableSession): {
  waitForPayload(predicate: (payload: unknown) => boolean): Promise<unknown>;
} {
  const payloads: unknown[] = [];
  const waiters = new Set<() => void>();
  session.onMessage((payload) => {
    payloads.push(payload);
    for (const notify of waiters) {
      notify();
    }
  });
  return {
    async waitForPayload(predicate: (payload: unknown) => boolean): Promise<unknown> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = payloads.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() >= deadline) throw new Error("Session 受信待ちがタイムアウトした。");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(notify);
            resolve();
          }, deadline - Date.now());
          const notify = (): void => {
            clearTimeout(timer);
            waiters.delete(notify);
            resolve();
          };
          waiters.add(notify);
        });
      }
    },
  };
}

function isEchoOf(payload: unknown, id: string, value: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (record["op"] !== "echo") return false;
  if (record["id"] !== id) return false;
  return JSON.stringify(record["value"]) === JSON.stringify(value);
}

function isPong(payload: unknown, id: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return record["op"] === "pong" && record["id"] === id;
}

/** 誤った比較コードを決定的に作る（正誤の取り違えはしない）。 */
function wrongCodeOf(code: string): string {
  return `${code.startsWith("0") ? "1" : "0"}${code.slice(1)}`;
}

test("受付から承認・診断往復・切断・再接続まで通る", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  expect(backend.getSnapshot().admission.accepting).toBe(true);

  const first = await receivePairing(backend);
  // 保留一覧にはコード本文を載せない。
  expect(backend.getSnapshot().pending.map((entry) => entry.requestId)).toContain(first.requestId);
  // 承認前は生存セッションが無く、管理口も未解決である（認可を継承しない）。
  expect(backend.getSnapshot().sessions).toHaveLength(0);
  await expectPendingProvider({ sessionProvider: first.sessionProvider });

  // 表示用の取得は承認しない。コード・整形が照合に使える。
  const shown = backend.getPairingView({ requestId: first.requestId });
  expect(shown.available).toBe(true);
  if (!shown.available) throw new Error("比較コード表示を取得できない。");
  expect(shown.code).toBe(first.code);
  expect(typeof shown.code).toBe("string");
  expect(shown.displayCode).toBe(formatPairingCode(first.code));

  // 誤ったコードでは承認しない。承認可否は server が決める。
  expect(
    backend.approvePairing({ requestId: first.requestId, code: wrongCodeOf(first.code) }).status,
  ).toBe("CODE_MISMATCH");
  const approved = backend.approvePairing({ requestId: first.requestId, code: first.code });
  expect(approved.status).toBe("APPROVED");
  // 承認済みの保留は表示用にも残らない。
  expect(backend.getPairingView({ requestId: first.requestId }).available).toBe(false);

  const provider = await first.sessionProvider;
  providers.push(provider);
  const session = await provider.tryCreateSession({
    sessionId: "gui-e2e",
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => backend.getSnapshot().sessions.length === 1, "生存セッションの公開");
  const sessions = backend.getSnapshot().sessions;
  const target = sessions[0];
  if (target === undefined) throw new Error("生存セッションが無い。");

  const assignment = backend.assignDiagnostics({ localSessionId: target.localSessionId });
  expect(assignment.portId).toBe("diagnostic");
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(1);
  expect(backend.getSnapshot().plugins.instances).toHaveLength(1);

  const collected = collectSession(session);
  await expect(
    session.sendReliable({ op: "echo", id: "gui-1", value: { 挨拶: "こんにちは" } }),
  ).resolves.toBeUndefined();
  await expect(
    collected.waitForPayload((payload) => isEchoOf(payload, "gui-1", { 挨拶: "こんにちは" })),
  ).resolves.toEqual({ op: "echo", id: "gui-1", value: { 挨拶: "こんにちは" } });
  await expect(session.sendReliable({ op: "ping", id: "gui-p1" })).resolves.toBeUndefined();
  await expect(collected.waitForPayload((payload) => isPong(payload, "gui-p1"))).resolves.toEqual({
    op: "pong",
    id: "gui-p1",
  });

  // 運用切断で接続が一覧から消える。
  const connections = backend.getSnapshot().connections;
  expect(connections.length).toBeGreaterThan(0);
  const connectionId = connections[0]?.connectionId;
  if (connectionId === undefined) throw new Error("接続が無い。");
  backend.disconnectConnection({ connectionId });
  await waitForArrival(
    () => backend.getSnapshot().connections.length === 0,
    "切断した接続の一覧除外",
  );

  // 再接続は新しい要求で再承認が必要である（承認前に使えない）。
  const second = await receivePairing(backend);
  expect(second.requestId).not.toBe(first.requestId);
  await expectPendingProvider({ sessionProvider: second.sessionProvider });
  const reapproved = backend.approvePairing({ requestId: second.requestId, code: second.code });
  expect(reapproved.status).toBe("APPROVED");
  const provider2 = await second.sessionProvider;
  providers.push(provider2);
  const session2 = await provider2.tryCreateSession({
    sessionId: "gui-e2e",
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => backend.getSnapshot().sessions.length === 1, "再接続後の公開");
  const target2 = backend.getSnapshot().sessions[0];
  if (target2 === undefined) throw new Error("再接続後のセッションが無い。");
  backend.assignDiagnostics({ localSessionId: target2.localSessionId });
  const collected2 = collectSession(session2);
  await expect(session2.sendReliable({ op: "ping", id: "gui-p2" })).resolves.toBeUndefined();
  await expect(collected2.waitForPayload((payload) => isPong(payload, "gui-p2"))).resolves.toEqual({
    op: "pong",
    id: "gui-p2",
  });
});

test("未割当ての reliable にデータを送ると中断される", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const pairing = await receivePairing(backend);
  expect(backend.approvePairing({ requestId: pairing.requestId, code: pairing.code }).status).toBe(
    "APPROVED",
  );
  const provider = await pairing.sessionProvider;
  providers.push(provider);

  // 診断を割り当てずに送る。到着で当該 Session のみ中断する。
  const session = await provider.tryCreateSession({
    sessionId: "gui-unassigned",
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => backend.getSnapshot().sessions.length === 1, "未割当ての公開");
  let ended = false;
  session.onEnd(() => {
    ended = true;
  });
  await expect(
    session.sendReliable({ op: "echo", id: "gui-u1", value: "未割当て" }),
  ).resolves.toBeUndefined();
  await waitForArrival(
    () => ended && backend.getSnapshot().sessions.length === 0,
    "未割当て中断による終了",
  );
  // 接続自体は維持する（中断は Session 単位）。
  expect(backend.getSnapshot().connections.length).toBeGreaterThan(0);
});

test("不正な引数と終了中の操作を拒否する", async () => {
  const backend = await startBackend();
  expect(() => backend.getPairingView({ requestId: "" })).toThrowError(RangeError);
  expect(() => backend.approvePairing({ requestId: "無い", code: 123 })).toThrowError(RangeError);
  expect(() => backend.rejectPairing({ requestId: "" })).toThrowError(RangeError);
  expect(() => backend.disconnectConnection({ connectionId: "" })).toThrowError(RangeError);
  expect(() => backend.assignDiagnostics({ localSessionId: "" })).toThrowError(RangeError);
  // 形状は正しいが存在しない対象の扱い。判定は server・基盤が行う。
  expect(backend.getPairingView({ requestId: "無い" }).available).toBe(false);
  expect(backend.rejectPairing({ requestId: "無い" }).status).toBe("NOT_PENDING");
  expect(() => backend.disconnectConnection({ connectionId: "無い" })).toThrowError(RangeError);
  expect(() => backend.assignDiagnostics({ localSessionId: "無い" })).toThrowError(RangeError);

  await backend.close();
  expect(backend.getSnapshot().backend).toBe("stopping");
  // 終了中は新規操作を拒否し、読み取りは続ける。
  expect(() => backend.enableAcceptance()).toThrowError(Error);
  expect(() => backend.assignDiagnostics({ localSessionId: "無い" })).toThrowError(Error);
  expect(backend.getSnapshot().sessions).toHaveLength(0);
});

test("終了後は待ち受けポートが解放される", async () => {
  const backend = await startBackend();
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const port = new URL(endpoint.url).port;
  expect(port).not.toBe("");
  await backend.close();
  // 同一ポートで起動し直せる（待受が残っていないこと）。
  const reopened = await GuiBackend.create({
    port: Number(port),
    allowedOrigins: [TEST_ORIGIN],
  });
  backends.push(reopened);
  expect(reopened.getSnapshot().backend).toBe("ready");
  expect(new URL(reopened.getSnapshot().endpoint?.url ?? "").port).toBe(port);
});
