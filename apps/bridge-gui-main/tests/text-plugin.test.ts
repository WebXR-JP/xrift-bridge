/**
 * 固定テキスト表示の割当て・送信・回収の統合検証。
 *
 * バックエンドを直接生成し、`world-client` を Node の `origin` 指定で動かして、
 * 実 WebSocket・既存 `ws`・yamux で候補検査・送信・切断・再割当てまでを通す。
 * ワールド側は `{op:"shown", id}` を返す応答器であり、本文を返送しない。
 * 比較コード本文・送信本文は記録に残さない（照合は値の一致で行う）。
 * テストで使う本文はダミーのみである。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { TEXT_PORT_ID, TEXT_SESSION_ID, isTextShowRequest } from "bridge-app-core";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";

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
  const approved = backend.approvePairing({ requestId: pairing.requestId, code: pairing.code });
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
 * 割当て対象のローカル識別子を取り出す。未割当てなら失敗する。
 */
function assignedLocalSessionId(backend: GuiBackend): string {
  const localSessionId = backend.getSnapshot().text.localSessionId;
  if (localSessionId === null) throw new Error("テキスト割当てが無い。");
  return localSessionId;
}

test("候補が無いときはテキスト割当てを拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  // セッション自体が無い場合。
  expect(() => backend.assignText()).toThrowError(RangeError);
  // テキスト表示用以外のセッションだけの場合。
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, ["other"]);
  expect(() => backend.assignText()).toThrowError(RangeError);
  expect(backend.getSnapshot().text.localSessionId).toBeNull();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
});

test("候補が一件のときは割り当てて表示に反映する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID]);

  const assignment = backend.assignText();
  expect(assignment.portId).toBe(TEXT_PORT_ID);
  const text = backend.getSnapshot().text;
  expect(text.localSessionId).toBe(assignment.localSessionId);
  expect(text.instanceId).toBe(assignment.instanceId);
  expect(text.canSend).toBe(true);
  expect(text.pendingId).toBeNull();
  expect(text.lastResult).toBeNull();
  expect(text.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(1);

  // 割当て中の再要求は拒否する（多重割当てを作らない）。
  expect(() => backend.assignText()).toThrowError(RangeError);
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
  expect(() => backend.assignText()).toThrowError(RangeError);
  expect(backend.getSnapshot().text.localSessionId).toBeNull();
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
    const assignment = backend.assignText();
    const before = backend.getSnapshot().revision;
    const result = await backend.sendText({
      localSessionId: assignment.localSessionId,
      instanceId: assignment.instanceId,
      text: DUMMY_TEXT,
    });
    expect(result.status).toBe("acknowledged");
    await waitForArrival(
      () => backend.getSnapshot().text.lastResult?.status === "acknowledged",
      "反映確認の表示反映",
    );
    const text = backend.getSnapshot().text;
    expect(text.pendingId).toBeNull();
    expect(text.canSend).toBe(true);
    expect(text.lastResult).toEqual(result);
    expect(text.stats).toEqual({ attempts: 1, acknowledged: 1, unknown: 0 });
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

test("識別子が一致しない送信と不正な本文は拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);
  const assignment = backend.assignText();

  // 古い・誤った識別子は新しい割当てへ転送しない。
  expect(() =>
    backend.sendText({
      localSessionId: assignment.localSessionId,
      instanceId: "無い",
      text: DUMMY_TEXT,
    }),
  ).toThrowError(RangeError);
  expect(() =>
    backend.sendText({
      localSessionId: "無い",
      instanceId: assignment.instanceId,
      text: DUMMY_TEXT,
    }),
  ).toThrowError(RangeError);
  // 送信できない本文は送らず、試行に数えない。
  await expect(
    backend.sendText({
      localSessionId: assignment.localSessionId,
      instanceId: assignment.instanceId,
      text: "",
    }),
  ).rejects.toThrowError(RangeError);
  expect(() =>
    backend.sendText({
      localSessionId: assignment.localSessionId,
      instanceId: assignment.instanceId,
      text: 123,
    }),
  ).toThrowError(RangeError);
  const text = backend.getSnapshot().text;
  expect(text.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  expect(text.pendingId).toBeNull();
});

test("切断後は割当てが失効し再承認と再割当てが必要になる", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const [session] = await createSessions(backend, provider, [TEXT_SESSION_ID]);
  if (session === undefined) throw new Error("テキスト用セッションが無い。");
  respondShown(session);
  const first = backend.assignText();
  await expect(
    backend.sendText({
      localSessionId: first.localSessionId,
      instanceId: first.instanceId,
      text: DUMMY_TEXT,
    }),
  ).resolves.toMatchObject({ status: "acknowledged" });

  // 運用切断で割当て表示が消え、生成分が回収される。
  const connectionId = backend.getSnapshot().connections[0]?.connectionId;
  if (connectionId === undefined) throw new Error("接続が無い。");
  backend.disconnectConnection({ connectionId });
  await waitForArrival(
    () =>
      backend.getSnapshot().sessions.length === 0 &&
      backend.getSnapshot().text.localSessionId === null,
    "切断による割当て失効",
  );
  expect(backend.getSnapshot().text.instanceId).toBeNull();
  expect(backend.getSnapshot().text.canSend).toBe(false);
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
  // 旧識別子の送信は新しい割当てへ転送しない。
  expect(() =>
    backend.sendText({
      localSessionId: first.localSessionId,
      instanceId: first.instanceId,
      text: DUMMY_TEXT,
    }),
  ).toThrowError(RangeError);

  // 再接続は再承認が必要であり、同名でも旧割当てを引き継がない。
  const reprovider = await approveConnection(backend);
  const [resession] = await createSessions(backend, reprovider, [TEXT_SESSION_ID]);
  if (resession === undefined) throw new Error("再作成のセッションが無い。");
  expect(backend.getSnapshot().sessions[0]?.localSessionId).not.toBe(first.localSessionId);
  respondShown(resession);
  const second = backend.assignText();
  expect(second.instanceId).not.toBe(first.instanceId);
  const text = backend.getSnapshot().text;
  expect(text.lastResult).toBeNull();
  expect(text.stats).toEqual({ attempts: 0, acknowledged: 0, unknown: 0 });
  await expect(
    backend.sendText({
      localSessionId: second.localSessionId,
      instanceId: second.instanceId,
      text: DUMMY_TEXT,
    }),
  ).resolves.toMatchObject({ status: "acknowledged" });
  expect(JSON.stringify(backend.getSnapshot())).not.toContain(DUMMY_TEXT);
});

test("明示解除は割当て表示を消して送信できなくする", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID]);
  const assignment = backend.assignText();
  expect(assignedLocalSessionId(backend)).toBe(assignment.localSessionId);

  expect(backend.unassignText()).toEqual({ ok: true });
  expect(backend.getSnapshot().text.localSessionId).toBeNull();
  expect(backend.getSnapshot().text.instanceId).toBeNull();
  expect(backend.getSnapshot().plugins.assignments).toHaveLength(0);
  expect(() =>
    backend.sendText({
      localSessionId: assignment.localSessionId,
      instanceId: assignment.instanceId,
      text: DUMMY_TEXT,
    }),
  ).toThrowError(RangeError);
  // 未割当ての再解除は拒否する。
  expect(() => backend.unassignText()).toThrowError(RangeError);
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
    backend.assignDiagnostics({ localSessionId: textSession.localSessionId }),
  ).toThrowError(RangeError);
  // 他用途のセッションへの診断は通る。
  const diagnostics = backend.assignDiagnostics({ localSessionId: otherSession.localSessionId });
  expect(diagnostics.portId).toBe("diagnostic");
  // 診断済みがあってもテキスト候補の一件判定は崩れない。
  const assignment = backend.assignText();
  expect(assignment.localSessionId).toBe(textSession.localSessionId);
  expect(assignment.portId).toBe(TEXT_PORT_ID);
});
