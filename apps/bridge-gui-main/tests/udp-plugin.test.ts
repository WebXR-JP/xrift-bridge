/**
 * UDP割当て・表示用 DTO・中継の統合検証。
 *
 * バックエンドを直接生成し、`world-client` を Node の `origin` 指定で動かして、
 * 実 WebSocket・既存 `ws`・yamux で候補検査・割当て・中継までを通す。
 * 割当ては汎用管理操作（`assignPlugin`/`unassignPlugin`）、表示読取りと操作は
 * 本番 endpoint（backend が生成した登録表の endpoint 工場＋束縛個体限定の
 * 参照口）経由の中継で行い、新本番経路を通す。main は中継だけを担い、
 * 要求・通知の中身を解釈しない。未知 method の検証は endpoint が行い、
 * 反射的呼出しはしない。
 * 論理名は各契約の正本（`UDP_SESSION_ID`・診断・テキストの定数）で参照し、
 * 文字列の直書きを持たない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { UDP_PORT_ID } from "bridge-plugin-udp";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import {
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
} from "bridge-plugin-diagnostic/contract";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import type { PluginRelayEvent } from "bridge-gui-contract/plugin-instance";
import type { PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import {
  UDP_RELAY_EVENT_STATE,
  UDP_RELAY_METHOD_GET_STATE,
  UDP_RELAY_METHOD_START,
  UDP_RELAY_METHOD_STOP,
  isUdpCompanionSnapshot,
  type UdpCompanionSnapshot,
} from "bridge-plugin-udp/gui-contract";

const TEST_ORIGIN = "https://gui-udp-test.invalid";

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

/**
 * 受付→承認→管理口の解決まで進める。
 *
 * 両方の約束に扱いを付け、未処理の拒否を残さない。
 */
async function approveConnection(backend: GuiBackend): Promise<SessionProvider> {
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({
    endpoint: endpoint.url,
    origin: TEST_ORIGIN,
  });
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  const approved = backend.approvePairing({ requestId: pairing.requestId });
  expect(approved.status).toBe("APPROVED");
  const provider = await request.sessionProvider;
  providers.push(provider);
  return provider;
}

/**
 * 指定の論理名で確実配送の双方向セッションを作り、生存公開を待つ。
 *
 * @param backend - 割当て先のバックエンド。
 * @param provider - セッションを作る接続。
 * @param sessionIds - 作るセッションの論理名の一覧。
 * @returns 作った順のセッション。
 */
async function createSessions(
  backend: GuiBackend,
  provider: SessionProvider,
  sessionIds: readonly string[],
): Promise<ReliableSession[]> {
  const before = backend.getSnapshot().sessions.length;
  const sessions: ReliableSession[] = [];
  for (const sessionId of sessionIds) {
    sessions.push(
      await provider.tryCreateSession({ sessionId, kind: "reliable", direction: "bidirectional" }),
    );
  }
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + sessionIds.length,
    "生存セッションの公開",
  );
  return sessions;
}

/**
 * 束縛個体用の UDP endpoint を組み立てる。本番配線（登録表の endpoint 工場＋
 * 管理層の束縛個体限定の参照口）で作る。
 */
function udpEndpointOf(
  backend: GuiBackend,
  instanceId: string,
  emitted: PluginRelayEvent[],
): PluginEndpoint {
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  const entry = backend.companionRegistry.getEntry("udp");
  if (entry === undefined) throw new Error("UDP の登録が無い。");
  const ref = manager.createBoundRef("udp", instanceId);
  return entry.createEndpoint(ref, {
    emit: (event) => {
      emitted.push(event);
    },
  });
}

/**
 * 束縛個体の表示用 DTO を中継で読む。
 */
async function readUdpView(endpoint: PluginEndpoint): Promise<UdpCompanionSnapshot> {
  const value = await endpoint.handleRequest({ method: UDP_RELAY_METHOD_GET_STATE, params: {} });
  if (!isUdpCompanionSnapshot(value)) throw new Error("表示用 DTO の形状が不正である。");
  return value;
}

/**
 * 束縛個体へ子画面操作を中継で送る。子は操作名と引数だけを渡す。
 */
async function sendUdpViaRelay(
  endpoint: PluginEndpoint,
  method: string,
  params: unknown,
): Promise<unknown> {
  return endpoint.handleRequest({ method, params });
}

test("候補が無いときはUDP割当てを拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  // セッション自体が無い場合。
  expect(() => backend.assignPlugin({ pluginKind: "udp" })).toThrowError(RangeError);
  // UDP 以外の論理名だけの場合。
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [
    TEXT_SESSION_ID,
    DIAGNOSTIC_ECHO_SESSION_ID,
    DIAGNOSTIC_PING_SESSION_ID,
    "other",
  ]);
  expect(() => backend.assignPlugin({ pluginKind: "udp" })).toThrowError(RangeError);
  // 指定方式でも UDP 以外は対象にしない。
  const textSession = backend
    .getSnapshot()
    .sessions.find((info) => info.sessionId === TEXT_SESSION_ID);
  if (textSession === undefined) throw new Error("検証用のセッションが無い。");
  expect(() =>
    backend.assignPlugin({ pluginKind: "udp", localSessionId: textSession.localSessionId }),
  ).toThrowError(RangeError);
  expect(
    backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "udp"),
  ).toBeUndefined();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
});

test("候補が一件のときは自動で割り当てる", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [UDP_SESSION_ID]);

  const assignment = backend.assignPlugin({ pluginKind: "udp" });
  expect(assignment.pluginKind).toBe("udp");
  expect(assignment.portId).toBe(UDP_PORT_ID);
  const udpSession = backend
    .getSnapshot()
    .sessions.find((info) => info.sessionId === UDP_SESSION_ID);
  expect(assignment.localSessionId).toBe(udpSession?.localSessionId);
  const owned = backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "udp");
  expect(owned?.localSessionId).toBe(assignment.localSessionId);
  expect(owned?.instanceId).toBe(assignment.instanceId);
  expect(owned?.phase).toBe("active");
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(1);

  // 割当て中の再要求は拒否する（未割当て候補が無い）。
  expect(() => backend.assignPlugin({ pluginKind: "udp" })).toThrowError(RangeError);
});

test("指定方式は適格候補から指定個体を選び複数でも拒否しない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  // 全接続を通じて二件の UDP 候補を作る。
  const first = await approveConnection(backend);
  await createSessions(backend, first, [UDP_SESSION_ID]);
  const second = await approveConnection(backend);
  await createSessions(backend, second, [UDP_SESSION_ID]);
  expect(
    backend.getSnapshot().sessions.filter((info) => info.sessionId === UDP_SESSION_ID),
  ).toHaveLength(2);

  // 自動では一件目を選ばず拒否する。
  expect(() => backend.assignPlugin({ pluginKind: "udp" })).toThrowError(RangeError);
  // 指定方式は適格候補から指定個体を選ぶ。
  const target = backend.getSnapshot().sessions.find((info) => info.sessionId === UDP_SESSION_ID);
  if (target === undefined) throw new Error("検証用のセッションが無い。");
  const assignment = backend.assignPlugin({
    pluginKind: "udp",
    localSessionId: target.localSessionId,
  });
  expect(assignment.localSessionId).toBe(target.localSessionId);
  expect(assignment.portId).toBe(UDP_PORT_ID);
  // 未知の指定は拒否する。
  expect(() => backend.assignPlugin({ pluginKind: "udp", localSessionId: "無い" })).toThrowError(
    RangeError,
  );
});

test("論理名がudpでも輸送の適合が違えば対象にしない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const before = backend.getSnapshot().sessions.length;
  const latest = await provider.tryCreateSession({
    sessionId: UDP_SESSION_ID,
    kind: "latest",
    direction: "to_server",
  });
  // 作った輸送が確かに latest である（試験の前提）。
  expect(latest.kind).toBe("latest");
  expect(latest.direction).toBe("to_server");
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
  const published = backend
    .getSnapshot()
    .sessions.find((info) => info.sessionId === UDP_SESSION_ID);
  if (published === undefined) throw new Error("検証用のセッションが無い。");

  // 論理名の一致だけでは選ばない。
  expect(() => backend.assignPlugin({ pluginKind: "udp" })).toThrowError(RangeError);
  expect(() =>
    backend.assignPlugin({ pluginKind: "udp", localSessionId: published.localSessionId }),
  ).toThrowError(RangeError);
  expect(
    backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "udp"),
  ).toBeUndefined();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
});

test("割当て後の中継の表示は限定項目だけを含み他個体情報を載せない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID, UDP_SESSION_ID]);
  const assignment = backend.assignPlugin({ pluginKind: "udp" });

  const emitted: PluginRelayEvent[] = [];
  const endpoint = udpEndpointOf(backend, assignment.instanceId, emitted);
  try {
    const view = await readUdpView(endpoint);
    expect(Object.keys(view).sort()).toEqual([
      "boundAddress",
      "canStart",
      "instanceId",
      "isRunning",
      "lastError",
      "localSessionId",
      "phase",
      "portId",
      "requestedBind",
      "revision",
      "stats",
    ]);
    expect(view.localSessionId).toBe(assignment.localSessionId);
    expect(view.phase).toBe("stopped");
    expect(view.requestedBind).toBeNull();
    expect(view.boundAddress).toBeNull();
    expect(view.canStart).toBe(true);
    expect(view.isRunning).toBe(false);
    expect(view.lastError).toBeNull();
    expect(view.stats).toEqual({
      receivedDatagrams: 0,
      receivedBytes: 0,
      forwardedDatagrams: 0,
      forwardedBytes: 0,
      droppedOversize: 0,
      droppedBusy: 0,
      droppedInvalidMetadata: 0,
      sendFailures: 0,
    });
    // 他個体（テキスト表示用）の識別子は載せない。
    const textSession = backend
      .getSnapshot()
      .sessions.find((info) => info.sessionId === TEXT_SESSION_ID);
    if (textSession === undefined) throw new Error("検証用のセッションが無い。");
    expect(JSON.stringify(view)).not.toContain(textSession.localSessionId);
    void UDP_RELAY_EVENT_STATE;
  } finally {
    endpoint.dispose();
  }
});

test("中継は開始と停止の分岐で未知操作を値に載せる", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [UDP_SESSION_ID]);
  const assignment = backend.assignPlugin({ pluginKind: "udp" });

  const emitted: PluginRelayEvent[] = [];
  const endpoint = udpEndpointOf(backend, assignment.instanceId, emitted);
  try {
    // 束縛外の個体の endpoint 生成は失効として拒否する（所有検証は参照口が行う）。
    expect(() => udpEndpointOf(backend, "無い", emitted)).toThrowError(RangeError);
    // 閉じた分岐の外は値に載せる（投げない・反射呼出ししない）。
    const unknown = await sendUdpViaRelay(endpoint, "erase", {});
    expect(unknown).toMatchObject({ ok: false, reason: "unknown-method" });
    // 形状外の開始引数は理由付きの失敗で返す（拒否では表さない）。
    const invalid = await sendUdpViaRelay(endpoint, UDP_RELAY_METHOD_START, {
      bind: { address: "", port: 0 },
      allowNonLoopback: false,
    });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid-config" });
    // 非 loopback の確認不足も理由付きで返す。
    const unconfirmed = await sendUdpViaRelay(endpoint, UDP_RELAY_METHOD_START, {
      bind: { address: "8.8.8.8", port: 50000 },
      allowNonLoopback: false,
    });
    expect(unconfirmed).toMatchObject({ ok: false, reason: "confirmation-required" });
    // 失敗した開始は待受けを作らず統計を動かさない。
    const afterFailed = await readUdpView(endpoint);
    expect(afterFailed.phase).toBe("stopped");
    expect(afterFailed.boundAddress).toBeNull();
    expect(afterFailed.stats.receivedDatagrams).toBe(0);
    // 待受けが無い停止は成功とする（冪等）。
    const stopped = await sendUdpViaRelay(endpoint, UDP_RELAY_METHOD_STOP, {});
    expect(stopped).toEqual({ ok: true });
  } finally {
    endpoint.dispose();
  }
});

test("endpoint の終了は冪等であり二重解放しない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [UDP_SESSION_ID]);
  const assignment = backend.assignPlugin({ pluginKind: "udp" });
  const emitted: PluginRelayEvent[] = [];
  const endpoint = udpEndpointOf(backend, assignment.instanceId, emitted);
  endpoint.dispose();
  // 繰返し呼んでも二重解放しない。子の破棄でプラグイン本体は終了しない。
  endpoint.dispose();
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  expect(manager.listOwned().some((record) => record.instanceId === assignment.instanceId)).toBe(
    true,
  );
});
