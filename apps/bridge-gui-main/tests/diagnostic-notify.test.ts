/**
 * 診断統計の変化通知の検証。
 *
 * 診断 endpoint は本体の状態変更を購読し、表示用 DTO をその表示期間の子へ
 * 送る。ここでは実 WebSocket・既存 `ws`・yamux を通し、echo／ping 応答の
 * 統計変化が通知に載ることを確かめる。比較コード本文・業務 payload は
 * 記録に残さない。main にキュー・再配信・最新状態キャッシュは無い。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import type { PluginRelayEvent } from "bridge-gui-contract/plugin-instance";
import type { PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import {
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
} from "bridge-plugin-diagnostic/contract";
import {
  DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED,
  DIAGNOSTIC_RELAY_METHOD_GET_STATE,
  isDiagnosticInstanceView,
} from "bridge-plugin-diagnostic/gui-contract";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";

const TEST_ORIGIN = "https://gui-diagnostic-notify-test.invalid";

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
  const backend = await GuiBackend.create(
    {
      port: 0,
      allowedOrigins: [TEST_ORIGIN],
    },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
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

/** echo 応答の到達を判定する。値の一致だけを見る。 */
function isEchoOf(payload: unknown, id: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return record["op"] === "echo" && record["id"] === id;
}

/**
 * 束縛個体用の診断 endpoint を組み立てる。本番配線（登録表の endpoint 工場＋
 * 管理層の束縛個体限定の参照口）で作る。
 */
function diagnosticEndpointOf(
  backend: GuiBackend,
  instanceId: string,
  emitted: PluginRelayEvent[],
): PluginEndpoint {
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  const entry = backend.companionRegistry.getEntry("diagnostic");
  if (entry === undefined) throw new Error("診断の登録が無い。");
  const ref = manager.createBoundRef("diagnostic", instanceId);
  return entry.createEndpoint(ref, {
    emit: (event) => {
      emitted.push(event);
    },
  });
}

test("診断の応答で統計が変わると通知が届く", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const pairing = await receivePairing(backend);
  expect(backend.approvePairing({ requestId: pairing.requestId }).status).toBe("APPROVED");
  const provider = await pairing.sessionProvider;
  providers.push(provider);
  const session = await provider.tryCreateSession({
    sessionId: DIAGNOSTIC_ECHO_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => backend.getSnapshot().sessions.length === 1, "生存セッションの公開");
  const sessions = backend.getSnapshot().sessions;
  const target = sessions[0];
  if (target === undefined) throw new Error("生存セッションが無い。");
  const assignment = backend.assignPlugin({
    pluginKind: "diagnostic",
    localSessionId: target.localSessionId,
  });
  const emitted: PluginRelayEvent[] = [];
  const endpoint = diagnosticEndpointOf(backend, assignment.instanceId, emitted);
  try {
    const initial = await endpoint.handleRequest({
      method: DIAGNOSTIC_RELAY_METHOD_GET_STATE,
      params: {},
    });
    if (!isDiagnosticInstanceView(initial)) throw new Error("表示用 DTO の形状が不正である。");
    expect(initial.stats).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });

    const collected = collectSession(session);
    await expect(
      session.sendReliable({ op: "echo", id: "gui-n1", value: "通知確認" }),
    ).resolves.toBeUndefined();
    await expect(
      collected.waitForPayload((payload) => isEchoOf(payload, "gui-n1")),
    ).resolves.toBeDefined();
    // 応答の統計変化が本体の変更通知から endpoint の通知に載る。到達の有無だけを見る。
    await waitForArrival(
      () =>
        emitted.some(
          (event) =>
            event.event === DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED &&
            isDiagnosticInstanceView(event.payload) &&
            event.payload.stats.diagnosticEcho === 1,
        ),
      "診断統計の変化通知",
    );
    const current = await endpoint.handleRequest({
      method: DIAGNOSTIC_RELAY_METHOD_GET_STATE,
      params: {},
    });
    if (!isDiagnosticInstanceView(current)) throw new Error("表示用 DTO の形状が不正である。");
    expect(current.stats).toEqual({ diagnosticEcho: 1, diagnosticPing: 0 });
  } finally {
    endpoint.dispose();
  }
});

test("診断はallowlist外（text）の候補を選ばない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const pairing = await receivePairing(backend);
  expect(backend.approvePairing({ requestId: pairing.requestId }).status).toBe("APPROVED");
  const provider = await pairing.sessionProvider;
  providers.push(provider);
  await provider.tryCreateSession({
    sessionId: TEXT_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => backend.getSnapshot().sessions.length === 1, "生存セッションの公開");
  const target = backend.getSnapshot().sessions[0];
  if (target === undefined) throw new Error("生存セッションが無い。");
  expect(() =>
    backend.assignPlugin({
      pluginKind: "diagnostic",
      localSessionId: target.localSessionId,
    }),
  ).toThrowError(RangeError);
  void DIAGNOSTIC_PING_SESSION_ID;
});
