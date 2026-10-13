/**
 * 診断統計の変化通知の検証。
 *
 * 診断プラグインに状態購読が無いため、管理層の最小の変化検出が echo／ping
 * 応答の統計変化を状態通知に載せること（既定周期での到達）を確かめる。
 * 実 WebSocket・既存 `ws`・yamux を通し、比較コード本文・業務 payload は
 * 記録に残さない。厳密な周期値は記述子の単体試験で固定する。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import { registerBundledPlugins } from "../src/composition/bundled-plugins.ts";
import type { PluginCompanion } from "bridge-gui-plugin-sdk/companion";
import type { DiagnosticInstanceView } from "../src/plugin-ui/diagnostic/contract.ts";

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
 * 試験用のバックエンドを生成する。待ち受けは空きポート自動選択であり、
 * 診断の変化検出は記述子の既定周期で行う。
 */
async function startBackend(): Promise<GuiBackend> {
  const backend = await GuiBackend.create(
    {
      port: 0,
      allowedOrigins: [TEST_ORIGIN],
    },
    { registerPlugins: registerBundledPlugins },
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
 * 束縛診断個体の限定表示を読む。
 */
function readDiagnosticView(backend: GuiBackend, instanceId: string): DiagnosticInstanceView {
  const companion: PluginCompanion | undefined = backend.companionRegistry.get("diagnostic");
  if (companion === undefined) throw new Error("診断 companion が無い。");
  // ADR: `as` を使う理由は、汎用口が種別を問わない表示を返し、試験で
  // 束縛種別の具象表示を取り出すためである。根拠は、対応付けが同一種別の
  // 記述子で読み・付番を対にすることである。
  return companion.readView(instanceId) as DiagnosticInstanceView;
}

test("診断の応答で統計が変わると状態通知が届く", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const pairing = await receivePairing(backend);
  expect(backend.approvePairing({ requestId: pairing.requestId, code: pairing.code }).status).toBe(
    "APPROVED",
  );
  const provider = await pairing.sessionProvider;
  providers.push(provider);
  const session = await provider.tryCreateSession({
    sessionId: "gui-diagnostic-notify",
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
  expect(readDiagnosticView(backend, assignment.instanceId).stats).toEqual({
    diagnosticEcho: 0,
    diagnosticPing: 0,
  });

  // 通知の到達を数える。内容ではなく改訂の前進で確かめる。
  let notifiedRevision = backend.getSnapshot().revision;
  const unsubscribe = backend.onStateChanged(({ revision }) => {
    notifiedRevision = Math.max(notifiedRevision, revision);
  });
  try {
    const baseline = backend.getSnapshot().revision;
    const collected = collectSession(session);
    await expect(
      session.sendReliable({ op: "echo", id: "gui-n1", value: "通知確認" }),
    ).resolves.toBeUndefined();
    await expect(
      collected.waitForPayload((payload) => isEchoOf(payload, "gui-n1")),
    ).resolves.toBeDefined();
    // 応答の統計変化が既定周期の検出で状態通知に載る。到達の有無だけを見る。
    await waitForArrival(() => notifiedRevision > baseline, "診断統計の変化通知");
    expect(readDiagnosticView(backend, assignment.instanceId).stats).toEqual({
      diagnosticEcho: 1,
      diagnosticPing: 0,
    });
  } finally {
    unsubscribe();
  }
});
