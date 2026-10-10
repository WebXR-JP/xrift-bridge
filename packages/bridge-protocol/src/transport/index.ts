/**
 * 共通輸送プリミティブ（framing・WS duplex 適合・yamux 生成口）。
 *
 * プラットフォーム固有の WebSocket 適合（Node `ws`・ブラウザ）は含まない。
 * C/D 単位の `RawSocket` 実装から使う。main export（型・検証）とは独立に
 * `bridge-protocol/transport` から導入すること。
 *
 * @packageDocumentation
 */

export { FRAME_MAX_BYTES, FrameDecoder, FrameRejectedError, encodeFrameJson } from "./framing.ts";
export {
  DEFAULT_DRAIN_THRESHOLD_BYTES,
  WsMessageStream,
  type RawSocket,
  type WsMessageStreamOptions,
} from "./message-stream.ts";
export {
  MAX_INBOUND_STREAMS,
  MAX_OUTBOUND_STREAMS,
  MUX_STREAM_WINDOW_BYTES,
  bridgeMuxer,
  type BridgeMuxer,
} from "./muxer.ts";
export {
  Session,
  SessionError,
  type SessionEnd,
  type SessionEndKind,
  type SessionErrorCode,
  type SessionOptions,
  type SessionSide,
  type SessionTerminateReason,
} from "./session.ts";
export {
  KEEPALIVE_FIRST_DELAY_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_PING_TIMEOUT_MS,
  Keepalive,
  type KeepaliveOptions,
} from "./keepalive.ts";
export {
  Connection,
  type ConnectionOptions,
  type ConnectionRole,
  type CreateSessionRequest,
} from "./connection.ts";
export { defaultTimerScheduler, type TimerScheduler } from "./timers.ts";
