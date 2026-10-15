/**
 * テキスト GUI 登録単位（新中継契約）の単体試験。
 *
 * 登録単位の対応付け（管理記述子・companion 宣言）、endpoint の要求処理
 * （初期取得・本文送信・未知要求の拒否）、状態変更の通知と購読解放、
 * 改訂番号の引継ぎを確かめる。本文を DTO に載せないことも確かめる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { createBridgeAppCore, type BridgeAppCore } from "bridge-app-core/core";
import type {
  BoundPluginRef,
  PluginAssignmentCandidate,
  PluginBindingInfo,
} from "bridge-gui-plugin-sdk/management";
import type { PluginEmissionPort } from "bridge-gui-plugin-sdk/companion";
import type { PluginRelayEvent } from "bridge-gui-contract/plugin-instance";
import { TEXT_PORT_ID, textPlugin } from "../src/plugin.ts";
import type { TextPluginOperations, TextPluginState } from "../src/plugin.ts";
import {
  TEXT_GET_STATE_METHOD,
  TEXT_MOUNT_KIND,
  TEXT_SEND_TEXT_METHOD,
  TEXT_STATE_CHANGED_EVENT,
  TEXT_VIEW_ENTRY,
  isTextChildSnapshot,
  isTextSendRefused,
  isTextSendResult,
  type TextChildSnapshot,
} from "../src/gui-contract.ts";
import { TEXT_SESSION_ID } from "../src/contract.ts";
import { textGuiRegistration } from "../src/gui.ts";
import { 偽サーバー } from "./fakes.ts";

const cores: BridgeAppCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    core.close();
  }
});

/** 通知を集める emission port。 */
function 通知集め(集めた: PluginRelayEvent[]): PluginEmissionPort {
  return {
    emit(event: PluginRelayEvent): void {
      集めた.push(event);
    },
  };
}

test("登録単位は管理記述子とcompanion宣言を持つ", () => {
  expect(textGuiRegistration.management.kind).toBe(TEXT_MOUNT_KIND);
  expect(textGuiRegistration.management.definition).toBe(textPlugin);
  expect(textGuiRegistration.management.assignment.maxInstances).toBe(1);
  expect(textGuiRegistration.companion).toEqual({
    kind: TEXT_MOUNT_KIND,
    label: "テキスト",
    viewEntry: TEXT_VIEW_ENTRY,
  });
  expect(typeof textGuiRegistration.createEndpoint).toBe("function");
});

test("割当て選択は唯一の適格候補だけを受け付ける", () => {
  const 方針 = textGuiRegistration.management.assignment;
  const 作る = (
    localSessionId: string,
    上書き?: { readonly alive?: boolean; readonly assigned?: boolean; readonly sessionId?: string },
  ): PluginAssignmentCandidate => ({
    localSessionId,
    connectionId: "conn-1",
    sessionId: 上書き?.sessionId ?? TEXT_SESSION_ID,
    capability: { kind: "reliable", direction: "bidirectional" },
    alive: 上書き?.alive ?? true,
    assignment:
      上書き?.assigned === true
        ? { localSessionId, instanceId: "instance-他", portId: TEXT_PORT_ID }
        : null,
  });
  const 対象 = 作る("local-1");
  // 唯一の適格候補は通る。
  expect(方針.select({ request: { mode: "auto" }, candidates: [対象], bindings: [] })).toEqual({
    localSessionId: "local-1",
    portId: TEXT_PORT_ID,
  });
  // 候補ゼロ・複数は拒否する。
  expect(() => 方針.select({ request: { mode: "auto" }, candidates: [], bindings: [] })).toThrow(
    RangeError,
  );
  expect(() =>
    方針.select({ request: { mode: "auto" }, candidates: [対象, 作る("local-2")], bindings: [] }),
  ).toThrow(RangeError);
  // 割当て済み・論理名違いは候補にならない。
  expect(() =>
    方針.select({
      request: { mode: "auto" },
      candidates: [作る("local-1", { assigned: true })],
      bindings: [],
    }),
  ).toThrow(RangeError);
  expect(() =>
    方針.select({
      request: { mode: "auto" },
      candidates: [作る("local-1", { sessionId: "udp" })],
      bindings: [],
    }),
  ).toThrow(RangeError);
});

/** 実インスタンスへ束縛した参照口と endpoint を組み立てる。 */
function 束縛Endpoint(): {
  readonly core: BridgeAppCore;
  readonly ref: BoundPluginRef<TextPluginState, TextPluginOperations>;
  readonly binding: PluginBindingInfo;
  readonly endpoint: ReturnType<typeof textGuiRegistration.createEndpoint>;
  readonly 通知: PluginRelayEvent[];
  readonly localSessionId: string;
  readonly fake: 偽サーバー;
  readonly session: { readonly sent: unknown[] };
} {
  const fake = new 偽サーバー();
  const core = createBridgeAppCore(fake);
  cores.push(core);
  const handle = core.createInstance(textPlugin);
  const started = fake.開始Reliable(TEXT_SESSION_ID);
  core.assign(started.info.localSessionId, handle.instanceId, TEXT_PORT_ID);
  const binding: PluginBindingInfo = {
    kind: TEXT_MOUNT_KIND,
    pluginId: textPlugin.pluginId,
    instanceId: handle.instanceId,
    localSessionId: started.info.localSessionId,
    portId: TEXT_PORT_ID,
  };
  const ref: BoundPluginRef<TextPluginState, TextPluginOperations> = {
    getBinding: () => binding,
    readState: () => handle.getState(),
    withOperations: (use) => {
      const operations = handle.getOperations?.();
      if (operations === undefined) throw new TypeError("操作口が無い。");
      return use(operations, binding);
    },
  };
  const 通知: PluginRelayEvent[] = [];
  const endpoint = textGuiRegistration.createEndpoint(ref, 通知集め(通知));
  return {
    core,
    ref,
    binding,
    endpoint,
    通知,
    localSessionId: started.info.localSessionId,
    fake,
    session: started.session,
  };
}

/** 応答値から表示状態を取り出す。形状違いは落とす。 */
function 表示状態(値: unknown): TextChildSnapshot {
  if (!isTextChildSnapshot(値)) throw new Error("表示状態の形状ではない。");
  return 値;
}

test("初期取得は表示用DTOを返し本文を載せない", async () => {
  const { endpoint, binding } = 束縛Endpoint();
  try {
    const 値 = await endpoint.handleRequest({ method: TEXT_GET_STATE_METHOD, params: {} });
    const 状態 = 表示状態(値);
    expect(状態.instanceId).toBe(binding.instanceId);
    expect(状態.localSessionId).toBe(binding.localSessionId);
    expect(状態.portId).toBe(TEXT_PORT_ID);
    expect(typeof 状態.revision).toBe("number");
    expect(状態.canSend).toBe(true);
    expect(JSON.stringify(状態)).not.toContain("送信");
  } finally {
    endpoint.dispose();
  }
});

test("本文送信は反映確認で決着し状態通知が届く", async () => {
  const { endpoint, fake, localSessionId, session, 通知 } = 束縛Endpoint();
  try {
    通知.splice(0);
    const 応答約束 = endpoint.handleRequest({
      method: TEXT_SEND_TEXT_METHOD,
      params: { text: "こんにちは" },
    });
    // 送信直後は応答待ちであり、決着は反映確認を待つ。
    expect(session.sent).toHaveLength(1);
    // 偽セッションの送信記録から相関識別子を読む。
    const 記録 = session.sent[0] as { readonly id: string };
    fake.受信(localSessionId, { op: "shown", id: 記録.id });
    const 応答 = await 応答約束;
    expect(isTextSendResult(応答)).toBe(true);
    expect(通知.length).toBeGreaterThan(0);
    for (const 届き of 通知) {
      expect(届き.event).toBe(TEXT_STATE_CHANGED_EVENT);
      const 状態 = 表示状態(届き.payload);
      expect(JSON.stringify(状態)).not.toContain("こんにちは");
    }
    // 改訂番号は通知で引き継がれる。
    const 改訂 = 通知.map((届き) => 表示状態(届き.payload).revision);
    expect(改訂[改訂.length - 1] ?? -1).toBeGreaterThan(改訂[0] ?? -1);
  } finally {
    endpoint.dispose();
  }
});

test("不正な送信は業務エラー値で拒否する", async () => {
  const { endpoint, session } = 束縛Endpoint();
  try {
    const 空 = await endpoint.handleRequest({
      method: TEXT_SEND_TEXT_METHOD,
      params: { text: "" },
    });
    expect(isTextSendRefused(空)).toBe(true);
    const 形状違い = await endpoint.handleRequest({
      method: TEXT_SEND_TEXT_METHOD,
      params: null,
    });
    expect(isTextSendRefused(形状違い)).toBe(true);
    // 拒否時は送信しない。
    expect(session.sent).toHaveLength(0);
  } finally {
    endpoint.dispose();
  }
});

test("未知の要求名は不透明なエラー値で拒否する", async () => {
  const { endpoint } = 束縛Endpoint();
  try {
    const 値 = await endpoint.handleRequest({ method: "存在しない要求", params: {} });
    expect(isTextSendRefused(値)).toBe(true);
  } finally {
    endpoint.dispose();
  }
});

test("破棄で購読を解放し二重解放しない", async () => {
  const { endpoint, 通知 } = 束縛Endpoint();
  通知.splice(0);
  endpoint.dispose();
  endpoint.dispose();
  // 破棄後の要求は投げて中継失敗に落とす。
  await expect(
    endpoint.handleRequest({ method: TEXT_GET_STATE_METHOD, params: {} }),
  ).rejects.toThrow();
});
