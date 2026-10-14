/**
 * テキスト割当て・送信・回収の統合検証。
 *
 * バックエンドを直接生成し、`world-client` を Node の `origin` 指定で動かして、
 * 実 WebSocket・既存 `ws`・yamux で候補検査・送信・切断・再割当てまでを通す。
 * 割当ては汎用管理操作（`assignPlugin`/`unassignPlugin`）、送信と表示読取りは
 * 本番 companion（backend が生成した登録表）経由で行い、新本番経路を通す。
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
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import { registerBundledPlugins } from "../src/composition/bundled-plugins.ts";
import type { PluginCompanion } from "bridge-gui-plugin-sdk/companion";
import type { TextInstanceView } from "bridge-plugin-text/gui-contract";

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
 * backend が生成した登録表からテキスト companion を取り出す。
 *
 * 本番配線（manager→access→companion）で作られた記述子であり、
 * 送信・表示読取りの新本番経路である。
 */
function textCompanionOf(backend: GuiBackend): PluginCompanion {
  const companion = backend.companionRegistry.get("text");
  if (companion === undefined) throw new Error("テキスト companion が無い。");
  return companion;
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

/**
 * 束縛個体の限定表示を読む。本文は含めない。
 */
function readTextView(backend: GuiBackend, instanceId: string): TextInstanceView {
  // ADR: `as` を使う理由は、汎用口が種別を問わない表示を返し、試験で
  // 束縛種別の具象表示を取り出すためである。根拠は、対応付けが同一種別の
  // 記述子で読み・付番を対にすることである。
  return textCompanionOf(backend).readView(instanceId) as TextInstanceView;
}

/**
 * 束縛個体の現割当てへ本文を送る。子は本文だけを渡す。
 */
function sendTextViaCompanion(
  backend: GuiBackend,
  instanceId: string,
  text: unknown,
): Promise<TextSendResult> {
  const send = textCompanionOf(backend).send;
  if (send === undefined) throw new Error("テキストの送信口が無い。");
  // ADR: `as` を使う理由は、汎用口が `unknown` で返す解決値を試験で
  // 具象の送信結果として確かめるためである。根拠は、companion の固有操作が
  // テキスト送信の解決型を保つことである。
  return send(instanceId, { text }) as Promise<TextSendResult>;
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

test("候補が一件のときは割り当てて表示に反映する", async () => {
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
  const view = readTextView(backend, assignment.instanceId);
  expect(view.localSessionId).toBe(assignment.localSessionId);
  expect(view.canSend).toBe(true);
  expect(view.pendingId).toBeNull();
  expect(view.lastResult).toBeNull();
  expect(view.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
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

test("正常な送信は反映確認で決着し表示が進む", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);

  const revisions: number[] = [];
  const unsubscribe = backend.onStateChanged((message) => {
    revisions.push(message.revision);
  });
  try {
    const assignment = backend.assignPlugin({ pluginKind: "text" });
    const before = backend.getSnapshot().revision;
    const result = await sendTextViaCompanion(backend, assignment.instanceId, DUMMY_TEXT);
    expect(result.status).toBe("acknowledged");
    await waitForArrival(
      () => readTextView(backend, assignment.instanceId).lastResult?.status === "acknowledged",
      "反映確認の表示反映",
    );
    const view = readTextView(backend, assignment.instanceId);
    expect(view.pendingId).toBeNull();
    expect(view.canSend).toBe(true);
    expect(view.lastResult).toEqual(result);
    expect(view.stats).toEqual({ attempts: 1, acknowledged: 1, unknown: 0 });
    // 状態通知が改訂を進めている（購読経路の結線）。
    expect(backend.getSnapshot().revision).toBeGreaterThan(before);
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions[revisions.length - 1]).toBe(backend.getSnapshot().revision);
    // 本文は snapshot に残らない。
    expect(JSON.stringify(backend.getSnapshot())).not.toContain(DUMMY_TEXT);
  } finally {
    unsubscribe();
  }
});

test("束縛外の送信と不正な本文は拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);
  const assignment = backend.assignPlugin({ pluginKind: "text" });

  // 束縛外の個体には送らない（所有検証は同期的）。
  expect(() => textCompanionOf(backend).readView("無い")).toThrowError(RangeError);
  expect(() => sendTextViaCompanion(backend, "無い", DUMMY_TEXT)).toThrowError(RangeError);
  // 送信できない本文は送らず、試行に数えない。
  await expect(sendTextViaCompanion(backend, assignment.instanceId, "")).rejects.toThrowError(
    RangeError,
  );
  expect(() => sendTextViaCompanion(backend, assignment.instanceId, 123)).toThrowError(RangeError);
  const view = readTextView(backend, assignment.instanceId);
  expect(view.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  expect(view.pendingId).toBeNull();
});

test("切断後は割当てが失効し再承認と再割当てが必要になる", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);
  const first = backend.assignPlugin({ pluginKind: "text" });
  await expect(sendTextViaCompanion(backend, first.instanceId, DUMMY_TEXT)).resolves.toMatchObject({
    status: "acknowledged",
  });

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
  // 旧識別子の送信は新しい割当てへ転送しない（所有検証は同期的）。
  expect(() => sendTextViaCompanion(backend, first.instanceId, DUMMY_TEXT)).toThrowError(
    RangeError,
  );

  // 再接続は再承認が必要であり、同名でも旧割当てを引き継がない。
  const reprovider = await approveConnection(backend);
  const [resession] = await createSessions(backend, reprovider, [TEXT_SESSION_ID]);
  if (resession === undefined) throw new Error("再作成のセッションが無い。");
  expect(backend.getSnapshot().sessions[0]?.localSessionId).not.toBe(first.localSessionId);
  respondShown(resession);
  const second = backend.assignPlugin({ pluginKind: "text" });
  expect(second.instanceId).not.toBe(first.instanceId);
  const view = readTextView(backend, second.instanceId);
  expect(view.lastResult).toBeNull();
  expect(view.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  await expect(sendTextViaCompanion(backend, second.instanceId, DUMMY_TEXT)).resolves.toMatchObject(
    { status: "acknowledged" },
  );
  expect(JSON.stringify(backend.getSnapshot())).not.toContain(DUMMY_TEXT);
});

test("明示解除は割当て表示を消して送信できなくする", async () => {
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
  expect(() => sendTextViaCompanion(backend, assignment.instanceId, DUMMY_TEXT)).toThrowError(
    RangeError,
  );
  // 回収済みの再解除は未解除として返す（履歴表は作らない）。
  expect(
    backend.unassignPlugin({
      instanceId: assignment.instanceId,
      localSessionId: assignment.localSessionId,
      portId: assignment.portId,
    }),
  ).toEqual({ released: false, issues: [] });
});

test("診断とテキストは互いを対象外にする", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID, "other"]);
  const sessions = backend.getSnapshot().sessions;
  const textSession = sessions.find((info) => info.sessionId === TEXT_SESSION_ID);
  const otherSession = sessions.find((info) => info.sessionId === "other");
  if (textSession === undefined || otherSession === undefined) {
    throw new Error("検証用のセッションが無い。");
  }

  // テキスト表示用のセッションに診断は割り当てない。
  expect(() =>
    backend.assignPlugin({ pluginKind: "diagnostic", localSessionId: textSession.localSessionId }),
  ).toThrowError(RangeError);
  // 他用途のセッションへの診断は通る。
  const diagnostics = backend.assignPlugin({
    pluginKind: "diagnostic",
    localSessionId: otherSession.localSessionId,
  });
  expect(diagnostics.portId).toBe("diagnostic");
  // 診断済みがあってもテキスト候補の一件判定は崩れない。
  const assignment = backend.assignPlugin({ pluginKind: "text" });
  expect(assignment.localSessionId).toBe(textSession.localSessionId);
  expect(assignment.portId).toBe(TEXT_PORT_ID);
});
