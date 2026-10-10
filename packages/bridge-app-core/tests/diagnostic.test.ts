/**
 * 同梱診断プラグインの単体試験。
 *
 * 偽サーバー管理境界と基盤を組み合わせ、echo・ping の応答形状、
 * 不正形状での中断、応答統計を確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createBridgeAppCore, type BridgeAppCore } from "../src/app-core.ts";
import { wrapServerSession } from "../src/assigned-session.ts";
import {
  DIAGNOSTIC_PORT_ID,
  diagnosticPlugin,
  type DiagnosticStats,
} from "../src/plugins/diagnostic.ts";
import type { PluginInstanceHandle } from "../src/plugin.ts";
import { 偽サーバー, type 偽ReliableSession } from "./fakes.ts";

const cores: BridgeAppCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close();
  }
});

/** 診断インスタンスを生成し、reliable セッションを割り当てる。 */
function 診断割当て(
  fake: 偽サーバー,
  sessionId: string,
): {
  readonly core: BridgeAppCore;
  readonly handle: PluginInstanceHandle<DiagnosticStats>;
  readonly localSessionId: string;
  readonly session: 偽ReliableSession;
} {
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const handle = core.createInstance(diagnosticPlugin);
  const started = fake.開始Reliable(sessionId);
  core.assign(started.info.localSessionId, handle.instanceId, DIAGNOSTIC_PORT_ID);
  return { core, handle, localSessionId: started.info.localSessionId, session: started.session };
}

test("echo要求に応答形状どおり返す", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId, session } = 診断割当て(fake, "diag");
  void handle;
  void localSessionId;

  fake.受信(localSessionId, {
    op: "echo",
    id: "応答形状-1",
    value: { data: "あ" },
  });
  expect(session.sent).toEqual([{ op: "echo", id: "応答形状-1", value: { data: "あ" } }]);
});

test("ping要求にpongで応答する", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId, session } = 診断割当て(fake, "diag");
  void handle;

  fake.受信(localSessionId, { op: "ping", id: "応答形状-1" });
  expect(session.sent).toEqual([{ op: "pong", id: "応答形状-1" }]);
});

test("不正形状では応答せずそのセッションを中断する", () => {
  const 不正値: unknown[] = [
    { op: "echo", id: "欠落" },
    { op: "echo", id: "欠落", value: 1, 余分: true },
    { op: "ping" },
    { op: "ping", id: "", 余分: 0 },
    { op: "ping", id: "余分", 余分: 0 },
    { op: "未知", id: "x" },
    null,
    [],
    "文字列",
  ];
  for (const [index, payload] of 不正値.entries()) {
    const fake = new 偽サーバー();
    const { handle, localSessionId, session } = 診断割当て(fake, `diag-${index}`);
    void handle;
    void localSessionId;
    fake.受信(localSessionId, payload);
    // 応答は送らず、当該セッションのみ中断する。
    expect(session.sent).toEqual([]);
    expect(session.aborted).toHaveLength(1);
    expect(session.isAlive).toBe(false);
  }
});

test("応答統計をUI非依存で取得できる", () => {
  const fake = new 偽サーバー();
  const { handle, localSessionId } = 診断割当て(fake, "diag");

  fake.受信(localSessionId, { op: "echo", id: "統計-1", value: 1 });
  fake.受信(localSessionId, { op: "echo", id: "統計-2", value: null });
  fake.受信(localSessionId, { op: "ping", id: "統計-3" });
  // 応答を送信試行した件数を数える。
  expect(handle.getState()).toEqual({ diagnosticEcho: 2, diagnosticPing: 1 });
});

test("診断の接続口に合わない操作口ではattachできない", () => {
  const fake = new 偽サーバー();
  const latest = fake.開始Latest("pose");
  const latest操作口 = wrapServerSession(latest.session, latest.info).session;
  const reliable = fake.開始Reliable("diag");
  const reliable操作口 = wrapServerSession(reliable.session, reliable.info).session;

  const instance = diagnosticPlugin.create();
  try {
    // 接続口違いは `RangeError` になる。
    expect(() => instance.attach("存在しない口", reliable操作口)).toThrow(RangeError);
    // 種別違いは `RangeError` になる。
    expect(() => instance.attach(DIAGNOSTIC_PORT_ID, latest操作口)).toThrow(RangeError);
    expect(instance.getState()).toEqual({ diagnosticEcho: 0, diagnosticPing: 0 });
  } finally {
    instance.dispose();
  }
  // 破棄後の割当ては `RangeError` になる。
  expect(() => instance.attach(DIAGNOSTIC_PORT_ID, reliable操作口)).toThrow(RangeError);
});
