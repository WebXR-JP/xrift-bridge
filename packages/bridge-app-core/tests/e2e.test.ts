/**
 * 基盤 E2E。
 *
 * 実 `createBridgeServer` と実 `world-client` を実 WebSocket で接続し、
 * 基盤（app-core）の診断プラグイン割当てを経由した診断往復を通す。
 * 応答の確認はプラグインの統計（UI 非依存の状態）で行い、サーバー側の
 * 現行診断ハンドラの計数とは混在させない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { createBridgeServer, type BridgeServer } from "bridge-server";
import { createBridgeAppCore, type BridgeAppCore } from "../src/app-core.ts";
import { DIAGNOSTIC_PORT_ID, diagnosticPlugin } from "../src/plugins/diagnostic.ts";
import type { PluginInstanceHandle } from "../src/plugin.ts";
import type { DiagnosticStats } from "../src/plugins/diagnostic.ts";

const TEST_ORIGIN = "http://localhost:5173";

const servers: BridgeServer[] = [];
const providers: SessionProvider[] = [];
const cores: BridgeAppCore[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  for (const core of cores.splice(0)) {
    try {
      core.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(): Promise<BridgeServer> {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: [TEST_ORIGIN],
  });
  servers.push(server);
  return server;
}

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * ペアリング→承認→認可まで進めて管理口を受け取る。
 *
 * 比較コードは表示と照合にだけ使う。両方の約束に扱いを付け、
 * 未処理の拒否を残さない。
 */
async function connectApproved(server: BridgeServer): Promise<SessionProvider> {
  const request = createConnectionRequest({
    endpoint: server.endpoint,
    origin: TEST_ORIGIN,
    timeoutMs: 10_000,
  });
  // 先に待つ pairingInfo が拒否した場合も sessionProvider 側の扱いを確定する。
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  expect(pairing.code).toMatch(/^[0-9]{6}$/);
  expect(typeof pairing.requestId).toBe("string");
  // テスト用の承認。ローカル管理境界の API であり設計どおり。
  const approved = server.approvePairing(pairing.requestId, pairing.code);
  expect(approved.status).toBe("APPROVED");
  if (approved.status !== "APPROVED") throw new Error("承認できない。");
  const provider = await request.sessionProvider;
  providers.push(provider);
  expect(provider.connectionId).toBe(approved.connectionId);
  return provider;
}

/**
 * 基盤を組み立て、開始したセッションを診断プラグインへ割り当てる。
 *
 * 割当ては開始通知で同期に行い、未割当て中断より先に確定させる。
 */
function attachDiagnostic(server: BridgeServer): PluginInstanceHandle<DiagnosticStats> {
  const core = createBridgeAppCore(server);
  cores.push(core);
  const handle = core.createInstance(diagnosticPlugin);
  server.onManagementEvent((event) => {
    if (event.kind !== "session-started") return;
    try {
      core.assign(event.session.localSessionId, handle.instanceId, DIAGNOSTIC_PORT_ID);
    } catch {
      // 割当て失敗は試験の到達待ちで検出する。
    }
  });
  return handle;
}

/** Session の受信 payload を集める。到着待ちは出来事の到達で確定する。 */
function collectSession(session: ReliableSession): {
  waitForPayload(predicate: (payload: unknown) => boolean): Promise<unknown>;
} {
  const payloads: unknown[] = [];
  const waiters = new Set<() => void>();
  session.onMessage((payload) => {
    payloads.push(payload);
    // 通知は自身を待機列から外すだけであり、走査中の削除は安全である。
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

test("実セッション経由で診断プラグインがechoとpingに応答する", async () => {
  const server = await startServer();
  server.openAcceptance();
  const 診断 = attachDiagnostic(server);
  const core = cores[0];
  if (core === undefined) throw new Error("基盤がない。");
  const provider = await connectApproved(server);

  const session = await provider.tryCreateSession({
    sessionId: "e2e-diag",
    kind: "reliable",
    direction: "bidirectional",
  });
  // 開始通知での割当てを到達で確定してから送る（未割当て中断を避ける）。
  await waitForArrival(() => core.listAssignments().length === 1, "診断への割当て");

  const collected = collectSession(session);
  await expect(
    session.sendReliable({ op: "echo", id: "e2e-1", value: { data: "あ" } }),
  ).resolves.toBeUndefined();
  await expect(
    collected.waitForPayload((payload) => isEchoOf(payload, "e2e-1", { data: "あ" })),
  ).resolves.toEqual({ op: "echo", id: "e2e-1", value: { data: "あ" } });

  await expect(session.sendReliable({ op: "ping", id: "e2e-p1" })).resolves.toBeUndefined();
  await expect(collected.waitForPayload((payload) => isPong(payload, "e2e-p1"))).resolves.toEqual({
    op: "pong",
    id: "e2e-p1",
  });

  // 応答の証拠はプラグインの統計で確かめる（サーバー計数とは混在させない）。
  await waitForArrival(
    () => 診断.getState().diagnosticEcho === 1 && 診断.getState().diagnosticPing === 1,
    "診断プラグインの応答統計",
  );
  expect(診断.getState()).toEqual({ diagnosticEcho: 1, diagnosticPing: 1 });
});

test("セッション終了で割当てが外れ次のセッションを割当て直せる", async () => {
  const server = await startServer();
  server.openAcceptance();
  const 診断 = attachDiagnostic(server);
  const core = cores[0];
  if (core === undefined) throw new Error("基盤がない。");
  const provider = await connectApproved(server);

  const first = await provider.tryCreateSession({
    sessionId: "e2e-diag",
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => core.listAssignments().length === 1, "初回の割当て");
  expect(診断.getState()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });

  // クライアント側の中断で Session が終わり、割当てと操作口が失効する。
  first.abort(new Error("試験中断"));
  await waitForArrival(() => core.listAssignments().length === 0, "終了による割当て失効");

  // インスタンスは自動削除されないため、次のセッションを割り当て直せる。
  const second = await provider.tryCreateSession({
    sessionId: "e2e-diag",
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => core.listAssignments().length === 1, "次のセッションの割当て");
  const collected = collectSession(second);
  await expect(second.sendReliable({ op: "ping", id: "e2e-p2" })).resolves.toBeUndefined();
  await expect(collected.waitForPayload((payload) => isPong(payload, "e2e-p2"))).resolves.toEqual({
    op: "pong",
    id: "e2e-p2",
  });
  await waitForArrival(() => 診断.getState().diagnosticPing === 1, "割当て直後の応答統計");
});
