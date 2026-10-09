/**
 * ワールド内からブリッジへ接続するためのクライアント。
 *
 * WebSocket オブジェクトは上位層に公開しない。接続先は loopback に限定する。
 *
 * @packageDocumentation
 */

export { BRIDGE_HOST, BRIDGE_PATH, parseBridgeEndpoint } from "./endpoint.ts";
export { WorldClientError, createWorldClient } from "./client.ts";
export type {
  ConnectOptions,
  ConnectResult,
  ConnectionState,
  EchoResult,
  PairingInfo,
  Unsubscribe,
  WorldClient,
  WorldClientEvent,
  WorldClientListener,
  WorldClientOptions,
} from "./client.ts";
