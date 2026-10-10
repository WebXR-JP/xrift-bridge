/**
 * ワールド内からブリッジへ接続するためのクライアント。
 *
 * WebSocket オブジェクトは上位層に公開しない。接続先は loopback に限定する。
 *
 * @packageDocumentation
 */

export { BRIDGE_HOST, BRIDGE_PATH, parseBridgeEndpoint } from "./endpoint.ts";
export { WorldClientError, createConnectionRequest } from "./client.ts";
export type { ConnectOptions, ConnectionRequest, PairingInfo } from "./client.ts";
export type {
  CreateSessionOptions,
  CreateSessionRequest,
  InboundSession,
  LatestCreateSessionRequest,
  LatestReceiverSession,
  LatestSenderSession,
  OutboundSession,
  ReliableCreateSessionRequest,
  ReliableSession,
  Session,
  SessionDirection,
  SessionEnd,
  SessionKind,
  SessionProvider,
  ConnectionId,
} from "./session.ts";
