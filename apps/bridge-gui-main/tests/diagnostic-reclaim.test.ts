/**
 * 診断割当ての終了時回収の検証。
 *
 * 診断を割り当てたセッションが終わると、割当てだけでなく生成した
 * インスタンスも回収すること（`実体1・割当て0` を残さない）。
 * 比較コード本文・業務 payload は記録に残さない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createConnectionRequest, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import { DIAGNOSTIC_ECHO_SESSION_ID } from "bridge-plugin-diagnostic/contract";

const TEST_ORIGIN = "https://gui-diagnostic-reclaim-test.invalid";

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
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
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

test("診断割当てしたセッションが終わると生成分も回収する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({
    endpoint: endpoint.url,
    origin: TEST_ORIGIN,
  });
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  expect(backend.approvePairing({ requestId: pairing.requestId }).status).toBe("APPROVED");
  const provider = await request.sessionProvider;
  providers.push(provider);
  await provider.tryCreateSession({
    sessionId: DIAGNOSTIC_ECHO_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(() => backend.getSnapshot().sessions.length === 1, "生存セッションの公開");
  const target = backend.getSnapshot().sessions[0];
  if (target === undefined) throw new Error("生存セッションが無い。");

  backend.assignPlugin({ pluginKind: "diagnostic", localSessionId: target.localSessionId });
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(1);
  expect(backend.getSnapshot().plugins.instances).toHaveLength(1);

  // 運用切断でセッションが終わる。割当てと合わせて生成分も消える。
  const connectionId = backend.getSnapshot().connections[0]?.connectionId;
  if (connectionId === undefined) throw new Error("接続が無い。");
  backend.disconnectConnection({ connectionId });
  await waitForArrival(
    () =>
      backend.getSnapshot().sessions.length === 0 &&
      backend.getSnapshot().plugins.assignments.length === 0,
    "切断による割当て失効",
  );
  expect(backend.getSnapshot().plugins.instances).toHaveLength(0);
});
