/**
 * 採用可否の観測シナリオ群。
 *
 * 各関数は一時ポートの Node サーバ・Node クライアントを立て、項目を
 * 実行して生の観測（成否・振る舞い・数値）を返す。`tests/` と
 * `src/scenario-main.ts`（生出力の表示）の両方から使う。
 *
 * @packageDocumentation
 */

import type { WebSocket } from "ws";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import type { StreamMessageEvent } from "@libp2p/interface";
import { encodeFrameJson, FrameDecoder } from "./framing.ts";
import { runPreludeClient, runPreludeServer, waitForConnection } from "./prelude.ts";
import {
  attachMuxer,
  connectSpikeSocket,
  createPeerLogs,
  readChunk,
  sleep,
  startSpikeServer,
  waitFor,
  waitForInboundStream,
  waitForInboundStreams,
  type PeerLogs,
  type SpikeMuxer,
  type SpikeServer,
  type TransportCapture,
} from "./peer.ts";
import type { OutgoingPolicy } from "./ws-transport.ts";

/** シナリオ1件分の観測結果。 */
export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  /** 人間向けの生の観測メモ（成功・失敗の両方を残す）。 */
  readonly notes: string[];
  /** 機械可読の観測値。 */
  readonly data: Record<string, unknown>;
}

/** 両端の接続束。使い終わったら `disposePair` で閉じる。 */
interface Pair {
  readonly server: SpikeServer;
  readonly serverWs: WebSocket;
  readonly clientWs: WebSocket;
  readonly serverMuxer: SpikeMuxer;
  readonly clientMuxer: SpikeMuxer;
  readonly serverLogs: PeerLogs;
  readonly clientLogs: PeerLogs;
}

/** `makePair` の任意指定。 */
interface MakePairOptions {
  readonly serverCapture?: TransportCapture;
  readonly clientCapture?: TransportCapture;
  /** 真の場合だけ window 抑止を外す（対照実験用）。 */
  readonly uncappedWindow?: boolean;
}

/** プリリュードなしで直接 mux を開始したペアを作る。 */
async function makePair(outgoing?: OutgoingPolicy, options?: MakePairOptions): Promise<Pair> {
  const server = await startSpikeServer();
  const serverLogs = createPeerLogs("server");
  const clientLogs = createPeerLogs("client");
  const accepted = waitForConnection(server.wss);
  const clientWs = await connectSpikeSocket(server.url);
  const serverWs = await accepted;
  const uncappedWindow = options?.uncappedWindow ?? false;
  const serverMuxer = attachMuxer(
    serverWs,
    "inbound",
    serverLogs,
    outgoing,
    {
      enableKeepAlive: false,
    },
    options?.serverCapture,
    uncappedWindow,
  );
  const clientMuxer = attachMuxer(
    clientWs,
    "outbound",
    clientLogs,
    outgoing,
    {
      enableKeepAlive: false,
    },
    options?.clientCapture,
    uncappedWindow,
  );
  return { server, serverWs, clientWs, serverMuxer, clientMuxer, serverLogs, clientLogs };
}

/** プリリュード境界を経て mux を開始したペアを作る。 */
async function makePairWithPrelude(): Promise<Pair> {
  const server = await startSpikeServer();
  const serverLogs = createPeerLogs("server");
  const clientLogs = createPeerLogs("client");
  const accepted = waitForConnection(server.wss);
  const clientWs = await connectSpikeSocket(server.url);
  const serverWs = await accepted;
  await Promise.all([runPreludeServer(serverWs), runPreludeClient(clientWs)]);
  const serverMuxer = attachMuxer(serverWs, "inbound", serverLogs, undefined, {
    enableKeepAlive: false,
  });
  const clientMuxer = attachMuxer(clientWs, "outbound", clientLogs, undefined, {
    enableKeepAlive: false,
  });
  return { server, serverWs, clientWs, serverMuxer, clientMuxer, serverLogs, clientLogs };
}

/** ペアを後片付けする。順に閉じて取りこぼしを出さない。 */
async function disposePair(pair: Pair): Promise<void> {
  await pair.clientMuxer.close().catch(() => undefined);
  await pair.serverMuxer.close().catch(() => undefined);
  pair.clientWs.close();
  pair.serverWs.close();
  await sleep(50);
  await pair.server.close();
}

/** stream の出来事を順に記録する。 */
function watchStream(stream: YamuxStream, tag: string, out: string[]): void {
  const record = (type: string) => (): void => {
    out.push(`${tag}:${type}`);
  };
  stream.addEventListener("message", (event) => {
    out.push(`${tag}:message(${(event as StreamMessageEvent).data.byteLength}B)`);
  });
  stream.addEventListener("end", record("end"));
  stream.addEventListener("close", record("close"));
  stream.addEventListener("remoteCloseWrite", record("remoteCloseWrite"));
  stream.addEventListener("idle", record("idle"));
  stream.addEventListener("drain", record("drain"));
}

/** 期待件数の framing 値を stream から集める。 */
async function collectFrames(
  stream: YamuxStream,
  count: number,
  timeoutMs = 5000,
): Promise<unknown[]> {
  const decoder = new FrameDecoder();
  const out: unknown[] = [];
  const started = Date.now();
  while (out.length < count) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`framing ${count}件の受信が期限切れ（${out.length}件のみ）`);
    }
    const chunk = await readChunk(stream, timeoutMs);
    out.push(...decoder.push(chunk));
  }
  return out;
}

/** 1往復の echo を行う。サーバ側は受けた値をそのまま返す。 */
async function echoOnce(
  clientStream: YamuxStream,
  serverStream: YamuxStream,
  value: unknown,
): Promise<unknown> {
  clientStream.send(encodeFrameJson(value));
  const received = await collectFrames(serverStream, 1);
  serverStream.send(encodeFrameJson(received[0]));
  const echoed = await collectFrames(clientStream, 1);
  return echoed[0];
}

/** 結果の雛形を作る。 */
function newResult(): { notes: string[]; data: Record<string, unknown> } {
  return { notes: [], data: {} };
}

/**
 * 多重化: 複数 stream を同時に開き、独立に往復できる。
 */
export async function scenarioMultiplex(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const pair = await makePair();
  try {
    const count = 4;
    const opened = await Promise.all(
      Array.from({ length: count }, () => pair.clientMuxer.createStream()),
    );
    // 1つの受け口でまとめて取る。受け口を複数並べると最初の1件が全員に届くため。
    const accepted = await waitForInboundStreams(pair.serverMuxer, count);
    data["clientStreamIds"] = opened.map((s) => s.streamId);
    data["serverStreamIds"] = accepted.map((s) => s.streamId);
    const rounds = await Promise.all(
      opened.map((clientStream, index) =>
        echoOnce(clientStream, accepted[index]!, { stream: index }),
      ),
    );
    data["echoed"] = rounds;
    const ok = rounds.every((value, index) => (value as { stream: number }).stream === index);
    notes.push(`4本の同時 echo は${ok ? "すべて対応関係を保って往復した" : "対応が崩れた"}`);
    for (const stream of [...opened, ...accepted]) await stream.close().catch(() => undefined);
    return { name: "多重化", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/**
 * WS 分割: 1つの yamux 書き込みを複数 WS メッセージに割っても復元できる。
 */
export async function scenarioSplit(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  // 7B 刻みは yamux ヘッダ（12B）・framing 長（4B）・JSON 本体のいずれとも
  // 噛み合わない刻みであり、境界またぎの復元を確かめられる。
  const clientCapture: TransportCapture = {};
  const pair = await makePair({ kind: "split", maxChunkBytes: 7 }, { clientCapture });
  try {
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    const value = { text: "分割しても壊れないこと", n: 42 };
    const frameBytes = encodeFrameJson(value).byteLength;
    const echoed = await echoOnce(clientStream, serverStream, value);
    const restored = JSON.stringify(echoed) === JSON.stringify(value);
    // 送出数の記録。分割が発動していれば WS メッセージ数は書き込み数を上回る。
    const transport = clientCapture.transport;
    if (transport === undefined) throw new Error("輸送層を観測できない");
    const writes = transport.sendDataCalls;
    const messages = transport.wsMessageCount;
    data["frameBytes"] = frameBytes;
    data["sendDataCalls"] = writes;
    data["wsMessageCount"] = messages;
    const splitFired = messages > writes;
    notes.push(`7B刻み分割での echo は${restored ? "復元できた" : "復元できなかった"}`);
    notes.push(
      `送信側は yamux 書き込み ${writes}回に対し WS メッセージ ${messages}件で、` +
        `${splitFired ? "分割が実際に発動した" : "分割が発動していない（退化）"}`,
    );
    const ok = restored && splitFired;
    await clientStream.close().catch(() => undefined);
    await serverStream.close().catch(() => undefined);
    return { name: "WS分割", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/**
 * WS 集約: 複数の yamux 書き込みを1メッセージに束ねても復元できる。
 */
export async function scenarioCoalesce(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const clientCapture: TransportCapture = {};
  const pair = await makePair({ kind: "coalesce", delayMs: 25 }, { clientCapture });
  try {
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    // 集約窓へ意図的に詰め込むため間隔を空けずに連打する。
    const values = [0, 1, 2, 3, 4].map((n) => ({ n }));
    for (const value of values) clientStream.send(encodeFrameJson(value));
    const received = await collectFrames(serverStream, values.length);
    const restored = JSON.stringify(received) === JSON.stringify(values);
    // 送出数の記録。集約が発動していれば WS メッセージ数は書き込み数を下回る。
    const transport = clientCapture.transport;
    if (transport === undefined) throw new Error("輸送層を観測できない");
    const writes = transport.sendDataCalls;
    const messages = transport.wsMessageCount;
    data["received"] = received;
    data["sendDataCalls"] = writes;
    data["wsMessageCount"] = messages;
    const coalesced = messages < writes;
    notes.push(`25ms集約での5連打は${restored ? "順序どおり復元できた" : "復元できなかった"}`);
    notes.push(
      `送信側は yamux 書き込み ${writes}回に対し WS メッセージ ${messages}件で、` +
        `${coalesced ? "集約が実際に発動した" : "集約が発動していない（退化）"}`,
    );
    const ok = restored && coalesced;
    await clientStream.close().catch(() => undefined);
    await serverStream.close().catch(() => undefined);
    return { name: "WS集約", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/**
 * FIN: 片方向を正常終了し、逆方向は継続できる。
 */
export async function scenarioFin(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const pair = await makePair();
  try {
    const events: string[] = [];
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    watchStream(clientStream, "client", events);
    watchStream(serverStream, "server", events);
    clientStream.send(encodeFrameJson({ hello: "fin" }));
    const received = await collectFrames(serverStream, 1);
    // クライアントの送信方向だけを閉じる。
    await clientStream.close();
    notes.push("client.close()（FIN 送出）は完了した");
    await waitFor(
      () => events.includes("server:remoteCloseWrite") && events.includes("server:end"),
      5000,
      "サーバ側の FIN 観測",
    );
    notes.push("サーバ側で remoteCloseWrite→end を観測した（受信済みデータの後に終わる）");
    // 逆方向は継続できる。
    serverStream.send(encodeFrameJson({ reply: "reverse-ok" }));
    const reply = await collectFrames(clientStream, 1);
    const reverseOk = JSON.stringify(reply[0]) === JSON.stringify({ reply: "reverse-ok" });
    notes.push(`逆方向の送信は${reverseOk ? "届いた" : "届かなかった"}`);
    await serverStream.close();
    await waitFor(
      () => events.includes("client:remoteCloseWrite") && events.includes("client:end"),
      5000,
      "クライアント側の FIN 観測",
    );
    notes.push("双方 FIN で Session が終わり、muxer は開いたままである");
    data["events"] = events;
    data["received"] = received;
    data["clientMuxerStatus"] = pair.clientMuxer.status;
    data["serverMuxerStatus"] = pair.serverMuxer.status;
    const ok =
      reverseOk && pair.clientMuxer.status === "open" && pair.serverMuxer.status === "open";
    return { name: "FIN", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/**
 * RST: 対象 stream を即時中断し、他 stream が影響を受けない。
 */
export async function scenarioRst(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const pair = await makePair();
  try {
    const events: string[] = [];
    const streamA = await pair.clientMuxer.createStream();
    const streamB = await pair.clientMuxer.createStream();
    const serverA = await waitForInboundStream(pair.serverMuxer);
    const serverB = await waitForInboundStream(pair.serverMuxer);
    watchStream(serverA, "serverA", events);
    watchStream(serverB, "serverB", events);
    streamA.send(encodeFrameJson({ a: 1 }));
    await collectFrames(serverA, 1);
    // A だけを即時中断する。
    streamA.abort(new Error("spike-rst"));
    notes.push("streamA.abort()（RST 送出）は同期で完了した");
    await waitFor(() => events.includes("serverA:close"), 5000, "サーバ側 A の中断観測");
    notes.push("サーバ側 A で close を観測した");
    // B は影響を受けない。
    const echoed = await echoOnce(streamB, serverB, { b: 2 });
    const unaffected = JSON.stringify(echoed) === JSON.stringify({ b: 2 });
    notes.push(`streamB の echo は${unaffected ? "継続できた" : "壊れた"}`);
    await waitFor(() => pair.clientMuxer.streams.length <= 1, 5000, "中断 stream の除去").catch(
      () => {
        notes.push(
          "中断 stream の muxer 一覧からの除去は期限内に確認できない（残存は許容範囲として記録）",
        );
      },
    );
    data["events"] = events;
    data["serverAStatus"] = serverA.status;
    data["muxerStreams"] = pair.clientMuxer.streams.length;
    const ok =
      unaffected &&
      events.includes("serverA:close") &&
      !events.some((e) => e.startsWith("serverB:close"));
    return { name: "RST", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/**
 * GoAway: mux 全体の終了が観測できる。
 */
export async function scenarioGoAway(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const pair = await makePair();
  try {
    const events: string[] = [];
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    watchStream(serverStream, "server", events);
    await echoOnce(clientStream, serverStream, { g: 0 });
    await pair.clientMuxer.close();
    notes.push("clientMuxer.close()（GoAway 送出）は完了した");
    await waitFor(() => pair.serverMuxer.status === "closed", 5000, "サーバ muxer の終了");
    notes.push(`サーバ muxer の状態は ${pair.serverMuxer.status} になった`);
    await sleep(100);
    data["events"] = events;
    data["serverMuxerStatus"] = pair.serverMuxer.status;
    data["clientMuxerStatus"] = pair.clientMuxer.status;
    data["serverStreamStatus"] = serverStream.status;
    const ok = pair.serverMuxer.status === "closed" && pair.clientMuxer.status === "closed";
    return { name: "GoAway", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/**
 * window/backpressure: 256KiB 超の送信で遅い読み取り側に待たされること、
 * および送信完了の意味（相手受信ではなく local 送出）を観測する。
 */
export async function scenarioWindow(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const pair = await makePair();
  try {
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    // 読み遅れ側を作る。pause は window 更新を止める公開手段である。
    serverStream.pause();
    notes.push("サーバ stream を pause した（window 更新が止まる）");
    const chunk = new Uint8Array(32 * 1024);
    chunk.fill(0x61);
    let acceptedSends = 0;
    let rejectedSends = 0;
    const totalSends = 40; // 1280KiB。初期 window（256KiB）を確実に超える。
    for (let index = 0; index < totalSends; index += 1) {
      const accepted = clientStream.send(chunk);
      if (accepted) acceptedSends += 1;
      else rejectedSends += 1;
    }
    data["acceptedSends"] = acceptedSends;
    data["rejectedSends"] = rejectedSends;
    data["writeBufferLength"] = clientStream.writeBufferLength;
    notes.push(
      `${totalSends}回送出のうち ${acceptedSends}回が受け付け・${rejectedSends}回が拒否（false）で、` +
        `未送出 ${clientStream.writeBufferLength}B が writeBuffer に残った`,
    );
    // 読みを止めている間は drain しないことを確かめる。
    const drainWhilePaused = await Promise.race([
      clientStream.onDrain().then(() => true),
      sleep(300).then(() => false),
    ]);
    data["drainWhilePaused"] = drainWhilePaused;
    notes.push(
      `pause 中の onDrain は${drainWhilePaused ? "解けた（想定外）" : "300ms 待っても解けない（待たされる）"}`,
    );
    // 読みを再開すると送出が進む。
    serverStream.resume();
    notes.push("サーバ stream を resume した");
    await clientStream.onDrain();
    notes.push("resume 後に onDrain が解けた（window 更新で送出再開）");
    // 全量が届くことを確かめる。
    const expected = totalSends * chunk.byteLength;
    let received = 0;
    const started = Date.now();
    while (received < expected) {
      if (Date.now() - started > 10000) throw new Error("全量受信が期限切れになった");
      const part = await readChunk(serverStream, 10000);
      received += part.byteLength;
    }
    data["receivedBytes"] = received;
    notes.push(`${received}B を全量受信した。send() の戻りは同期の可否であり Promise ではない`);
    // 送信完了の時点を確かめる。close() は送出待ちを満たしてから FIN する。
    const closeStarted = Date.now();
    await clientStream.close();
    const closeElapsedMs = Date.now() - closeStarted;
    data["closeElapsedMs"] = closeElapsedMs;
    notes.push(
      `close() は ${closeElapsedMs}ms で完了した（相手の受信・業務完了ではなく local 送出完了の時点。` +
        "相手が読んだ保証にはならない）",
    );
    await serverStream.close().catch(() => undefined);
    const ok = rejectedSends > 0 && !drainWhilePaused && received === expected;
    return { name: "window/backpressure", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/** 受信 window の現在値を読む（試作の観測対象）。 */
function readRecvWindow(stream: YamuxStream): number {
  // ADR: recvWindow は型上 private だが実行時は公開 field であり、
  // 自動拡大の抑止が効くかの直接証拠に必要なため構造で読み取る。
  // 存在しなければ観測不能として失敗する（偽装しない）。
  const record = stream as unknown as { recvWindow?: unknown };
  if (typeof record.recvWindow !== "number") throw new Error("recvWindow を観測できない");
  return record.recvWindow;
}

/** RTT を両方向で確知させ、5MiB を流して受信 window の最大値を測る。 */
async function measureRecvWindowGrowth(uncappedWindow: boolean): Promise<{
  maxRecvWindow: number;
  initialRecvWindow: number;
  clientRtt: number;
  serverRtt: number;
}> {
  const pair = await makePair(undefined, { uncappedWindow });
  try {
    // ping で RTT を確知させる。自動拡大は RTT 既知が条件のため。
    const clientRtt = await pair.clientMuxer.ping();
    const serverRtt = await pair.serverMuxer.ping();
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    const initialRecvWindow = readRecvWindow(serverStream);
    const chunk = new Uint8Array(32 * 1024);
    chunk.fill(0x62);
    const totalSends = 160; // 5MiB。初期 window（256KiB）を大幅に超える。
    let maxRecvWindow = initialRecvWindow;
    const reading = (async (): Promise<number> => {
      let received = 0;
      const expected = totalSends * chunk.byteLength;
      const started = Date.now();
      while (received < expected) {
        if (Date.now() - started > 20000) throw new Error("全量受信が期限切れになった");
        const part = await readChunk(serverStream, 20000);
        received += part.byteLength;
        maxRecvWindow = Math.max(maxRecvWindow, readRecvWindow(serverStream));
      }
      return received;
    })();
    for (let index = 0; index < totalSends; index += 1) clientStream.send(chunk);
    const receivedBytes = await reading;
    if (receivedBytes !== totalSends * chunk.byteLength) throw new Error("受信量が一致しない");
    await clientStream.close().catch(() => undefined);
    await serverStream.close().catch(() => undefined);
    return { maxRecvWindow, initialRecvWindow, clientRtt, serverRtt };
  } finally {
    await disposePair(pair);
  }
}

/**
 * window 拡大抑止: RTT 既知でも受信 window が 256KiB を超えて拡大しない。
 */
export async function scenarioWindowNoGrowth(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const measured = await measureRecvWindowGrowth(false);
  const cap = 256 * 1024;
  data["initialRecvWindow"] = measured.initialRecvWindow;
  data["maxRecvWindow"] = measured.maxRecvWindow;
  data["clientRttMs"] = measured.clientRtt;
  data["serverRttMs"] = measured.serverRtt;
  const suppressed = measured.maxRecvWindow <= cap;
  notes.push(
    `ping 往復は client ${measured.clientRtt}ms・server ${measured.serverRtt}ms（RTT 確知）`,
  );
  notes.push(
    `受信 window は初期 ${measured.initialRecvWindow}B に対し最大 ${measured.maxRecvWindow}B で、5MiB 送信後も` +
      (suppressed
        ? "256KiB を超えて拡大しない（抑止設定が効く）"
        : "256KiB を超えて拡大した（抑止なしの混入）"),
  );
  return { name: "window拡大抑止", ok: suppressed, notes, data };
}

/**
 * window 拡大の対照: 抑止を外すと RTT 既知で受信 window が拡大する。
 */
export async function scenarioWindowGrowthControl(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const measured = await measureRecvWindowGrowth(true);
  const cap = 256 * 1024;
  data["initialRecvWindow"] = measured.initialRecvWindow;
  data["maxRecvWindow"] = measured.maxRecvWindow;
  data["clientRttMs"] = measured.clientRtt;
  data["serverRttMs"] = measured.serverRtt;
  const grew = measured.maxRecvWindow > cap;
  notes.push(
    `抑止なしでは受信 window が初期 ${measured.initialRecvWindow}B から最大 ${measured.maxRecvWindow}B へ`,
  );
  notes.push(
    grew ? `256KiB を超えて拡大した（対照として記録）` : `拡大しなかった（対照の再現に失敗）`,
  );
  return { name: "window拡大の対照", ok: grew, notes, data };
}

/**
 * keepalive/Ping: 公開 ping の往復と、失敗時の振る舞いを観測する。
 */
export async function scenarioPing(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const server = await startSpikeServer();
  const serverLogs = createPeerLogs("server");
  const clientLogs = createPeerLogs("client");
  const accepted = waitForConnection(server.wss);
  const clientWs = await connectSpikeSocket(server.url);
  const serverWs = await accepted;
  // keepalive 有効の muxer で開始し、内蔵 ping が動くかも見る。
  const serverMuxer = attachMuxer(serverWs, "inbound", serverLogs, undefined, {
    enableKeepAlive: true,
    keepAliveInterval: 50,
  });
  const clientMuxer = attachMuxer(clientWs, "outbound", clientLogs, undefined, {
    enableKeepAlive: true,
    keepAliveInterval: 50,
  });
  try {
    const rtt = await clientMuxer.ping();
    data["rttMs"] = rtt;
    data["getRTT"] = clientMuxer.getRTT();
    notes.push(`ping() は ${rtt}ms で解決した（往復経路と相手 yamux 処理の動作のみを示す）`);
    await sleep(200);
    const pingFrames = serverLogs.records.filter((record) =>
      record.message.toLowerCase().includes("ping"),
    ).length;
    data["keepAlivePingFrames"] = pingFrames;
    notes.push(
      pingFrames > 0
        ? `内蔵 keepalive（50ms間隔）は ping frame を送受信した（観測 ${pingFrames}件）`
        : "内蔵 keepalive の ping frame はログで確認できない",
    );
    // 輸送を abrupt に落とし、ping 失敗と muxer の振る舞いを見る。
    serverWs.terminate();
    await waitFor(() => clientMuxer.status === "closed", 5000, "切断後の muxer 終了");
    notes.push(`輸送喪失後に client muxer は ${clientMuxer.status} になった`);
    let pingError = "";
    try {
      await clientMuxer.ping();
      notes.push("終了後の ping() は解決した（想定外）");
    } catch (cause) {
      pingError = `${(cause as Error).name}: ${(cause as Error).message}`;
      notes.push(`終了後の ping() は拒否した（${pingError}）`);
    }
    data["pingAfterCloseError"] = pingError;
    const ok = Number.isFinite(rtt) && pingError !== "" && clientMuxer.status === "closed";
    return { name: "keepalive/Ping", ok, notes, data };
  } finally {
    await clientMuxer.close().catch(() => undefined);
    await serverMuxer.close().catch(() => undefined);
    clientWs.close();
    await sleep(50);
    await server.close();
  }
}

/**
 * 認可後 mux 開始: プリリュードのテキスト境界を越えて同じソケットで mux が動く。
 */
export async function scenarioPrelude(): Promise<ScenarioResult> {
  const { notes, data } = newResult();
  const pair = await makePairWithPrelude();
  try {
    notes.push("pairing_start→auth_ok のテキスト交換が終わり、同じソケットで mux を開始した");
    const clientStream = await pair.clientMuxer.createStream();
    const serverStream = await waitForInboundStream(pair.serverMuxer);
    const echoed = await echoOnce(clientStream, serverStream, { after: "auth" });
    const ok = JSON.stringify(echoed) === JSON.stringify({ after: "auth" });
    notes.push(`認可後の echo は${ok ? "往復した（テキストとバイナリは混ざらない）" : "壊れた"}`);
    data["echoed"] = echoed;
    await clientStream.close().catch(() => undefined);
    await serverStream.close().catch(() => undefined);
    return { name: "認可後mux開始", ok, notes, data };
  } finally {
    await disposePair(pair);
  }
}

/** 全シナリオの一覧。 */
export const ALL_SCENARIOS: ReadonlyArray<() => Promise<ScenarioResult>> = [
  scenarioPrelude,
  scenarioMultiplex,
  scenarioSplit,
  scenarioCoalesce,
  scenarioFin,
  scenarioRst,
  scenarioGoAway,
  scenarioWindow,
  scenarioWindowNoGrowth,
  scenarioWindowGrowthControl,
  scenarioPing,
];
