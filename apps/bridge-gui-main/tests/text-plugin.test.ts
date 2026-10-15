/**
 * テキスト割当て・中継・回収の統合検証。
 *
 * バックエンドを直接生成し、`world-client` を Node の `origin` 指定で動かして、
 * 実 WebSocket・既存 `ws`・yamux で候補検査・中継・切断・再割当てまでを通す。
 * 割当ては汎用管理操作（`assignPlugin`/`unassignPlugin`）、表示読取り・送信は
 * 本番 endpoint（backend が生成した登録表の endpoint 工場＋束縛個体限定の
 * 参照口）経由の中継で行い、新本番経路を通す。main は中継だけを担い、
 * 要求・通知の中身を解釈しない。
 * ワールド側は `{op:"shown", id}` を返す応答器であり、本文を返送しない。
 * 比較コード本文・送信本文は記録に残さない（照合は値の一致で行う）。
 * テストで使う本文はダミーのみである。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { TEXT_PORT_ID } from "bridge-plugin-text";
import type { TextSendResult } from "bridge-plugin-text";
import { TEXT_SESSION_ID, isTextShowRequest } from "bridge-plugin-text/contract";
import {
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
} from "bridge-plugin-diagnostic/contract";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import type { PluginRelayEvent } from "bridge-gui-contract/plugin-instance";
import type { PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import {
  TEXT_GET_STATE_METHOD,
  TEXT_SEND_TEXT_METHOD,
  isTextChildSnapshot,
  isTextSendResult,
  type TextChildSnapshot,
} from "bridge-plugin-text/gui-contract";

const TEST_ORIGIN = "https://gui-text-test.invalid";

/** 送信に使うダミー本文。表示・記録に残らないことを確かめる目印である。 */
const DUMMY_TEXT = "ダミー本文-表示に残さない-001";

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
 * 指定の論理名でセッションを作り、生存公開を待つ。
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

/** ワールド側の反映確認の操作名。契約の変更時はここも変わる。 */
const TEXT_SHOWN_OP = "shown" as const;

/**
 * ワールド側の反映確認の応答器を付ける。
 *
 * 表示要求の形状を確認してから同じ識別子で `{op:"shown", id}` を返し、
 * 本文は返送しない。不正な受信は送らず、中断の判定は PC 側に任せる。
 *
 * @param session - 応答するワールド側セッション。
 */
function respondShown(session: ReliableSession): void {
  session.onMessage((payload) => {
    if (isTextShowRequest(payload)) {
      void session.sendReliable({ op: TEXT_SHOWN_OP, id: payload.id });
    }
  });
}

/**
 * 束縛個体用の endpoint を組み立てる。本番配線（登録表の endpoint 工場＋
 * 管理層の束縛個体限定の参照口）で作り、通知は集めた emission で受け取る。
 *
 * @param backend - endpoint 工場と管理層の提供元。
 * @param instanceId - 束縛する実インスタンスの識別子。
 * @param emitted - 通知の集め先。
 * @returns 束縛個体用の endpoint。使い終わったら `dispose` すること。
 */
function textEndpointOf(
  backend: GuiBackend,
  instanceId: string,
  emitted: PluginRelayEvent[],
): PluginEndpoint {
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  const entry = backend.companionRegistry.getEntry("text");
  if (entry === undefined) throw new Error("テキストの登録が無い。");
  const ref = manager.createBoundRef("text", instanceId);
  return entry.createEndpoint(ref, {
    emit: (event) => {
      emitted.push(event);
    },
  });
}

/**
 * 束縛個体の限定表示を中継で読む。本文は含めない。
 */
async function readTextView(endpoint: PluginEndpoint): Promise<TextChildSnapshot> {
  const value = await endpoint.handleRequest({ method: TEXT_GET_STATE_METHOD, params: {} });
  if (!isTextChildSnapshot(value)) throw new Error("表示用 DTO の形状が不正である。");
  return value;
}

/**
 * 束縛個体の現割当てへ本文を中継で送る。子は本文だけを渡す。
 */
async function sendTextViaRelay(
  endpoint: PluginEndpoint,
  text: unknown,
): Promise<TextSendResult | { error: string }> {
  const value = await endpoint.handleRequest({ method: TEXT_SEND_TEXT_METHOD, params: { text } });
  if (isTextSendResult(value)) return value;
  const table = value as { error?: unknown };
  if (typeof table.error === "string") return { error: table.error };
  throw new Error("送信応答の形状が不正である。");
}

/**
 * テキスト種別の所有記録を取り出す。未割当てなら失敗する。
 */
function assignedTextOf(backend: GuiBackend): {
  instanceId: string;
  localSessionId: string;
  portId: string;
} {
  const record = backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "text");
  if (record === undefined) throw new Error("テキスト割当てが無い。");
  return {
    instanceId: record.instanceId,
    localSessionId: record.localSessionId,
    portId: record.portId,
  };
}

test("候補が無いときはテキスト割当てを拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  // セッション自体が無い場合。
  expect(() => backend.assignPlugin({ pluginKind: "text" })).toThrowError(RangeError);
  // テキスト表示用以外のセッションだけの場合。
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, ["other"]);
  expect(() => backend.assignPlugin({ pluginKind: "text" })).toThrowError(RangeError);
  expect(
    backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "text"),
  ).toBeUndefined();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
});

test("候補が一件のときは割り当てて中継の表示に反映する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID]);

  const assignment = backend.assignPlugin({ pluginKind: "text" });
  expect(assignment.pluginKind).toBe("text");
  expect(assignment.portId).toBe(TEXT_PORT_ID);
  const owned = backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "text");
  expect(owned?.localSessionId).toBe(assignment.localSessionId);
  expect(owned?.instanceId).toBe(assignment.instanceId);
  expect(owned?.phase).toBe("active");
  const emitted: PluginRelayEvent[] = [];
  const endpoint = textEndpointOf(backend, assignment.instanceId, emitted);
  try {
    const view = await readTextView(endpoint);
    expect(view.localSessionId).toBe(assignment.localSessionId);
    expect(view.canSend).toBe(true);
    expect(view.pendingId).toBeNull();
    expect(view.lastResult).toBeNull();
    expect(view.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  } finally {
    endpoint.dispose();
  }
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(1);

  // 割当て中の再要求は拒否する（多重割当てを作らない）。
  expect(() => backend.assignPlugin({ pluginKind: "text" })).toThrowError(RangeError);
});

test("候補が複数のときはテキスト割当てを拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  // 全接続を通じて一件だけを許すため、別接続で同名を作る。
  const first = await approveConnection(backend);
  await createSessions(backend, first, [TEXT_SESSION_ID]);
  const second = await approveConnection(backend);
  await createSessions(backend, second, [TEXT_SESSION_ID]);
  expect(backend.getSnapshot().sessions).toHaveLength(2);

  // 先着順・一件目の選択はしない。
  expect(() => backend.assignPlugin({ pluginKind: "text" })).toThrowError(RangeError);
  expect(
    backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "text"),
  ).toBeUndefined();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
});

test("正常な送信は反映確認で決着し通知が届く", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);

  const assignment = backend.assignPlugin({ pluginKind: "text" });
  const emitted: PluginRelayEvent[] = [];
  const endpoint = textEndpointOf(backend, assignment.instanceId, emitted);
  try {
    const result = await sendTextViaRelay(endpoint, DUMMY_TEXT);
    expect(result).toMatchObject({ status: "acknowledged" });
    // 本体の状態変更が endpoint の購読から通知に載る。本文は載せない。
    await waitForArrival(
      () =>
        emitted.some(
          (event) =>
            isTextChildSnapshot(event.payload) &&
            event.payload.lastResult?.status === "acknowledged",
        ),
      "反映確認の通知",
    );
    const view = await readTextView(endpoint);
    expect(view.pendingId).toBeNull();
    expect(view.canSend).toBe(true);
    expect(view.stats).toEqual({ attempts: 1, acknowledged: 1, unknown: 0 });
    // 本文は中継の表示・通知に残らない。
    expect(JSON.stringify(emitted)).not.toContain(DUMMY_TEXT);
    expect(JSON.stringify(view)).not.toContain(DUMMY_TEXT);
  } finally {
    endpoint.dispose();
  }
});

test("束縛外の中継と不正な本文は拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);
  const assignment = backend.assignPlugin({ pluginKind: "text" });

  // 束縛外の個体の endpoint 生成は失効として拒否する（所有検証は参照口が行う）。
  // 参照口の照合はホスト自身の結果であり、プラグインの投げた例外とは区別する。
  const emitted: PluginRelayEvent[] = [];
  expect(() => textEndpointOf(backend, "無い", emitted)).toThrowError(RangeError);
  // 送信できない本文は業務エラー値に載せ、試行に数えない。
  const endpoint = textEndpointOf(backend, assignment.instanceId, emitted);
  try {
    await expect(sendTextViaRelay(endpoint, "")).resolves.toMatchObject({
      error: expect.any(String),
    });
    await expect(sendTextViaRelay(endpoint, 123)).resolves.toMatchObject({
      error: expect.any(String),
    });
    const view = await readTextView(endpoint);
    expect(view.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
    expect(view.pendingId).toBeNull();
  } finally {
    endpoint.dispose();
  }
});

test("切断後は割当てが失効し再承認と再割当てが必要になる", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);
  const first = backend.assignPlugin({ pluginKind: "text" });
  const firstEmitted: PluginRelayEvent[] = [];
  const firstEndpoint = textEndpointOf(backend, first.instanceId, firstEmitted);
  try {
    await expect(sendTextViaRelay(firstEndpoint, DUMMY_TEXT)).resolves.toMatchObject({
      status: "acknowledged",
    });
  } finally {
    firstEndpoint.dispose();
  }

  // 運用切断で割当て表示が消え、生成分が回収される。
  const connectionId = backend.getSnapshot().connections[0]?.connectionId;
  if (connectionId === undefined) throw new Error("接続が無い。");
  backend.disconnectConnection({ connectionId });
  await waitForArrival(
    () =>
      backend.getSnapshot().sessions.length === 0 &&
      backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "text") ===
        undefined,
    "切断による割当て失効",
  );
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
  // 旧識別子の endpoint 生成は新しい割当てへ転送せず拒否する（所有検証は参照口が行う）。
  const staleEmitted: PluginRelayEvent[] = [];
  expect(() => textEndpointOf(backend, first.instanceId, staleEmitted)).toThrowError(RangeError);

  // 再接続は再承認が必要であり、同名でも旧割当てを引き継がない。
  const reprovider = await approveConnection(backend);
  const [resession] = await createSessions(backend, reprovider, [TEXT_SESSION_ID]);
  if (resession === undefined) throw new Error("再作成のセッションが無い。");
  expect(backend.getSnapshot().sessions[0]?.localSessionId).not.toBe(first.localSessionId);
  respondShown(resession);
  const second = backend.assignPlugin({ pluginKind: "text" });
  expect(second.instanceId).not.toBe(first.instanceId);
  const secondEmitted: PluginRelayEvent[] = [];
  const secondEndpoint = textEndpointOf(backend, second.instanceId, secondEmitted);
  try {
    const view = await readTextView(secondEndpoint);
    expect(view.lastResult).toBeNull();
    expect(view.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
    await expect(sendTextViaRelay(secondEndpoint, DUMMY_TEXT)).resolves.toMatchObject({
      status: "acknowledged",
    });
  } finally {
    secondEndpoint.dispose();
  }
  expect(JSON.stringify(backend.getSnapshot())).not.toContain(DUMMY_TEXT);
});

test("明示解除は割当て表示を消して中継できなくする", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID]);
  const assignment = backend.assignPlugin({ pluginKind: "text" });
  expect(assignedTextOf(backend).localSessionId).toBe(assignment.localSessionId);

  const released = backend.unassignPlugin({
    instanceId: assignment.instanceId,
    localSessionId: assignment.localSessionId,
    portId: assignment.portId,
  });
  expect(released).toEqual({ released: true, issues: [] });
  expect(
    backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === "text"),
  ).toBeUndefined();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
  const emitted: PluginRelayEvent[] = [];
  expect(() => textEndpointOf(backend, assignment.instanceId, emitted)).toThrowError(RangeError);
  // 回収済みの再解除は未解除として返す（履歴表は作らない）。
  expect(
    backend.unassignPlugin({
      instanceId: assignment.instanceId,
      localSessionId: assignment.localSessionId,
      portId: assignment.portId,
    }),
  ).toEqual({ released: false, issues: [] });
});

test("テキストはtextのみ・診断はdiag-echoとdiag-pingのみを対象にする", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [
    TEXT_SESSION_ID,
    DIAGNOSTIC_ECHO_SESSION_ID,
    DIAGNOSTIC_PING_SESSION_ID,
    UDP_SESSION_ID,
  ]);
  const sessions = backend.getSnapshot().sessions;
  const textSession = sessions.find((info) => info.sessionId === TEXT_SESSION_ID);
  const echoSession = sessions.find((info) => info.sessionId === DIAGNOSTIC_ECHO_SESSION_ID);
  const pingSession = sessions.find((info) => info.sessionId === DIAGNOSTIC_PING_SESSION_ID);
  const udpSession = sessions.find((info) => info.sessionId === UDP_SESSION_ID);
  if (
    textSession === undefined ||
    echoSession === undefined ||
    pingSession === undefined ||
    udpSession === undefined
  ) {
    throw new Error("検証用のセッションが無い。");
  }

  // テキスト表示用・UDP・診断外の論理名に診断は割り当てない。
  // 診断の allowlist（diag-echo／diag-ping）のみを通す。
  expect(() =>
    backend.assignPlugin({ pluginKind: "diagnostic", localSessionId: textSession.localSessionId }),
  ).toThrowError(RangeError);
  expect(() =>
    backend.assignPlugin({ pluginKind: "diagnostic", localSessionId: udpSession.localSessionId }),
  ).toThrowError(RangeError);
  // 診断の allowlist 内は診断の対象になる。
  const echoDiagnostics = backend.assignPlugin({
    pluginKind: "diagnostic",
    localSessionId: echoSession.localSessionId,
  });
  expect(echoDiagnostics.portId).toBe("diagnostic");
  const pingDiagnostics = backend.assignPlugin({
    pluginKind: "diagnostic",
    localSessionId: pingSession.localSessionId,
  });
  expect(pingDiagnostics.portId).toBe("diagnostic");
});
