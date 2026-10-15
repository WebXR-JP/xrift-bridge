/**
 * UDP割当て・限定表示・送信経路・監視の統合検証。
 *
 * バックエンドを直接生成し、`world-client` を Node の `origin` 指定で動かして、
 * 実 WebSocket・既存 `ws`・yamux で候補検査・割当て・表示読取りまでを通す。
 * 割当ては汎用管理操作（`assignPlugin`/`unassignPlugin`）、表示読取りと送信は
 * 本番 companion（backend が生成した登録表）経由で行い、新本番経路を通す。
 * 論理名は各契約の正本（`UDP_SESSION_ID`・診断・テキストの定数）で参照し、
 * 文字列の直書きを持たない。監視の周期駆動は偽時計と管理層の実物で確かめ、
 * 実時間待ちはしない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { UDP_PORT_ID, type UdpControlResult, type UdpPluginState } from "bridge-plugin-udp";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import type { UdpInstanceView } from "bridge-plugin-udp/gui-contract";
import { udpManagement } from "bridge-plugin-udp/gui";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import {
  DIAGNOSTIC_ECHO_SESSION_ID,
  DIAGNOSTIC_PING_SESSION_ID,
} from "bridge-plugin-diagnostic/contract";
import { createConnectionRequest, type ReliableSession, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import { registerBundledPlugins } from "../src/composition/bundled-plugins.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import type { PluginCompanion } from "bridge-gui-plugin-sdk/companion";

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
 * backend が生成した登録表から UDP companion を取り出す。
 *
 * 本番配線（manager→access→companion）で作られた記述子であり、
 * 表示読取り・送信の新本番経路である。
 */
function udpCompanionOf(backend: GuiBackend): PluginCompanion {
  const companion = backend.companionRegistry.get("udp");
  if (companion === undefined) throw new Error("UDP companion が無い。");
  return companion;
}

/**
 * 束縛個体の限定表示を読む。本文は含めない。
 */
function readUdpView(backend: GuiBackend, instanceId: string): UdpInstanceView {
  // ADR: `as` を使う理由は、汎用口が種別を問わない表示を返し、試験で
  // 束縛種別の具象表示を取り出すためである。根拠は、対応付けが同一種別の
  // 記述子で読み・付番を対にすることである。
  return udpCompanionOf(backend).readView(instanceId) as UdpInstanceView;
}

/**
 * 束縛個体へ子画面操作を送る。子は操作名と引数だけを渡す。
 */
function sendUdpViaCompanion(
  backend: GuiBackend,
  instanceId: string,
  params: unknown,
): Promise<UdpControlResult> {
  const send = udpCompanionOf(backend).send;
  if (send === undefined) throw new Error("UDP の送信口が無い。");
  // ADR: `as` を使う理由は、汎用口が `unknown` で返す解決値を試験で
  // 具象の制御結果として確かめるためである。根拠は、companion の固有操作が
  // UDP 制御の解決型を保つことである。
  return send(instanceId, params) as Promise<UdpControlResult>;
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

test("割当て後の射影は限定項目だけを含み他個体情報を載せない", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [TEXT_SESSION_ID, UDP_SESSION_ID]);
  const assignment = backend.assignPlugin({ pluginKind: "udp" });

  const view = readUdpView(backend, assignment.instanceId);
  expect(Object.keys(view).sort()).toEqual([
    "boundAddress",
    "canStart",
    "instanceId",
    "isRunning",
    "lastError",
    "localSessionId",
    "phase",
    "pluginId",
    "portId",
    "requestedBind",
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
});

test("companionの送信経路は開始と停止の二分岐で未知操作を拒否する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  await createSessions(backend, provider, [UDP_SESSION_ID]);
  const assignment = backend.assignPlugin({ pluginKind: "udp" });

  // 束縛外の個体には送らない（所有検証は同期的）。
  expect(() => udpCompanionOf(backend).readView("無い")).toThrowError(RangeError);
  expect(() => sendUdpViaCompanion(backend, "無い", { action: "stop" })).toThrowError(RangeError);
  // 閉じた二分岐の外は拒否する（引数の詳細検証の前に操作名で落とす）。
  expect(() =>
    sendUdpViaCompanion(backend, assignment.instanceId, { action: "erase" }),
  ).toThrowError(RangeError);
  expect(() => sendUdpViaCompanion(backend, assignment.instanceId, "start")).toThrowError(
    RangeError,
  );
  // 形状外の開始引数は固有操作まで届き理由付きの失敗で返す（拒否では表さない）。
  await expect(
    sendUdpViaCompanion(backend, assignment.instanceId, {
      action: "start",
      params: { bind: { address: "", port: 0 }, allowNonLoopback: false },
    }),
  ).resolves.toMatchObject({ ok: false, reason: "invalid-config" });
  // 非 loopback の確認不足も固有操作まで届き確認要求で返す。
  await expect(
    sendUdpViaCompanion(backend, assignment.instanceId, {
      action: "start",
      params: { bind: { address: "8.8.8.8", port: 50000 }, allowNonLoopback: false },
    }),
  ).resolves.toMatchObject({ ok: false, reason: "confirmation-required" });
  // 失敗した開始は待受けを作らず統計を動かさない。
  const afterFailed = readUdpView(backend, assignment.instanceId);
  expect(afterFailed.phase).toBe("stopped");
  expect(afterFailed.boundAddress).toBeNull();
  expect(afterFailed.stats.receivedDatagrams).toBe(0);
  // 待受けが無い停止は成功とする（冪等）。
  await expect(
    sendUdpViaCompanion(backend, assignment.instanceId, { action: "stop" }),
  ).resolves.toEqual({ ok: true });
});

/** 監視の指紋検証に使う UDP 状態の雛形。 */
function udpStateOf(overrides?: Partial<UdpPluginState>): UdpPluginState {
  return {
    phase: "stopped",
    requestedBind: null,
    boundAddress: null,
    stats: {
      receivedDatagrams: 0,
      receivedBytes: 0,
      forwardedDatagrams: 0,
      forwardedBytes: 0,
      droppedOversize: 0,
      droppedBusy: 0,
      droppedInvalidMetadata: 0,
      sendFailures: 0,
    },
    lastError: null,
    canStart: true,
    isRunning: false,
    ...overrides,
  };
}

test("監視は500ms周期で統計と段階とbindの変化を指紋で検出する", () => {
  if (udpManagement.observation.mode !== "poll") {
    throw new Error("UDP監視は周期照合であること。");
  }
  expect(udpManagement.observation.intervalMs).toBe(500);
  const fingerprint = udpManagement.observation.fingerprint;
  const base = udpStateOf();
  expect(fingerprint(base)).toBe(fingerprint(udpStateOf()));
  // 統計・段階・bind・異常のいずれの変化も見逃さない。
  expect(fingerprint(base)).not.toBe(
    fingerprint(
      udpStateOf({
        stats: { ...base.stats, receivedDatagrams: 1, receivedBytes: 60 },
      }),
    ),
  );
  expect(fingerprint(base)).not.toBe(fingerprint(udpStateOf({ phase: "running" })));
  expect(fingerprint(base)).not.toBe(
    fingerprint(udpStateOf({ requestedBind: { address: "127.0.0.1", port: 50000 } })),
  );
  expect(fingerprint(base)).not.toBe(
    fingerprint(
      udpStateOf({ boundAddress: { address: "127.0.0.1", port: 50000, family: "IPv4" } }),
    ),
  );
  expect(fingerprint(base)).not.toBe(fingerprint(udpStateOf({ lastError: "異常" })));
});

test("UDPの周期監視は偽時計の間隔で駆動する", () => {
  let state = udpStateOf();
  const assignments: Array<{ localSessionId: string; instanceId: string; portId: string }> = [];
  const intervals: number[] = [];
  const ticks: Array<() => void> = [];
  let changed = 0;
  const manager = new PluginInstanceManager({
    core: {
      createInstance: () => ({
        instanceId: "udp-1",
        pluginId: "udp",
        getState: () => state,
      }),
      assign: (localSessionId: string, instanceId: string, portId: string) => {
        assignments.push({ localSessionId, instanceId, portId });
      },
      unassign: () => {},
      removeInstance: () => {},
      listAssignments: () => [...assignments],
    } as never,
    sessions: {
      list: () => [
        {
          localSessionId: "local-9",
          connectionId: "connection-9",
          sessionId: UDP_SESSION_ID,
          capability: { kind: "reliable", direction: "bidirectional" },
          alive: true,
        },
      ],
      onEnded: () => () => {},
    },
    clock: {
      every: (intervalMs: number, tick: () => void) => {
        intervals.push(intervalMs);
        ticks.push(tick);
        return () => {};
      },
    },
    onChanged: () => {
      changed += 1;
    },
    onIssue: () => {},
  });
  try {
    manager.register(udpManagement);
    const binding = manager.assign("udp", { mode: "auto" });
    expect(binding.instanceId).toBe("udp-1");
    // 厳密な周期値は記述子の既定であり、実時間待ちなしに確かめる。
    expect(intervals).toEqual([500]);
    const tick = ticks[0];
    if (tick === undefined) throw new Error("周期処理が無い。");
    const before = changed;
    tick();
    expect(changed).toBe(before);
    state = udpStateOf({
      phase: "running",
      requestedBind: { address: "127.0.0.1", port: 50000 },
      boundAddress: { address: "127.0.0.1", port: 50000, family: "IPv4" },
      stats: { ...state.stats, receivedDatagrams: 1, receivedBytes: 60 },
      canStart: true,
      isRunning: true,
    });
    tick();
    expect(changed).toBe(before + 1);
  } finally {
    manager.close();
  }
});
