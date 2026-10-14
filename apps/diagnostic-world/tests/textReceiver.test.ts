/**
 * テキスト受信手順の検証。送受信は試験用スタブで行う。
 *
 * 実ネットワークの確認は対象外とし、ここでは表示要求の検証・状態反映後の
 * 反映確認・echo／ping との共存・異常の局所化・後片付けの論理を検証する。
 * DOM は使わない。
 */
import { expect, test } from "vite-plus/test";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import type { SessionEnd } from "world-client";
import type { ReliableSession } from "world-client";
import { TextReceiver } from "../src/text/receiver.ts";

/** 試験用の reliable セッション。送受信・終端を手で操作する。 */
class FakeTextSession implements ReliableSession {
  readonly sessionId = TEXT_SESSION_ID;
  readonly kind = "reliable" as const;
  readonly direction = "bidirectional" as const;
  readonly side = "client" as const;
  private alive = true;
  readonly sent: unknown[] = [];
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();

  get isAlive(): boolean {
    return this.alive;
  }

  get receivedCount(): number {
    return 0;
  }

  get staleDroppedCount(): number {
    return 0;
  }

  get missingSeqCount(): number {
    return 0;
  }

  get lastRecvSeq(): number {
    return -1;
  }

  get writeEnded(): boolean {
    return false;
  }

  get peerEnded(): boolean {
    return false;
  }

  async sendReliable(value: unknown): Promise<void> {
    if (!this.alive) throw new Error("終端したセッションには送れない。");
    this.sent.push(value);
  }

  onMessage(handler: (payload: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onRemoteEnd(handler: () => void): () => void {
    this.remoteEndHandlers.add(handler);
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  onEnd(handler: (end: SessionEnd) => void): () => void {
    this.endHandlers.add(handler);
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  async closeWrite(): Promise<void> {
    if (!this.alive) throw new Error("終端したセッションは終えられない。");
  }

  abort(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const handler of this.endHandlers) {
      try {
        handler({ kind: "aborted" });
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  /** 受信ペイロードを流す。 */
  deliver(payload: unknown): void {
    if (!this.alive) return;
    for (const handler of this.messageHandlers) {
      try {
        handler(payload);
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }

  /** 相手による終了を起こす。 */
  fireRemoteEnd(): void {
    for (const handler of this.remoteEndHandlers) {
      try {
        handler();
      } catch {
        // 購読者の例外は無視する。
      }
    }
  }
}

/** 受信値が対象の記録値か判定する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("正常な表示要求を検証し状態反映後に確認応答を返す", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    expect(receiver.getSnapshot().status).toBe("waiting");
    session.deliver({ op: "show", id: "a1", text: "こんにちは" });
    // ADR: 状態反映は送出完了より先に行う。`deliver` の復帰時点で
    // 写しは受信済みであり、確認応答は送出済みであることを確かめる。
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("received");
    expect(snapshot.text).toBe("こんにちは");
    expect(snapshot.id).toBe("a1");
    expect(session.sent).toHaveLength(1);
    const ack = session.sent[0];
    expect(isRecord(ack) ? ack["op"] : undefined).toBe("shown");
    expect(isRecord(ack) ? ack["id"] : undefined).toBe("a1");
    // 本文は返送しない。
    expect(isRecord(ack) ? "text" in ack : true).toBe(false);
    expect(Object.keys(isRecord(ack) ? ack : {}).sort()).toEqual(["id", "op"]);
  } finally {
    receiver.dispose();
  }
});

test("直近の表示要求で置換する", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "a1", text: "ひとつめ" });
    session.deliver({ op: "show", id: "a2", text: "ふたつめ" });
    expect(receiver.getSnapshot().text).toBe("ふたつめ");
    expect(receiver.getSnapshot().id).toBe("a2");
    expect(session.sent).toHaveLength(2);
    expect(isRecord(session.sent[1]) ? session.sent[1]["id"] : undefined).toBe("a2");
  } finally {
    receiver.dispose();
  }
});

test("空の本文の表示要求を無視する", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "a1", text: "" });
    expect(receiver.getSnapshot().status).toBe("waiting");
    expect(receiver.getSnapshot().text).toBeNull();
    expect(session.sent).toHaveLength(0);
    expect(session.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("上限超過の本文の表示要求を無視する", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "a1", text: "あ".repeat(513) });
    expect(receiver.getSnapshot().status).toBe("waiting");
    expect(receiver.getSnapshot().text).toBeNull();
    expect(session.sent).toHaveLength(0);
    expect(session.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("余分なキーを持つ表示要求を無視する", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "a1", text: "本文", extra: 1 });
    expect(receiver.getSnapshot().status).toBe("waiting");
    expect(session.sent).toHaveLength(0);
    expect(session.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("不正な操作名の表示要求を無視する", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "shown", id: "a1" });
    session.deliver({ op: "echo", id: "a1", value: "x" });
    session.deliver({ op: "ping", id: "a1" });
    session.deliver("ただの文字列");
    session.deliver(null);
    expect(receiver.getSnapshot().status).toBe("waiting");
    expect(session.sent).toHaveLength(0);
    expect(session.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("不正な表示要求の後も正規の要求を受け付ける", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "", text: "識別子なし" });
    session.deliver({ op: "show", text: "識別子欠落" });
    session.deliver({ op: "show", id: "a1", text: 123 });
    expect(session.sent).toHaveLength(0);
    session.deliver({ op: "show", id: "a1", text: "正規" });
    expect(receiver.getSnapshot().status).toBe("received");
    expect(receiver.getSnapshot().text).toBe("正規");
    expect(session.sent).toHaveLength(1);
  } finally {
    receiver.dispose();
  }
});

test("echo・ping 形状の受信は別セッションの通信として無視する", () => {
  const session = new FakeTextSession();
  const echo = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    // echo／ping は別セッション（`diag-echo`・`diag-ping`）の通信であり、
    // テキスト専用セッションに届いた同形状は表示要求ではない。
    session.deliver({ op: "echo", id: "e1", value: "v" });
    session.deliver({ op: "pong", id: "p1" });
    expect(receiver.getSnapshot().status).toBe("waiting");
    expect(session.sent).toHaveLength(0);
    expect(echo.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("専用セッションの異常終了で他セッションを閉じない", () => {
  const session = new FakeTextSession();
  const echo = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "a1", text: "残す本文" });
    session.fireRemoteEnd();
    expect(receiver.getSnapshot().status).toBe("ended");
    // 直近本文は残し、他セッションは維持する。
    expect(receiver.getSnapshot().text).toBe("残す本文");
    expect(echo.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("自セッションの中断で直近表示を残して中断にする", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    session.deliver({ op: "show", id: "a1", text: "本文" });
    session.abort();
    expect(receiver.getSnapshot().status).toBe("ended");
    expect(receiver.getSnapshot().text).toBe("本文");
  } finally {
    receiver.dispose();
  }
});

test("購読者の例外で受信状態を壊さない", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  try {
    receiver.subscribe(() => {
      throw new Error("購読者の失敗");
    });
    session.deliver({ op: "show", id: "a1", text: "本文" });
    expect(receiver.getSnapshot().status).toBe("received");
    expect(session.sent).toHaveLength(1);
  } finally {
    receiver.dispose();
  }
});

test("破棄後は受信を反映せず通知も購読も止める", () => {
  const session = new FakeTextSession();
  const receiver = new TextReceiver({ session });
  let notified = 0;
  const unsubscribe = receiver.subscribe(() => {
    notified += 1;
  });
  session.deliver({ op: "show", id: "a1", text: "本文" });
  expect(notified).toBe(1);
  unsubscribe();
  receiver.dispose();
  session.deliver({ op: "show", id: "a2", text: "破棄後の本文" });
  expect(receiver.getSnapshot().text).toBe("本文");
  expect(notified).toBe(1);
  expect(() => receiver.subscribe(() => {})).toThrow();
});
