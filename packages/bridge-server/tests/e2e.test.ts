/**
 * 製品 E2E（Unit F1）。
 *
 * 実 `createBridgeServer`（`packages/bridge-server`）と実 `world-client`
 * （`createConnectionRequest`、ビルド済み `dist` 経由）を1本の実 WebSocket
 * （Node 22 の global `WebSocket` を world-client のブラウザ適合経由）で
 * 接続し、ペアリング→認可→同一 WS 上の mux→Session 往復→latest→終了までを
 * 通す。既存の C（bridge×生 ws）と D（transport ハーネス×world-client）の
 * 隙間を埋める。
 *
 * 時間は手動スケジューラに差し替え、到着は出来事の到達で待つ。実時間の
 * 厳密一致は求めない。比較コードは照合にだけ使い、本文を残さない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import type { TimerScheduler } from "bridge-protocol/transport";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { createBridgeServer, type BridgeServer } from "../src/server.ts";
import { attachEchoResponder } from "./echo-responder.ts";

const TEST_ORIGIN = "http://localhost:5173";

/**
 * 手で進めるタイマーと時刻。接続要求とサーバ側 Connection の双方に注入し、
 * 実時間に依存せず期限動作を安定させる。通常の送受信はタイマー発火を
 * 要しないため、進めずに使う。
 */
class ManualScheduler implements TimerScheduler {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();
  nowMs = 0;

  now(): number {
    return this.nowMs;
  }

  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
}

const servers: BridgeServer[] = [];
const providers: SessionProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(scheduler: ManualScheduler): Promise<BridgeServer> {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: [TEST_ORIGIN],
    scheduler,
  });
  servers.push(server);
  return server;
}

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * ペアリング→承認→認可まで進めて管理口を受け取る。
 *
 * 比較コードは表示と照合にだけ使い、本文の assert は残さない。両方の約束に
 * 扱いを付け、未処理の拒否を残さない。
 */
async function connectApproved(
  server: BridgeServer,
  scheduler: ManualScheduler,
): Promise<SessionProvider> {
  const request = createConnectionRequest({
    endpoint: server.endpoint,
    origin: TEST_ORIGIN,
    timeoutMs: 10_000,
    scheduler,
    now: () => scheduler.nowMs,
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
      const deadline = Date.now() + 3_000;
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

function is往復(payload: unknown, id: string, expected: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (record["往復"] !== id) return false;
  return JSON.stringify(payload) === JSON.stringify(expected);
}

test("実bridgeと実world-clientでペアリングから認可muxまで通る", async () => {
  const scheduler = new ManualScheduler();
  const server = await startServer(scheduler);
  server.openAcceptance();
  const provider = await connectApproved(server, scheduler);

  expect(provider.isAlive).toBe(true);
  expect(provider.connectionId).not.toBe("");
  const listed = server
    .listConnections()
    .find((item) => item.connectionId === provider.connectionId);
  expect(listed).toMatchObject({ origin: TEST_ORIGIN, authorized: true });
});

test("reliable双方向で一般payloadの往復が通る", async () => {
  const scheduler = new ManualScheduler();
  const server = await startServer(scheduler);
  server.openAcceptance();
  const provider = await connectApproved(server, scheduler);
  const stopResponding = attachEchoResponder(server);
  try {
    const session = await provider.tryCreateSession({
      sessionId: "e2e-echo",
      kind: "reliable",
      direction: "bidirectional",
    });
    const collected = collectSession(session);
    // 送信完了はローカル送信の完了であり、一致判定は受信で行う。
    await expect(
      session.sendReliable({ 往復: "e2e-1", 値: { data: "x" } }),
    ).resolves.toBeUndefined();
    const echoed = await collected.waitForPayload((payload) =>
      is往復(payload, "e2e-1", { 往復: "e2e-1", 値: { data: "x" } }),
    );
    expect(echoed).toEqual({ 往復: "e2e-1", 値: { data: "x" } });

    // サーバ側の既定応答ではなく、公開 Session API で付けた応答器が返す。
    await expect(session.sendReliable({ 往復: "e2e-p1" })).resolves.toBeUndefined();
    await expect(
      collected.waitForPayload((payload) => is往復(payload, "e2e-p1", { 往復: "e2e-p1" })),
    ).resolves.toEqual({ 往復: "e2e-p1" });
  } finally {
    stopResponding();
  }
});

test("latestのclientからserverへの送信で最新値が受信箱に残る", async () => {
  const scheduler = new ManualScheduler();
  const server = await startServer(scheduler);
  server.openAcceptance();
  const provider = await connectApproved(server, scheduler);

  const pose = await provider.tryCreateSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  pose.sendLatest({ x: 1 });
  pose.sendLatest({ x: 2 });
  await waitForArrival(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 2;
  }, "最新値の受信箱への反映");
  expect(server.getLatest("pose")).toEqual({ x: 2 });
  expect(server.getStats().latestStored).toBe(2);
});

test("FIN後も他Sessionは継続しConnection終了で認可失効と未決着拒否になる", async () => {
  const scheduler = new ManualScheduler();
  const server = await startServer(scheduler);
  server.openAcceptance();
  const provider = await connectApproved(server, scheduler);
  const connectionId = provider.connectionId;
  const stopResponding = attachEchoResponder(server);

  const echo = await provider.tryCreateSession({
    sessionId: "e2e-echo",
    kind: "reliable",
    direction: "bidirectional",
  });
  const echoCollected = collectSession(echo);
  await echo.sendReliable({ 往復: "e2e-1", 値: { data: "x" } });
  await echoCollected.waitForPayload((payload) =>
    is往復(payload, "e2e-1", { 往復: "e2e-1", 値: { data: "x" } }),
  );

  const ping = await provider.tryCreateSession({
    sessionId: "e2e-ping",
    kind: "reliable",
    direction: "bidirectional",
  });
  const pingCollected = collectSession(ping);

  // FIN 送出は完了し、逆方向（他 Session）は継続する。
  await expect(echo.closeWrite()).resolves.toBeUndefined();
  await ping.sendReliable({ 往復: "e2e-p1" });
  await expect(
    pingCollected.waitForPayload((payload) => is往復(payload, "e2e-p1", { 往復: "e2e-p1" })),
  ).resolves.toEqual({ 往復: "e2e-p1" });

  // 未決着の送信は Connection 終了で結果不明として拒否され、二重決着しない。
  let closedCount = 0;
  provider.onClosed(() => {
    closedCount += 1;
  });
  let settled = 0;
  const pending = ping.sendReliable({ 往復: "e2e-p2" });
  const counted = pending.then(
    () => {
      settled += 1;
    },
    () => {
      settled += 1;
    },
  );
  provider.close();
  await counted;
  await expect(pending).rejects.toThrow();
  expect(settled).toBe(1);
  expect(provider.isAlive).toBe(false);
  expect(closedCount).toBe(1);

  // サーバ側の認可は失効し、一覧から除外される。
  await waitForArrival(() => {
    return (
      server.listConnections().find((item) => item.connectionId === connectionId) === undefined
    );
  }, "終了した接続の一覧からの除外");
  expect(server.getConnectionCount()).toBe(0);
  stopResponding();
});

test("再接続で新しいconnectionIdで再承認し送受信できる", async () => {
  const scheduler = new ManualScheduler();
  const server = await startServer(scheduler);
  server.openAcceptance();
  const stopResponding = attachEchoResponder(server);

  const first = await connectApproved(server, scheduler);
  const firstId = first.connectionId;
  const pose = await first.tryCreateSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  pose.sendLatest({ x: 1 });
  await waitForArrival(() => {
    const value = server.getLatest("pose") as Record<string, unknown> | undefined;
    return value !== undefined && value["x"] === 1;
  }, "切断前の最新値の反映");

  first.close();
  await waitForArrival(() => server.getConnectionCount() === 0, "切断の確定");
  // 切断で受信箱は消さない。
  expect(server.getLatest("pose")).toEqual({ x: 1 });

  // 旧認可は引き継がず、別 conn として再承認する。
  const second = await connectApproved(server, scheduler);
  expect(second).not.toBe(first);
  expect(second.connectionId).not.toBe(firstId);

  const echo = await second.tryCreateSession({
    sessionId: "e2e-echo",
    kind: "reliable",
    direction: "bidirectional",
  });
  const collected = collectSession(echo);
  await echo.sendReliable({ 往復: "e2e-2", 値: { data: "y" } });
  await expect(
    collected.waitForPayload((payload) =>
      is往復(payload, "e2e-2", { 往復: "e2e-2", 値: { data: "y" } }),
    ),
  ).resolves.toEqual({ 往復: "e2e-2", 値: { data: "y" } });
  stopResponding();
});

test("管理切断は対象のみ終了し他に波及しない", async () => {
  const scheduler = new ManualScheduler();
  const server = await startServer(scheduler);
  server.openAcceptance();

  const first = await connectApproved(server, scheduler);
  const second = await connectApproved(server, scheduler);
  expect(second.connectionId).not.toBe(first.connectionId);
  const targetId = first.connectionId;
  const stopResponding = attachEchoResponder(server);

  const survivorEcho = await second.tryCreateSession({
    sessionId: "e2e-echo",
    kind: "reliable",
    direction: "bidirectional",
  });
  const survivorCollected = collectSession(survivorEcho);

  let targetClosedCount = 0;
  first.onClosed(() => {
    targetClosedCount += 1;
  });
  let survivorClosedCount = 0;
  second.onClosed(() => {
    survivorClosedCount += 1;
  });

  server.disconnectConnection(targetId);

  await waitForArrival(() => !first.isAlive, "切断対象の終端");
  expect(targetClosedCount).toBe(1);
  await waitForArrival(() => {
    return server.listConnections().find((item) => item.connectionId === targetId) === undefined;
  }, "切断対象の一覧からの除外");

  // 他接続は認可を保ち、送受信を続けられる。
  expect(second.isAlive).toBe(true);
  expect(survivorClosedCount).toBe(0);
  const survivor = server
    .listConnections()
    .find((item) => item.connectionId === second.connectionId);
  expect(survivor?.authorized).toBe(true);
  await survivorEcho.sendReliable({ 往復: "e2e-survive-1" });
  await expect(
    survivorCollected.waitForPayload((payload) =>
      is往復(payload, "e2e-survive-1", { 往復: "e2e-survive-1" }),
    ),
  ).resolves.toEqual({ 往復: "e2e-survive-1" });
  stopResponding();
});
