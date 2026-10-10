/**
 * yamux muxer の生成口。設定はここに集約し、他で yamux を直接 new しない。
 *
 * @packageDocumentation
 */

import { yamux, type YamuxMuxerInit } from "@chainsafe/libp2p-yamux";
import type { StreamMuxerFactory } from "@libp2p/interface";

/**
 * stream 受信 window（初期 window と同値。RTT 既知での自動拡大の抑止に必須）。
 *
 * ライブラリ既定は RTT 既知で受信 window を最大 16MiB まで倍増させるため、
 * 初期 window と同値を明示する。`verifyConfig` は同値を通過する
 * （上限＜初期だけが拒否対象）。
 */
export const MUX_STREAM_WINDOW_BYTES = 256 * 1024;

/** 同時に開ける inbound stream 数の上限。 */
export const MAX_INBOUND_STREAMS = 32;

/** 同時に開ける outbound stream 数の上限。 */
export const MAX_OUTBOUND_STREAMS = 32;

/**
 * この単位で使う muxer の型。
 *
 * `YamuxMuxer` は root から型輸出されていないため、factory の型引数から
 * 取り出す。
 */
export type BridgeMuxer =
  ReturnType<typeof yamux> extends () => StreamMuxerFactory<infer M> ? M : never;

/**
 * ブリッジ用の yamux factory を作る。
 *
 * 固定設定（window 上限・keepalive 無効・本数上限）は呼び出し側の指定より
 * 優先する。輸送層（`WsMessageStream` 等）は呼び出し側で用意し、
 * `createStreamMuxer` に渡すこと。
 *
 * @param init - 呼び出し側の追加指定。固定設定は上書きされる。
 * @returns `createStreamMuxer` に渡す factory。
 */
export function bridgeMuxer(init?: YamuxMuxerInit): () => StreamMuxerFactory<BridgeMuxer> {
  return yamux({
    ...init,
    enableKeepAlive: false,
    maxInboundStreams: MAX_INBOUND_STREAMS,
    maxOutboundStreams: MAX_OUTBOUND_STREAMS,
    streamOptions: { ...init?.streamOptions, maxStreamWindowSize: MUX_STREAM_WINDOW_BYTES },
  });
}
