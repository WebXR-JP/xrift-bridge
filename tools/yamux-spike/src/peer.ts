/**
 * 試作の相手方（Node サーバ・Node クライアント）の組み立て。
 *
 * 各シナリオは一時ポートのサーバを立て、mux を両端に作って閉じる。
 * 製品の `packages/bridge-server`（サーバーコア）とは無関係の隔離した組み立てである。
 *
 * @packageDocumentation
 */

import { WebSocket, WebSocketServer } from "ws";
import { yamux, type YamuxMuxerInit } from "@chainsafe/libp2p-yamux";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import type { Logger, StreamMessageEvent, StreamMuxerFactory } from "@libp2p/interface";
import { wrapNodeSocket } from "./node-socket.ts";
import { WsMessageStream, type OutgoingPolicy } from "./ws-transport.ts";
import { createSpikeLogger, type SpikeLogRecord } from "./spike-logger.ts";

/** 観測用ログの集め先。 */
export interface PeerLogs {
  readonly records: SpikeLogRecord[];
  readonly logger: Logger;
}

/**
 * この試作で使う muxer の型。
 *
 * `YamuxMuxer` は root から型輸出されていないため、factory の型引数から
 * 取り出す（`ping()` を含む具体型が必要なため）。
 */
export type SpikeMuxer =
  ReturnType<typeof yamux> extends () => StreamMuxerFactory<infer M> ? M : never;

/** ログを集める入れ物を作る。 */
export function createPeerLogs(scope: string): PeerLogs {
  const records: SpikeLogRecord[] = [];
  return { records, logger: createSpikeLogger(scope, (record) => records.push(record)) };
}

/** 一時サーバとURLの束。 */
export interface SpikeServer {
  readonly wss: WebSocketServer;
  readonly url: string;
  /** 待ち受けを閉じる。 */
  close(): Promise<void>;
}

/**
 * 一時ポートで待ち受ける。
 *
 * @returns サーバと接続先 URL。
 */
export async function startSpikeServer(): Promise<SpikeServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.on("listening", () => resolve());
    wss.on("error", (cause: Error) => reject(cause));
  });
  const address = wss.address();
  if (typeof address !== "object" || address === null) throw new Error("待ち受け住所が取れない");
  const url = `ws://127.0.0.1:${address.port}/spike`;
  return {
    wss,
    url,
    close(): Promise<void> {
      return new Promise((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

/**
 * クライアントとして接続する。
 *
 * @param url - 接続先。
 * @returns 開いたソケット。
 */
export async function connectSpikeSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (cause: Error) => reject(cause));
  });
  return ws;
}

/** 試作で採用した stream window（初期 window と同値。自動拡大の抑止が目的）。 */
export const SPIKE_STREAM_WINDOW_BYTES = 256 * 1024;

/** `attachMuxer` で輸送層を受け取る観測口。 */
export interface TransportCapture {
  transport?: WsMessageStream;
}

/**
 * 接続済みソケットの上に yamux muxer を作る。
 *
 * @param ws - プリリュード完了後のソケット（直接 mux 開始の場合も同じ）。
 * @param direction - サーバ側は `inbound`、開始側は `outbound`（stream ID 割当のため）。
 * @param logs - 観測用ログ。
 * @param outgoing - 送信方針（分割・集約の観測用）。
 * @param init - yamux の採用値（keepalive・本数上限など）。
 * @param capture - 輸送層の観測口。WS メッセージ数の数え上げに使う。
 * @param uncappedWindow - 真の場合だけ window 抑止を外す（対照実験用。既定は抑止する）。
 * @returns 両端の muxer。
 */
export function attachMuxer(
  ws: WebSocket,
  direction: "inbound" | "outbound",
  logs: PeerLogs,
  outgoing?: OutgoingPolicy,
  init?: YamuxMuxerInit,
  capture?: TransportCapture,
  uncappedWindow = false,
): SpikeMuxer {
  const transport = new WsMessageStream(wrapNodeSocket(ws), {
    direction,
    log: logs.logger,
    outgoing,
  });
  if (capture !== undefined) capture.transport = transport;
  // ADR: ライブラリ既定は RTT 既知で受信 window を最大 16MiB まで倍増させるため、
  // 設計の「自動拡大しない」を守る必須設定として初期 window と同値を明示する。
  // verifyConfig は同値を通過する（上限＜初期だけが拒否対象）。対照実験以外で外さない。
  const cappedInit: YamuxMuxerInit = uncappedWindow
    ? (init ?? {})
    : {
        ...init,
        streamOptions: { ...init?.streamOptions, maxStreamWindowSize: SPIKE_STREAM_WINDOW_BYTES },
      };
  return yamux(cappedInit)().createStreamMuxer(transport);
}

/** muxer の `stream` イベントから相手開始 stream をまとめて取り出す。 */
export function waitForInboundStreams(
  muxer: SpikeMuxer,
  count: number,
  timeoutMs = 5000,
): Promise<YamuxStream[]> {
  return new Promise((resolve, reject) => {
    const out: YamuxStream[] = [];
    const timer = setTimeout(() => {
      muxer.removeEventListener("stream", onStream);
      reject(new Error(`inbound stream の到着が期限切れになった（${out.length}/${count}件のみ）`));
    }, timeoutMs);
    const onStream = (event: Event): void => {
      out.push((event as CustomEvent<YamuxStream>).detail);
      if (out.length === count) {
        clearTimeout(timer);
        muxer.removeEventListener("stream", onStream);
        resolve(out);
      }
    };
    muxer.addEventListener("stream", onStream);
  });
}

/** muxer の `stream` イベントから相手開始 stream を1件取り出す。 */
export function waitForInboundStream(muxer: SpikeMuxer, timeoutMs = 5000): Promise<YamuxStream> {
  return waitForInboundStreams(muxer, 1, timeoutMs).then((streams) => streams[0]!);
}

/** stream の `message` 断片を1件取り出す。 */
export function readChunk(stream: YamuxStream, timeoutMs = 5000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("stream 受信が期限切れになった"));
    }, timeoutMs);
    const onMessage = (event: StreamMessageEvent): void => {
      const data = event.data;
      cleanup();
      resolve(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.subarray()));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("受信前に stream が閉じた"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("close", onClose);
    };
    stream.addEventListener("message", onMessage);
    stream.addEventListener("close", onClose);
  });
}

/** 条件が満たされるまで待つ。満たされなければ期限切れで失敗する。 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  what = "条件",
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`${what} が ${timeoutMs}ms 以内に満たされない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 指定ミリ秒だけ待つ。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
