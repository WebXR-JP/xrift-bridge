/**
 * UDP受信転送プラグインの単体試験。
 *
 * 偽サーバー管理境界と基盤・偽ソケットを組み合わせ、開始・停止・再 bind、
 * bind 失敗の error 確定、開始途中の停止・破棄の取消優先、世代による遅延
 * 配送の無視、送信未完了中の破棄、上限超過・不正送信元の破棄、失効後の
 * 転送禁止、非 loopback の確認必須、統計の集計、状態購読の通知を確かめる。
 * payload 本文を状態に残さないことも確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createBridgeAppCore, type BridgeAppCore } from "bridge-app-core/core";
import { wrapServerSession } from "bridge-app-core/core";
import type { AssignedSession, PluginInstanceHandle } from "bridge-app-core/core";
import {
  UDP_PORT_ID,
  createUdpPlugin,
  udpPlugin,
  type UdpPluginOperations,
  type UdpPluginState,
  type UdpStartParams,
} from "../src/plugin.ts";
import { UDP_SESSION_ID, decodeUdpData, isUdpDatagramMessage } from "../src/contract.ts";
import {
  偽サーバー,
  偽ソケット生成口,
  偽Udp受信ソケット,
  type 偽ReliableSession,
} from "./fakes.ts";

const cores: BridgeAppCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close();
  }
});

/** 自動確定（要求通り）の偽ソケットを作る。 */
function 自動ソケット(): 偽Udp受信ソケット {
  const socket = new 偽Udp受信ソケット();
  socket.echoBind = true;
  return socket;
}

/** UDPインスタンスを生成し、reliable セッションを割り当てる。 */
function udp割当て(
  fake: 偽サーバー,
  sessionId: string,
  supply: 偽Udp受信ソケット[] = [自動ソケット()],
): {
  readonly core: BridgeAppCore;
  readonly handle: PluginInstanceHandle<UdpPluginState, UdpPluginOperations>;
  readonly ops: UdpPluginOperations;
  readonly localSessionId: string;
  readonly session: 偽ReliableSession;
  readonly 生成口: 偽ソケット生成口;
} {
  const 生成口 = new 偽ソケット生成口(supply);
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const handle = core.createInstance(createUdpPlugin({ socketFactory: 生成口.factory() }));
  const started = fake.開始Reliable(sessionId);
  core.assign(started.info.localSessionId, handle.instanceId, UDP_PORT_ID);
  const ops = handle.getOperations?.();
  if (ops === undefined) throw new Error("UDP操作口がない。");
  return {
    core,
    handle,
    ops,
    localSessionId: started.info.localSessionId,
    session: started.session,
    生成口,
  };
}

/** loopback への開始引数を作る。 */
function loopback開始(port: number): UdpStartParams {
  return { bind: { address: "127.0.0.1", port }, allowNonLoopback: false };
}

/** マイクロタスクを流して送受信の完了を待つ。 */
function 完了待ち(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("開始すると指定先へbindし実行中になる", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  expect(handle.getState().phase).toBe("stopped");
  expect(handle.getState().canStart).toBe(true);
  const 結果 = await ops.start(loopback開始(50001));
  expect(結果).toEqual({ ok: true });
  expect(生成口.handedOut).toHaveLength(1);
  expect(生成口.handedOut[0]?.bindCalls).toEqual([{ address: "127.0.0.1", port: 50001 }]);
  expect(handle.getState()).toMatchObject({
    phase: "running",
    requestedBind: { address: "127.0.0.1", port: 50001 },
    boundAddress: { address: "127.0.0.1", port: 50001 },
    canStart: true,
    isRunning: true,
    lastError: null,
  });
});

test("停止すると閉塞して停止中になる", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  expect(await ops.stop()).toEqual({ ok: true });
  expect(socket.closeCalls).toBe(1);
  expect(handle.getState()).toMatchObject({
    phase: "stopped",
    boundAddress: null,
    canStart: true,
    isRunning: false,
  });
  // 停止の重複は成功する（冪等）。
  expect(await ops.stop()).toEqual({ ok: true });
  expect(socket.closeCalls).toBe(1);
});

test("bind失敗はerrorになり自動再試行しない", async () => {
  const fake = new 偽サーバー();
  const 失敗ソケット = new 偽Udp受信ソケット();
  失敗ソケット.autoBind = new Error("EADDRINUSE: address already in use");
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID, [失敗ソケット]);

  const 結果 = await ops.start(loopback開始(50001));
  expect(結果.ok).toBe(false);
  if (結果.ok) throw new Error("成功してはならない。");
  expect(結果.reason).toBe("bind-failed");
  expect(handle.getState().phase).toBe("error");
  expect(handle.getState().boundAddress).toBe(null);
  expect(handle.getState().lastError).toMatch(/EADDRINUSE/);
  expect(handle.getState().canStart).toBe(true);
  // 自動 rollback・自動再試行はしない（生成は一度だけ）。
  expect(生成口.handedOut).toHaveLength(1);
});

test("errorから停止して再開始できる", async () => {
  const fake = new 偽サーバー();
  const 失敗ソケット = new 偽Udp受信ソケット();
  失敗ソケット.autoBind = new Error("EADDRINUSE: address already in use");
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID, [失敗ソケット, 自動ソケット()]);

  await ops.start(loopback開始(50001));
  expect(handle.getState().phase).toBe("error");
  expect(await ops.stop()).toEqual({ ok: true });
  expect(handle.getState().phase).toBe("stopped");
  expect(await ops.start(loopback開始(50002))).toEqual({ ok: true });
  expect(handle.getState().phase).toBe("running");
  expect(生成口.handedOut).toHaveLength(2);
});

test("稼働中の再開始は旧閉塞完了後に新bindする", async () => {
  const fake = new 偽サーバー();
  const 旧 = 自動ソケット();
  const 新 = 自動ソケット();
  const 順序: string[] = [];
  const 元close = 旧.close.bind(旧);
  旧.close = () => {
    順序.push("旧閉塞");
    return 元close();
  };
  const 元bind = 新.bind.bind(新);
  新.bind = (address, port) => {
    順序.push("新bind");
    return 元bind(address, port);
  };
  const { handle, ops } = udp割当て(fake, UDP_SESSION_ID, [旧, 新]);

  await ops.start(loopback開始(50001));
  expect(handle.getState().phase).toBe("running");
  expect(await ops.start(loopback開始(50002))).toEqual({ ok: true });
  // 旧→新の順序厳守（旧閉塞の完了を待ってから新 bind）。
  expect(順序).toEqual(["旧閉塞", "新bind"]);
  expect(旧.closeCalls).toBe(1);
  expect(handle.getState()).toMatchObject({
    phase: "running",
    requestedBind: { address: "127.0.0.1", port: 50002 },
  });
  expect(新.bindCalls).toEqual([{ address: "127.0.0.1", port: 50002 }]);
});

test("開始途中の二重開始は拒否される", async () => {
  const fake = new 偽サーバー();
  const 手動 = new 偽Udp受信ソケット();
  手動.echoBind = false;
  const { handle, ops } = udp割当て(fake, UDP_SESSION_ID, [手動, 自動ソケット()]);

  const 一件目 = ops.start(loopback開始(50001));
  expect(handle.getState().phase).toBe("starting");
  // 手続き中の新規 start は拒否する。
  const 二件目 = await ops.start(loopback開始(50002));
  expect(二件目.ok).toBe(false);
  if (二件目.ok) throw new Error("成功してはならない。");
  expect(二件目.reason).toBe("busy");
  手動.bind成功();
  expect(await 一件目).toEqual({ ok: true });
  expect(handle.getState().phase).toBe("running");
  expect(手動.bindCalls).toEqual([{ address: "127.0.0.1", port: 50001 }]);
});

test("開始途中の停止は取消優先で停止する", async () => {
  const fake = new 偽サーバー();
  const 手動 = new 偽Udp受信ソケット();
  手動.echoBind = false;
  const { handle, ops } = udp割当て(fake, UDP_SESSION_ID, [手動]);

  const 開始約束 = ops.start(loopback開始(50001));
  expect(handle.getState().phase).toBe("starting");
  expect(await ops.stop()).toEqual({ ok: true });
  // 開始側は bind の成否に関わらず取り消される。
  手動.bind失敗(new Error("EADDRINUSE: address already in use"));
  const 開始結果 = await 開始約束;
  expect(開始結果.ok).toBe(false);
  if (開始結果.ok) throw new Error("成功してはならない。");
  expect(開始結果.reason).toBe("cancelled");
  expect(handle.getState().phase).toBe("stopped");
  expect(handle.getState().boundAddress).toBe(null);
  expect(手動.closeCalls).toBeGreaterThanOrEqual(1);
});

test("開始途中の破棄は取り消す", async () => {
  const fake = new 偽サーバー();
  const 手動 = new 偽Udp受信ソケット();
  手動.echoBind = false;
  const { core, handle, ops } = udp割当て(fake, UDP_SESSION_ID, [手動]);

  const 開始約束 = ops.start(loopback開始(50001));
  core.removeInstance(handle.instanceId);
  手動.bind成功();
  const 開始結果 = await 開始約束;
  expect(開始結果.ok).toBe(false);
  if (開始結果.ok) throw new Error("成功してはならない。");
  expect(開始結果.reason).toBe("cancelled");
  expect(手動.closeCalls).toBeGreaterThanOrEqual(1);
});

test("送信未完了中の新着は符号化せず破棄される", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, session, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  // 送信完了を待たずに連続受信する（送信同時一件・待機域なし）。
  socket.受信(new Uint8Array([1, 2, 3]));
  socket.受信(new Uint8Array([4, 5, 6]));
  await 完了待ち();
  expect(session.sent).toHaveLength(1);
  expect(handle.getState().stats).toMatchObject({
    receivedDatagrams: 2,
    receivedBytes: 6,
    forwardedDatagrams: 1,
    forwardedBytes: 3,
    droppedBusy: 1,
    sendFailures: 0,
  });
});

test("上限超過は破棄され切断しない", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, session, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  socket.受信(new Uint8Array(48_001));
  await 完了待ち();
  expect(session.sent).toHaveLength(0);
  expect(session.isAlive).toBe(true);
  expect(handle.getState().phase).toBe("running");
  expect(handle.getState().stats).toMatchObject({ receivedDatagrams: 1, droppedOversize: 1 });
});

test("上限ちょうどは転送され形状が契約に合う", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, session, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  const 受信 = new Uint8Array(48_000);
  受信[0] = 0xff;
  受信[47_999] = 0x01;
  socket.受信(受信, { address: "127.0.0.1", port: 40001 });
  await 完了待ち();
  expect(session.sent).toHaveLength(1);
  const 転送 = session.sent[0];
  expect(isUdpDatagramMessage(転送)).toBe(true);
  if (!isUdpDatagramMessage(転送)) throw new Error("転送形状ではない。");
  expect(転送.op).toBe("datagram");
  expect(転送.source).toEqual({ address: "127.0.0.1", port: 40001 });
  expect(decodeUdpData(転送.dataBase64)).toEqual(受信);
  expect(handle.getState().stats).toMatchObject({
    forwardedDatagrams: 1,
    forwardedBytes: 48_000,
  });
});

test("不正な送信元は破棄される", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, session, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  socket.受信(new Uint8Array([1]), { address: "", port: 40000 });
  socket.受信(new Uint8Array([2]), { address: "127.0.0.1", port: 70000 });
  await 完了待ち();
  expect(session.sent).toHaveLength(0);
  expect(handle.getState().stats).toMatchObject({
    receivedDatagrams: 2,
    droppedInvalidMetadata: 2,
  });
});

test("古いソケットの遅延配送は無視される", async () => {
  const fake = new 偽サーバー();
  const 旧 = 自動ソケット();
  const 新 = 自動ソケット();
  const { handle, ops, session } = udp割当て(fake, UDP_SESSION_ID, [旧, 新]);

  await ops.start(loopback開始(50001));
  await ops.start(loopback開始(50002));
  // 旧ソケットの遅延配送は世代照合で無視する（数えない）。
  旧.受信(new Uint8Array([9, 9, 9]));
  await 完了待ち();
  expect(session.sent).toHaveLength(0);
  expect(handle.getState().stats.receivedDatagrams).toBe(0);
  新.受信(new Uint8Array([1]));
  await 完了待ち();
  expect(session.sent).toHaveLength(1);
  expect(handle.getState().stats.receivedDatagrams).toBe(1);
});

test("失効（解除）後は受信しても転送しない", async () => {
  const fake = new 偽サーバー();
  const { core, handle, ops, session, localSessionId, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  // 失効前の受信は転送されることを確かめる。
  socket.受信(new Uint8Array([0]));
  await 完了待ち();
  expect(session.sent).toHaveLength(1);
  expect(handle.getState().stats).toMatchObject({ receivedDatagrams: 1, sendFailures: 0 });
  // 失効通知で転送を即時停止し、ソケット閉塞を開始する。
  core.unassign(localSessionId);
  expect(socket.closeCalls).toBe(1);
  expect(handle.getState()).toMatchObject({ phase: "stopped", boundAddress: null });
  socket.受信(new Uint8Array([1, 2, 3]));
  await 完了待ち();
  // 失効後の受信は世代不一致で無視され、受信にも送信失敗にも数えず転送しない。
  expect(session.sent).toHaveLength(1);
  expect(handle.getState().stats).toMatchObject({ receivedDatagrams: 1, sendFailures: 0 });
});

test("セッション終了後はソケットを閉じて転送しない", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, session, localSessionId, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  fake.終了(localSessionId, { kind: "closed" });
  expect(socket.closeCalls).toBe(1);
  expect(handle.getState()).toMatchObject({ phase: "stopped", boundAddress: null });
  expect(handle.getState().lastError).not.toBe(null);
  expect(handle.getState().canStart).toBe(false);
  socket.受信(new Uint8Array([1, 2, 3]));
  await 完了待ち();
  expect(session.sent).toHaveLength(0);
  expect(handle.getState().stats.receivedDatagrams).toBe(0);
});

test("非loopbackは確認なしで開始できない", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  const 結果 = await ops.start({
    bind: { address: "192.168.0.2", port: 50001 },
    allowNonLoopback: false,
  });
  expect(結果.ok).toBe(false);
  if (結果.ok) throw new Error("成功してはならない。");
  expect(結果.reason).toBe("confirmation-required");
  expect(生成口.handedOut).toHaveLength(0);
  expect(handle.getState().phase).toBe("stopped");
});

test("非loopbackは確認ありで開始できる", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  expect(
    await ops.start({ bind: { address: "192.168.0.2", port: 50001 }, allowNonLoopback: true }),
  ).toEqual({ ok: true });
  expect(生成口.createdOptions).toEqual([{ type: "udp4", ipv6Only: true }]);
  expect(handle.getState().phase).toBe("running");
});

test("IPv6はipv6Onlyのudp6でbindする", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  expect(
    await ops.start({ bind: { address: "::1", port: 50001 }, allowNonLoopback: false }),
  ).toEqual({ ok: true });
  expect(生成口.createdOptions).toEqual([{ type: "udp6", ipv6Only: true }]);
  expect(handle.getState().boundAddress?.family).toBe("IPv6");
});

test("不正な設定はinvalid-configになる", async () => {
  const fake = new 偽サーバー();
  const { handle, ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  const 不正引数: unknown[] = [
    { bind: { address: "localhost", port: 50001 }, allowNonLoopback: false },
    { bind: { address: "", port: 50001 }, allowNonLoopback: false },
    { bind: { address: "127.0.0.1", port: 0 }, allowNonLoopback: false },
    { bind: { address: "127.0.0.1", port: 65536 }, allowNonLoopback: false },
    { bind: { address: "127.0.0.1", port: 1.5 }, allowNonLoopback: false },
    { bind: { address: "127.0.0.1" }, allowNonLoopback: false },
    { bind: { address: "127.0.0.1", port: 50001 } },
    { bind: { address: "127.0.0.1", port: 50001 }, allowNonLoopback: "yes" },
    null,
    "文字列",
  ];
  for (const 引数 of 不正引数) {
    // ADR: `as` は実行時検証の試験のための境界突破であり、不正引数の拒否を確かめる。
    const 結果 = await ops.start(引数 as UdpStartParams);
    expect(結果.ok).toBe(false);
    if (結果.ok) throw new Error("成功してはならない。");
    expect(結果.reason).toBe("invalid-config");
  }
  expect(生成口.handedOut).toHaveLength(0);
  expect(handle.getState().phase).toBe("stopped");
});

test("未割当てでは開始できない", async () => {
  const 生成口 = new 偽ソケット生成口([自動ソケット()]);
  const instance = createUdpPlugin({ socketFactory: 生成口.factory() }).create();
  try {
    expect(instance.getState().phase).toBe("unassigned");
    expect(instance.getState().canStart).toBe(false);
    const ops = instance.getOperations?.();
    if (ops === undefined) throw new Error("UDP操作口がない。");
    const 結果 = await ops.start(loopback開始(50001));
    expect(結果.ok).toBe(false);
    if (結果.ok) throw new Error("成功してはならない。");
    expect(結果.reason).toBe("cancelled");
    expect(生成口.handedOut).toHaveLength(0);
  } finally {
    instance.dispose();
  }
});

test("破棄後は操作できない", async () => {
  const instance = udpPlugin.create();
  instance.dispose();
  const 破棄後操作口 = instance.getOperations?.();
  if (破棄後操作口 === undefined) throw new Error("UDP操作口がない。");
  const 開始結果 = await 破棄後操作口.start(loopback開始(50001));
  expect(開始結果.ok).toBe(false);
  if (開始結果.ok) throw new Error("成功してはならない。");
  expect(開始結果.reason).toBe("cancelled");
  const 停止結果 = await 破棄後操作口.stop();
  expect(停止結果.ok).toBe(false);
  if (停止結果.ok) throw new Error("成功してはならない。");
  expect(停止結果.reason).toBe("cancelled");
  expect(() => 破棄後操作口.onStateChanged(() => {})).toThrow(RangeError);

  // 割当て済み個体の破棄後は送信と購読登録ができない。
  const fake2 = new 偽サーバー();
  const 割当て2 = udp割当て(fake2, UDP_SESSION_ID);
  割当て2.core.removeInstance(割当て2.handle.instanceId);
  await expect(割当て2.ops.start(loopback開始(50001))).resolves.toMatchObject({
    ok: false,
    reason: "cancelled",
  });
  expect(() => 割当て2.ops.onStateChanged(() => {})).toThrow(RangeError);

  // 実行中 bind 済み状態からの破棄後は `boundAddress` が `null` である
  // （待受け中でなければ `null` の不変条件）。
  const fake3 = new 偽サーバー();
  const 割当て3 = udp割当て(fake3, UDP_SESSION_ID);
  expect(await 割当て3.ops.start(loopback開始(50001))).toEqual({ ok: true });
  expect(割当て3.handle.getState().boundAddress).not.toBe(null);
  割当て3.core.removeInstance(割当て3.handle.instanceId);
  expect(割当て3.handle.getState().phase).toBe("disposed");
  expect(割当て3.handle.getState().boundAddress).toBe(null);
});

test("状態購読で変化が通知される", async () => {
  const fake = new 偽サーバー();
  const { ops, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  const 届いた: UdpPluginState[] = [];
  const 購読解除 = ops.onStateChanged((状態) => {
    届いた.push(状態);
  });
  // 購読者の例外は隔離し、他の購読者へは届ける。
  ops.onStateChanged(() => {
    throw new Error("購読者の失敗");
  });

  await ops.start(loopback開始(50001));
  expect(届いた.at(-1)?.phase).toBe("running");
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  socket.受信(new Uint8Array([1]));
  await 完了待ち();
  expect(届いた.at(-1)?.stats.receivedDatagrams).toBe(1);
  await ops.stop();
  expect(届いた.at(-1)?.phase).toBe("stopped");

  // 解除後は通知が止まる。
  const 件数 = 届いた.length;
  購読解除();
  await ops.start(loopback開始(50002));
  expect(届いた).toHaveLength(件数);
});

test("失効通知があれば失効で閉塞する", async () => {
  // 基盤の実 `onRevoked` に対する配線の単体確認。解除・終了経路の結合は別試験。
  // 不在時は `onEnd`・`onRemoteEnd` で代替する（別試験で検証済み）。
  // ADR: 保持は容器に載せる。閉包内の代入は局所変数の制御フロー解析に載らず、
  // `never` に狭まる場合があるためである。
  const 保持: { 失効: (() => void) | null } = { 失効: null };
  const stub = {
    kind: "reliable" as const,
    direction: "bidirectional" as const,
    sessionId: UDP_SESSION_ID,
    info: {
      localSessionId: "local-stub",
      connectionId: "conn-stub",
      sessionId: UDP_SESSION_ID,
      kind: "reliable",
      direction: "bidirectional",
    },
    isAlive: true,
    sent: [] as unknown[],
    onMessage: () => () => {},
    onEnd: () => () => {},
    onRemoteEnd: () => () => {},
    onRevoked: (handler: () => void) => {
      保持.失効 = handler;
      return () => {
        保持.失効 = null;
      };
    },
    sendReliable: (value: unknown) => {
      stub.sent.push(value);
      return Promise.resolve();
    },
    closeWrite: () => Promise.resolve(),
    abort: () => {},
  };
  const 生成口 = new 偽ソケット生成口([自動ソケット()]);
  const instance = createUdpPlugin({ socketFactory: 生成口.factory() }).create();
  try {
    // ADR: `as` は基盤の操作口形状を stub で再現するための境界突破であり、
    // 失効通知の購読を確かめる。実行時の存在検査が本体側にある。
    instance.attach(UDP_PORT_ID, stub as unknown as AssignedSession);
    const ops = instance.getOperations?.();
    if (ops === undefined) throw new Error("UDP操作口がない。");
    expect(await ops.start(loopback開始(50001))).toEqual({ ok: true });
    const 失効 = 保持.失効;
    expect(失効).not.toBe(null);
    if (失効 === null) throw new Error("失効通知が無い。");
    失効();
    const socket = 生成口.handedOut[0];
    expect(socket?.closeCalls).toBe(1);
    expect(instance.getState().phase).toBe("stopped");
    socket?.受信(new Uint8Array([1]));
    await 完了待ち();
    expect(stub.sent).toHaveLength(0);
  } finally {
    instance.dispose();
  }
});

test("統計は受信・転送・破棄・失敗を数える", async () => {
  const fake = new 偽サーバー();
  const { core, handle, ops, session, localSessionId, 生成口 } = udp割当て(fake, UDP_SESSION_ID);

  await ops.start(loopback開始(50001));
  const socket = 生成口.handedOut[0];
  if (socket === undefined) throw new Error("偽ソケットが無い。");
  // 転送完了を数える。
  socket.受信(new Uint8Array([1, 2]));
  await 完了待ち();
  // 上限超過を数える。
  socket.受信(new Uint8Array(48_001));
  // 送信元不正を数える。
  socket.受信(new Uint8Array([3]), { address: "", port: 40000 });
  await 完了待ち();
  // 失効後の受信は世代不一致で無視され、受信にも送信失敗にも数えない。
  // `sendFailures` は生存セッションへの送出失敗だけを数える。
  core.unassign(localSessionId);
  socket.受信(new Uint8Array([4]));
  await 完了待ち();
  expect(session.sent).toHaveLength(1);
  expect(handle.getState().stats).toEqual({
    receivedDatagrams: 3,
    receivedBytes: 2 + 48_001 + 1,
    forwardedDatagrams: 1,
    forwardedBytes: 2,
    droppedOversize: 1,
    droppedBusy: 0,
    droppedInvalidMetadata: 1,
    sendFailures: 0,
  });
  // 輸送統計には混ぜず、payload 本文も状態に残さない。
  expect(JSON.stringify(handle.getState())).not.toMatch(/dataBase64/);
});

test("UDPの接続口に合わない操作口ではattachできない", () => {
  const fake = new 偽サーバー();
  const latest = fake.開始Latest("pose");
  const latest操作口 = wrapServerSession(latest.session, latest.info).session;
  const reliable = fake.開始Reliable("udp");
  const reliable操作口 = wrapServerSession(reliable.session, reliable.info).session;

  const instance = udpPlugin.create();
  try {
    // 接続口違いは `RangeError` になる。
    expect(() => instance.attach("存在しない口", reliable操作口)).toThrow(RangeError);
    // 種別違いは `RangeError` になる。
    expect(() => instance.attach(UDP_PORT_ID, latest操作口)).toThrow(RangeError);
    expect(instance.getState().phase).toBe("unassigned");
  } finally {
    instance.dispose();
  }
  // 破棄後の割当ては `RangeError` になる。
  expect(() => instance.attach(UDP_PORT_ID, reliable操作口)).toThrow(RangeError);
});

test("操作口はハンドル経由で取得できる", () => {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);

  // UDP の操作口は型付きで取得できる。
  const ハンドル = core.createInstance(udpPlugin);
  const 操作口 = ハンドル.getOperations?.();
  expect(typeof 操作口?.start).toBe("function");
  expect(typeof 操作口?.stop).toBe("function");
  expect(typeof 操作口?.onStateChanged).toBe("function");
  // 汎用の任意 payload 送信口は作らない。
  expect(操作口).not.toHaveProperty("sendReliable");
});
