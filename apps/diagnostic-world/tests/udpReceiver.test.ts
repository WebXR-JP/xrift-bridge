/**
 * UDPデータグラム転送の受信手順の検証。送受信は試験用スタブで行う。
 *
 * 実ネットワークの確認は対象外とし、ここでは転送の検証・復号・直近1件の保持・
 * 不正の局所化と計数・逆方向送信の禁止・後片付けの論理を検証する。DOM は使わない。
 * 試験データは固定値とし、実利用の payload は残さない。
 */
import { expect, test } from "vite-plus/test";
import { UDP_MAX_DATAGRAM_BYTES, UDP_SESSION_ID, encodeUdpData } from "bridge-plugin-udp/contract";
import type { SessionEnd } from "world-client";
import type { ReliableSession } from "world-client";
import { UDP_PREVIEW_BYTES, UdpReceiver } from "../src/udp/receiver.ts";

/** 試験用の reliable セッション。送受信・終端を手で操作する。 */
class FakeUdpSession implements ReliableSession {
  readonly sessionId = UDP_SESSION_ID;
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

/** 固定の試験バイト列。実利用の payload ではない。 */
const FIXED_BYTES = new Uint8Array([0x01, 0x02, 0xab, 0xff]);

/** 固定の試験転送を作る。 */
function datagram(data: Uint8Array): Record<string, unknown> {
  return {
    op: "datagram",
    dataBase64: encodeUdpData(data),
    source: { address: "127.0.0.1", port: 5123 },
  };
}

test("正常な転送を復号して統計・送信元・長さ・先頭プレビューに反映する", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    expect(receiver.getSnapshot().status).toBe("waiting");
    session.deliver(datagram(FIXED_BYTES));
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("received");
    expect(snapshot.receivedCount).toBe(1);
    expect(snapshot.receivedBytes).toBe(FIXED_BYTES.length);
    expect(snapshot.invalidCount).toBe(0);
    expect(snapshot.source).toEqual({ address: "127.0.0.1", port: 5123 });
    expect(snapshot.byteLength).toBe(FIXED_BYTES.length);
    expect(snapshot.previewHex).toBe("0102abff");
  } finally {
    receiver.dispose();
  }
});

test("直近1件だけ保持し統計は累積する", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver(datagram(new Uint8Array([0x01])));
    session.deliver(datagram(new Uint8Array([0x02, 0x03])));
    const snapshot = receiver.getSnapshot();
    expect(snapshot.receivedCount).toBe(2);
    expect(snapshot.receivedBytes).toBe(3);
    expect(snapshot.byteLength).toBe(2);
    expect(snapshot.previewHex).toBe("0203");
  } finally {
    receiver.dispose();
  }
});

test("先頭32バイトだけをプレビューにする", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    const data = new Uint8Array(UDP_PREVIEW_BYTES + 8).fill(0x7e);
    session.deliver(datagram(data));
    const snapshot = receiver.getSnapshot();
    expect(snapshot.byteLength).toBe(UDP_PREVIEW_BYTES + 8);
    expect(snapshot.previewHex).toBe("7e".repeat(UDP_PREVIEW_BYTES));
  } finally {
    receiver.dispose();
  }
});

test("空データグラムを正規受信として受け付ける", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver(datagram(new Uint8Array(0)));
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("received");
    expect(snapshot.receivedCount).toBe(1);
    expect(snapshot.receivedBytes).toBe(0);
    expect(snapshot.byteLength).toBe(0);
    expect(snapshot.previewHex).toBe("");
  } finally {
    receiver.dispose();
  }
});

test("不正形状を無視して数えセッションを維持する", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver({
      op: "datagram",
      dataBase64: "!!!",
      source: { address: "127.0.0.1", port: 1 },
    });
    session.deliver({ op: "unknown", dataBase64: "", source: { address: "127.0.0.1", port: 1 } });
    session.deliver({
      op: "datagram",
      dataBase64: "",
      source: { address: "127.0.0.1", port: 1 },
      extra: 1,
    });
    session.deliver({ op: "datagram", dataBase64: "", source: { address: "", port: 1 } });
    session.deliver({
      op: "datagram",
      dataBase64: "",
      source: { address: "127.0.0.1", port: 70000 },
    });
    session.deliver("ただの文字列");
    session.deliver(null);
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("waiting");
    expect(snapshot.receivedCount).toBe(0);
    expect(snapshot.invalidCount).toBe(7);
    expect(snapshot.source).toBeNull();
    expect(session.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("上限超過の転送を無視して数える", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    // 固定値（ゼロ列）で上限を1バイトだけ超える。
    session.deliver(datagram(new Uint8Array(UDP_MAX_DATAGRAM_BYTES + 1)));
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("waiting");
    expect(snapshot.receivedCount).toBe(0);
    expect(snapshot.invalidCount).toBe(1);
    expect(session.isAlive).toBe(true);
  } finally {
    receiver.dispose();
  }
});

test("不正な転送の後も正規の転送を受け付ける", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver({ op: "echo", id: "e1", value: "v" });
    session.deliver({ op: "show", id: "t1", text: "別盤の要求" });
    expect(receiver.getSnapshot().status).toBe("waiting");
    session.deliver(datagram(FIXED_BYTES));
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("received");
    expect(snapshot.receivedCount).toBe(1);
    expect(snapshot.invalidCount).toBe(2);
    expect(snapshot.previewHex).toBe("0102abff");
  } finally {
    receiver.dispose();
  }
});

test("正規・不正のいずれでも逆方向送信しない", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver(datagram(FIXED_BYTES));
    session.deliver({
      op: "datagram",
      dataBase64: "!!!",
      source: { address: "127.0.0.1", port: 1 },
    });
    session.deliver(datagram(FIXED_BYTES));
    expect(session.sent).toHaveLength(0);
  } finally {
    receiver.dispose();
  }
});

test("専用セッションの異常終了で他を閉じず直近と統計を残す", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver(datagram(FIXED_BYTES));
    session.fireRemoteEnd();
    const snapshot = receiver.getSnapshot();
    expect(snapshot.status).toBe("ended");
    expect(snapshot.receivedCount).toBe(1);
    expect(snapshot.previewHex).toBe("0102abff");
    expect(snapshot.source).toEqual({ address: "127.0.0.1", port: 5123 });
  } finally {
    receiver.dispose();
  }
});

test("自セッションの中断で直近表示を残して中断にする", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    session.deliver(datagram(FIXED_BYTES));
    session.abort();
    expect(receiver.getSnapshot().status).toBe("ended");
    expect(receiver.getSnapshot().byteLength).toBe(FIXED_BYTES.length);
  } finally {
    receiver.dispose();
  }
});

test("購読者の例外で受信状態を壊さない", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  try {
    receiver.subscribe(() => {
      throw new Error("購読者の失敗");
    });
    session.deliver(datagram(FIXED_BYTES));
    expect(receiver.getSnapshot().status).toBe("received");
    expect(session.sent).toHaveLength(0);
  } finally {
    receiver.dispose();
  }
});

test("破棄後は受信を反映せず通知も購読も止める", () => {
  const session = new FakeUdpSession();
  const receiver = new UdpReceiver({ session });
  let notified = 0;
  const unsubscribe = receiver.subscribe(() => {
    notified += 1;
  });
  session.deliver(datagram(FIXED_BYTES));
  expect(notified).toBe(1);
  unsubscribe();
  receiver.dispose();
  session.deliver(datagram(new Uint8Array([0x09])));
  expect(receiver.getSnapshot().receivedCount).toBe(1);
  expect(receiver.getSnapshot().previewHex).toBe("0102abff");
  expect(notified).toBe(1);
  expect(() => receiver.subscribe(() => {})).toThrow();
});
