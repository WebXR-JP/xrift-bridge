import { expect, test } from "vite-plus/test";
import { AbstractMessageStream } from "@libp2p/utils";
import type { Logger } from "@libp2p/interface";
import type { SendResult } from "@libp2p/utils";
import { Uint8ArrayList } from "uint8arraylist";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import { bridgeMuxer, type BridgeMuxer } from "../src/transport/muxer.ts";
import { FrameRejectedError, encodeFrameJson } from "../src/transport/framing.ts";
import { Session, SessionError, type SessionEnd } from "../src/transport/session.ts";
import type { SessionDirection, SessionKind } from "../src/messages.ts";
import { PROTOCOL_VERSION } from "../src/messages.ts";

// ADR: libp2p の `Logger` は呼出可能と付帯操作の合成型であり、
// テスト用の無操作実装は構造で組み立てる。合成の正当な構築手段として使う。
function createTestLogger(): Logger {
  const callable = (..._args: unknown[]): void => void 0;
  const log = callable as unknown as Logger;
  log.error = (..._args: unknown[]): void => {};
  log.trace = (..._args: unknown[]): void => {};
  log.enabled = false;
  log.newScope = () => log;
  return log;
}

/**
 * 対向へ非同期配送するメモリ duplex。実 `ws` を使わず決定的に動く。
 *
 * B1 の muxer テストと同形であり、到着は非同期・順序保存である。
 */
class MemoryPipe extends AbstractMessageStream {
  peer?: MemoryPipe;

  constructor(direction: "inbound" | "outbound") {
    super({ log: createTestLogger(), direction });
  }

  sendData(data: Uint8ArrayList): SendResult {
    // ADR: 送出後に基底が緩衝を消費するため、相手渡しは複写する。
    const copy = new Uint8ArrayList(new Uint8Array(data.subarray()));
    const peer = this.peer;
    setTimeout(() => {
      try {
        peer?.onData(copy);
      } catch {
        // 終了後の到着は失われる（実輸送では届かないか無視される）。
      }
    }, 0);
    return { sentBytes: data.byteLength, canSendMore: true };
  }

  sendReset(_err: Error): void {
    const peer = this.peer;
    setTimeout(() => {
      peer?.onRemoteReset();
    }, 0);
  }

  sendPause(): void {}

  sendResume(): void {}

  async close(): Promise<void> {
    const peer = this.peer;
    // 送出済みの到着より後に輸送終了を伝える（順序保存）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    peer?.onTransportClosed();
  }
}

/** 対向 duplex と両端 muxer の束。 */
interface MuxPair {
  readonly clientMuxer: BridgeMuxer;
  readonly serverMuxer: BridgeMuxer;
}

function createMuxPair(): MuxPair {
  const clientPipe = new MemoryPipe("outbound");
  const serverPipe = new MemoryPipe("inbound");
  clientPipe.peer = serverPipe;
  serverPipe.peer = clientPipe;
  const clientMuxer = bridgeMuxer()().createStreamMuxer(clientPipe);
  const serverMuxer = bridgeMuxer()().createStreamMuxer(serverPipe);
  return { clientMuxer, serverMuxer };
}

async function disposeMuxPair(pair: MuxPair): Promise<void> {
  await pair.clientMuxer.close().catch(() => undefined);
  await pair.serverMuxer.close().catch(() => undefined);
}

/** 向き合った stream と Session の組。 */
interface SessionPair {
  readonly pair: MuxPair;
  readonly clientStream: YamuxStream;
  readonly serverStream: YamuxStream;
  readonly clientSession: Session;
  readonly serverSession: Session;
}

const CONNECTION_ID = "conn-1";
const SESSION_ID = "sess-1";

/** 向き合った stream を開き、両側の Session を作る。 */
async function createSessionPair(
  pair: MuxPair,
  options: {
    readonly kind: SessionKind;
    readonly direction: SessionDirection;
    readonly sessionId?: string;
  },
): Promise<SessionPair> {
  const sessionId = options.sessionId ?? SESSION_ID;
  const accepted = new Promise<YamuxStream>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("inbound stream の到着が期限切れになった")),
      5000,
    );
    const onStream = (event: Event): void => {
      clearTimeout(timer);
      pair.serverMuxer.removeEventListener("stream", onStream);
      resolve((event as CustomEvent<YamuxStream>).detail);
    };
    pair.serverMuxer.addEventListener("stream", onStream);
  });
  const clientStream = await pair.clientMuxer.createStream();
  const serverStream = await accepted;
  const clientSession = new Session({
    connectionId: CONNECTION_ID,
    sessionId,
    kind: options.kind,
    direction: options.direction,
    side: "client",
    stream: clientStream,
  });
  const serverSession = new Session({
    connectionId: CONNECTION_ID,
    sessionId,
    kind: options.kind,
    direction: options.direction,
    side: "server",
    stream: serverStream,
  });
  return { pair, clientStream, serverStream, clientSession, serverSession };
}

/** 条件が満たされるまで待つ。満たされなければ期限切れで失敗する。 */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`${what} が ${timeoutMs}ms 以内に満たされない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 期待件数の payload を購読して集める。 */
function collectPayloads(session: Session, count: number, timeoutMs = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const out: unknown[] = [];
    // ADR: 登録前の到着分は登録時に同期で渡るため、`unsub` の確定前に
    // 呼ばれる場合がある。`let`＋任意呼びで TDZ を避ける。
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(`payload ${count}件の受信が期限切れになった（${out.length}件のみ）`));
    }, timeoutMs);
    unsub = session.onMessage((payload) => {
      out.push(payload);
      if (out.length === count) {
        clearTimeout(timer);
        unsub?.();
        resolve(out);
      }
    });
  });
}

/** 終端通知を1件待つ。 */
function waitSessionEnd(session: Session, timeoutMs = 5000): Promise<SessionEnd> {
  return new Promise((resolve, reject) => {
    // ADR: 終端済みへの登録は同期で即時通知されるため、`unsub` の確定前に
    // 呼ばれる場合がある。`let`＋任意呼びで TDZ を避ける。
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error("終端通知が期限切れになった"));
    }, timeoutMs);
    unsub = session.onEnd((end) => {
      clearTimeout(timer);
      unsub?.();
      resolve(end);
    });
  });
}

/** 相手 FIN 通知を待つ。 */
function waitRemoteEnd(session: Session, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error("相手 FIN 通知が期限切れになった"));
    }, timeoutMs);
    unsub = session.onRemoteEnd(() => {
      clearTimeout(timer);
      unsub?.();
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("種別と方向の組合せで送受信可否が決まる", async () => {
  const pair = createMuxPair();
  try {
    // reliable は双方向であり、不正な組合せは構築時に拒否する。
    expect(
      () =>
        new Session({
          connectionId: CONNECTION_ID,
          sessionId: SESSION_ID,
          kind: "reliable",
          direction: "to_client",
          side: "server",
          stream: undefined as unknown as YamuxStream,
        }),
    ).toThrow(SessionError);
    // latest は一方向のみであり、双方向は構築時に拒否する。
    const probe = await createSessionPair(pair, { kind: "latest", direction: "to_client" });
    expect(probe.serverSession.canSend).toBe(true);
    expect(probe.serverSession.canReceive).toBe(false);
    expect(probe.clientSession.canSend).toBe(false);
    expect(probe.clientSession.canReceive).toBe(true);
    // to_client の client 側からの latest 送信は throw する。
    expect(() => probe.clientSession.sendLatest({ v: 1 })).toThrow(SessionError);
    probe.clientSession.abort();
    probe.serverSession.abort();
  } finally {
    await disposeMuxPair(pair);
  }
});

test("reliable で往復し順序と Session 内直列化を保つ", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const count = 10;
    // 待ち合わせず一気に積み、Session 内の直列化に委ねる。
    const sends = Array.from({ length: count }, (_value, index) =>
      clientSession.sendReliable({ n: index }),
    );
    const received = await collectPayloads(serverSession, count);
    await Promise.all(sends);
    expect(received).toEqual(Array.from({ length: count }, (_value, index) => ({ n: index })));
    // 逆方向も順序どおり返る。
    const echoes = (received as Array<{ n: number }>).map((value) =>
      serverSession.sendReliable(value),
    );
    const echoed = await collectPayloads(clientSession, count);
    await Promise.all(echoes);
    expect(echoed).toEqual(received);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("送信受付後の参照変更の影響を受けない", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const value: { text: string } = { text: "受付時" };
    const send = clientSession.sendReliable(value);
    // 受付後の変更は送出内容に反映されない。
    value.text = "受付後に変更";
    await send;
    expect(await collectPayloads(serverSession, 1)).toEqual([{ text: "受付時" }]);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("受信側 pause で window 枯渇時は sendReliable が未決着になり resume で決着する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, serverStream, clientSession, serverSession } = await createSessionPair(
      pair,
      { kind: "reliable", direction: "bidirectional" },
    );
    // 1件ごとの stream.send 呼び出しを数える。再投入があれば件数を超える。
    let sendCalls = 0;
    const originalSend = clientStream.send.bind(clientStream);
    clientStream.send = (data: Uint8Array | Uint8ArrayList): boolean => {
      sendCalls += 1;
      return originalSend(data);
    };
    // 受信を止めて window 更新を抑える。初期 window（256KiB）を超える量を積む。
    serverStream.pause();
    const payload = "x".repeat(32 * 1024);
    const count = 12;
    const sends = Array.from({ length: count }, (_value, index) =>
      clientSession.sendReliable({ n: index, body: payload }),
    );
    // window 枯渇で未決着になる。resume 前に解けてはならない。
    const outcome = await Promise.race([
      Promise.all(sends).then(() => "resolved" as const),
      delay(200).then(() => "pending" as const),
    ]);
    expect(outcome).toBe("pending");
    // 下位 backpressure の証拠（drain 待ちまたは滞留）を見る。
    expect(clientStream.writableNeedsDrain || clientStream.writeBufferLength > 0).toBe(true);
    // 再開で排出され、全件が一度ずつの投入で決着する。
    serverStream.resume();
    await Promise.race([
      Promise.all(sends),
      delay(10000).then(() => {
        throw new Error("resume 後の決着が期限切れになった");
      }),
    ]);
    expect(sendCalls).toBe(count);
    const received = await collectPayloads(serverSession, count);
    expect((received as Array<{ n: number }>).map((value) => value.n)).toEqual(
      Array.from({ length: count }, (_value, index) => index),
    );
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("latest は投入中1件と未投入最新1件だけを送り置換分を欠番として数える", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, clientSession, serverSession } = await createSessionPair(pair, {
      kind: "latest",
      direction: "to_server",
    });
    let sendCalls = 0;
    const originalSend = clientStream.send.bind(clientStream);
    clientStream.send = (data: Uint8Array | Uint8ArrayList): boolean => {
      sendCalls += 1;
      return originalSend(data);
    };
    // 同期で5件受け付け、戻りは約束ではない。
    for (let index = 0; index < 5; index += 1) {
      expect(clientSession.sendLatest({ n: index })).toBeUndefined();
    }
    // 投入中（seq 0）と未投入最新（seq 4）だけが送られる。
    const received = await collectPayloads(serverSession, 2);
    expect(received).toEqual([{ n: 0 }, { n: 4 }]);
    expect(sendCalls).toBe(2);
    expect(serverSession.receivedCount).toBe(2);
    expect(serverSession.lastRecvSeq).toBe(4);
    expect(serverSession.missingSeqCount).toBe(3);
    expect(serverSession.staleDroppedCount).toBe(0);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("latest の古い・同値の受信は無視して数える", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, serverSession } = await createSessionPair(pair, {
      kind: "latest",
      direction: "to_server",
    });
    const raw = (seq: number, n: number): Uint8Array =>
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "data",
        connectionId: CONNECTION_ID,
        sessionId: SESSION_ID,
        seq,
        payload: { n },
      });
    // 順序どおり2件、その後に古い・同値を混ぜる。
    clientStream.send(raw(0, 0));
    clientStream.send(raw(2, 2));
    expect(await collectPayloads(serverSession, 2)).toEqual([{ n: 0 }, { n: 2 }]);
    clientStream.send(raw(1, 1));
    clientStream.send(raw(2, 22));
    // 無視されるため追加の到着はない。
    await delay(100);
    expect(serverSession.receivedCount).toBe(2);
    expect(serverSession.staleDroppedCount).toBe(2);
    expect(serverSession.lastRecvSeq).toBe(2);
    expect(serverSession.missingSeqCount).toBe(1);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("reliable に seq が混入したら境界違反で終了する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverEnd = waitSessionEnd(serverSession);
    const clientEnd = waitSessionEnd(clientSession);
    // Session を迂回して seq 付き data を流し込む。
    clientStream.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "data",
        connectionId: CONNECTION_ID,
        sessionId: SESSION_ID,
        seq: 0,
        payload: { n: 1 },
      }),
    );
    expect((await serverEnd).kind).toBe("protocol-violation");
    expect(serverSession.closed).toBe(true);
    // 違反側の RST で相手も中断する。
    expect((await clientEnd).kind).toBe("aborted");
    // 終端後の送信は拒否する。
    await expect(clientSession.sendReliable({ n: 2 })).rejects.toThrow(SessionError);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("latest に seq がなければ境界違反で終了する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, serverSession } = await createSessionPair(pair, {
      kind: "latest",
      direction: "to_server",
    });
    const serverEnd = waitSessionEnd(serverSession);
    clientStream.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "data",
        connectionId: CONNECTION_ID,
        sessionId: SESSION_ID,
        payload: { n: 1 },
      }),
    );
    expect((await serverEnd).kind).toBe("protocol-violation");
  } finally {
    await disposeMuxPair(pair);
  }
});

test("受信不可方向のデータは境界違反で終了する", async () => {
  const pair = createMuxPair();
  try {
    // to_server の client 側は受信できない。
    const { serverStream, clientSession } = await createSessionPair(pair, {
      kind: "latest",
      direction: "to_server",
    });
    const clientEnd = waitSessionEnd(clientSession);
    serverStream.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "data",
        connectionId: CONNECTION_ID,
        sessionId: SESSION_ID,
        seq: 0,
        payload: { n: 1 },
      }),
    );
    expect((await clientEnd).kind).toBe("protocol-violation");
  } finally {
    await disposeMuxPair(pair);
  }
});

test("FIN で片方向が終わり逆方向は継続できる", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    await clientSession.sendReliable({ n: 1 });
    expect(await collectPayloads(serverSession, 1)).toEqual([{ n: 1 }]);
    const serverRemoteEnd = waitRemoteEnd(serverSession);
    await clientSession.closeWrite();
    // 相手 FIN を観測しても自側の送信は継続できる。
    await serverRemoteEnd;
    expect(serverSession.peerEnded).toBe(true);
    expect(serverSession.closed).toBe(false);
    await serverSession.sendReliable({ n: 2 });
    expect(await collectPayloads(clientSession, 1)).toEqual([{ n: 2 }]);
    // 双方 FIN で両 Session が正常終了する。
    const clientEnd = waitSessionEnd(clientSession);
    const serverEnd = waitSessionEnd(serverSession);
    await serverSession.closeWrite();
    expect((await clientEnd).kind).toBe("closed");
    expect((await serverEnd).kind).toBe("closed");
    expect(pair.clientMuxer.status).toBe("open");
    expect(pair.serverMuxer.status).toBe("open");
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("RST で対象 Session だけが中断し他 Session は継続する", async () => {
  const pair = createMuxPair();
  try {
    const first = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
      sessionId: "sess-a",
    });
    const second = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
      sessionId: "sess-b",
    });
    const clientEnd = waitSessionEnd(first.clientSession);
    const serverEnd = waitSessionEnd(first.serverSession);
    first.clientSession.abort(new Error("rst-spike"));
    expect((await clientEnd).kind).toBe("aborted");
    expect((await serverEnd).kind).toBe("aborted");
    // 他 Session は影響を受けない。
    await second.clientSession.sendReliable({ b: 2 });
    expect(await collectPayloads(second.serverSession, 1)).toEqual([{ b: 2 }]);
    expect(second.clientSession.closed).toBe(false);
    expect(second.serverSession.closed).toBe(false);
    second.clientSession.abort();
    second.serverSession.abort();
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("終了時は未決着の送信を一度だけ拒否する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, serverStream, clientSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    serverStream.pause();
    const payload = "x".repeat(32 * 1024);
    const count = 10;
    // 約束ごとの決着を数える。window 内に収まった分は成功のまま残る。
    const settled = new Map<number, "resolved" | "rejected">();
    const sends = Array.from({ length: count }, (_value, index) =>
      clientSession.sendReliable({ n: index, body: payload }).then(
        () => {
          settled.set(index, "resolved");
        },
        () => {
          settled.set(index, "rejected");
        },
      ),
    );
    // 下位 backpressure で詰まってから中断する。
    await waitFor(
      () => clientStream.writableNeedsDrain || clientStream.writeBufferLength > 0,
      5000,
      "送信側の backpressure 観測",
    );
    let endCount = 0;
    const unsub = clientSession.onEnd(() => {
      endCount += 1;
    });
    clientSession.abort(new Error("abort-pending"));
    await Promise.all(sends);
    // 全約束がちょうど一度だけ決着し、未決着分は拒否される。終端通知も一度だけである。
    expect(settled.size).toBe(count);
    const rejected = [...settled.values()].filter((entry) => entry === "rejected").length;
    expect(rejected).toBeGreaterThan(0);
    expect(endCount).toBe(1);
    // 二重中断は何も起こさない。
    clientSession.abort(new Error("abort-again"));
    expect(endCount).toBe(1);
    unsub();
    serverStream.resume();
  } finally {
    await disposeMuxPair(pair);
  }
}, 20_000);

test("大きすぎる送信は投入前に拒否し Session は継続する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    let sendCalls = 0;
    const originalSend = clientStream.send.bind(clientStream);
    clientStream.send = (data: Uint8Array | Uint8ArrayList): boolean => {
      sendCalls += 1;
      return originalSend(data);
    };
    // 本体が上限（65,536B）を超える送信は投入前に拒否する。
    await expect(clientSession.sendReliable({ body: "x".repeat(66_000) })).rejects.toThrow(
      FrameRejectedError,
    );
    expect(sendCalls).toBe(0);
    // Session は切断されず送受信できる。
    await clientSession.sendReliable({ n: 1 });
    expect(sendCalls).toBe(1);
    expect(await collectPayloads(serverSession, 1)).toEqual([{ n: 1 }]);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("JSON 化できない送信は投入前に拒否する", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    await expect(clientSession.sendReliable(Number.NaN)).rejects.toThrow();
    // 送信側の Session は切断されず送受信できる。
    await clientSession.sendReliable({ n: 1 });
    expect(await collectPayloads(serverSession, 1)).toEqual([{ n: 1 }]);
  } finally {
    await disposeMuxPair(pair);
  }
});

test("受信の framing 異常で Session を異常終了する", async () => {
  // 超過・0-byte・破損・UTF-8 不正の4通りを別 Session で確かめる。
  const cases: Array<{ readonly name: string; readonly chunk: Uint8Array }> = [
    {
      name: "超過",
      chunk: new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x7b, 0x7d]),
    },
    {
      name: "0-byte",
      chunk: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    },
    {
      name: "破損",
      chunk: (() => {
        const body = new TextEncoder().encode("{broken");
        const out = new Uint8Array(4 + body.byteLength);
        new DataView(out.buffer).setUint32(0, body.byteLength, false);
        out.set(body, 4);
        return out;
      })(),
    },
    {
      name: "UTF-8 不正",
      chunk: new Uint8Array([0x00, 0x00, 0x00, 0x02, 0xff, 0xfe]),
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const pair = createMuxPair();
    try {
      const { clientStream, serverSession } = await createSessionPair(pair, {
        kind: "reliable",
        direction: "bidirectional",
        sessionId: `sess-framing-${index}`,
      });
      const serverEnd = waitSessionEnd(serverSession);
      clientStream.send(entry.chunk);
      const end = await serverEnd;
      expect(end.kind, entry.name).toBe("framing-error");
    } finally {
      await disposeMuxPair(pair);
    }
  }
});

test("途中 FIN は対象 Session を異常終了する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverEnd = waitSessionEnd(serverSession);
    const bytes = encodeFrameJson({ n: 1 });
    clientStream.send(bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
    await clientStream.close();
    expect((await serverEnd).kind).toBe("framing-error");
  } finally {
    await disposeMuxPair(pair);
  }
});

test("data 以外のメッセージは境界違反で終了する", async () => {
  const pair = createMuxPair();
  try {
    const { clientStream, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const serverEnd = waitSessionEnd(serverSession);
    // Session stream 上の create_session は扱わない。
    clientStream.send(
      encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "create_session",
        connectionId: CONNECTION_ID,
        sessionId: SESSION_ID,
        kind: "reliable",
        direction: "bidirectional",
      }),
    );
    expect((await serverEnd).kind).toBe("protocol-violation");
  } finally {
    await disposeMuxPair(pair);
  }
});

test("Connection 終了は terminate で Session 終端として通知する", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const clientEnd = waitSessionEnd(clientSession);
    const serverEnd = waitSessionEnd(serverSession);
    const cause = new Error("connection-lost");
    clientSession.terminate(cause);
    serverSession.terminate(new Error("connection-lost"));
    expect((await clientEnd).kind).toBe("connection-closed");
    expect((await clientEnd).error).toBe(cause);
    expect((await serverEnd).kind).toBe("connection-closed");
    // 終端後の送信は拒否し、購読解除は安全である。
    await expect(clientSession.sendReliable({ n: 1 })).rejects.toThrow(SessionError);
    const unsub = clientSession.onEnd(() => {});
    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
    // 終端後に登録した購読者は即時通知を受ける。
    const late = await waitSessionEnd(clientSession);
    expect(late.kind).toBe("connection-closed");
  } finally {
    await disposeMuxPair(pair);
  }
});

test("購読者の例外で内部を壊さない", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    const received: unknown[] = [];
    const unsubThrowing = serverSession.onMessage(() => {
      throw new Error("subscriber-boom");
    });
    const unsubOk = serverSession.onMessage((payload) => {
      received.push(payload);
    });
    // 購読を先に付けてから送る。到着済み分は登録時に渡る。
    const first = collectPayloads(serverSession, 1);
    await clientSession.sendReliable({ n: 7 });
    expect(await first).toEqual([{ n: 7 }]);
    await waitFor(() => received.length === 1, 5000, "例外を投げない購読者への到着");
    // Session は壊れず送受信できる。
    const second = collectPayloads(serverSession, 1);
    await clientSession.sendReliable({ n: 8 });
    expect(await second).toEqual([{ n: 8 }]);
    unsubThrowing();
    unsubOk();
  } finally {
    await disposeMuxPair(pair);
  }
});

test("closeWrite 後の送信は拒否し closeWrite は二重呼び出しできる", async () => {
  const pair = createMuxPair();
  try {
    const { clientSession, serverSession } = await createSessionPair(pair, {
      kind: "reliable",
      direction: "bidirectional",
    });
    await clientSession.closeWrite();
    await clientSession.closeWrite();
    await expect(clientSession.sendReliable({ n: 1 })).rejects.toThrow(SessionError);
    // 受信は継続する。
    await serverSession.sendReliable({ n: 2 });
    expect(await collectPayloads(clientSession, 1)).toEqual([{ n: 2 }]);
  } finally {
    await disposeMuxPair(pair);
  }
});
