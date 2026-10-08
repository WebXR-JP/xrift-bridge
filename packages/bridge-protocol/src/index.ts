/**
 * ワールド内クライアントとブリッジ間で共有するプロトコル定義。
 *
 * 仕様の正本は `design/protocol-v0.md` とし、字段名・型・必須/任意の共有定義を
 * 置く。受信値は `parseBridgeMessage` で検証してから扱うこと。
 *
 * @packageDocumentation
 */

export { PROTOCOL_VERSION } from "./messages.ts";
export type {
  AuthMessage,
  AuthOkMessage,
  BridgeMessage,
  BridgeToClientMessage,
  ClientToBridgeMessage,
  CommandErrorDetail,
  CommandRequestMessage,
  CommandResponseMessage,
  CreditMessage,
  DataMessage,
  EchoMessage,
  EchoResponseMessage,
  ErrorMessage,
  MessageBase,
  RequestId,
  SessionId,
  StreamId,
  StreamKind,
} from "./messages.ts";
export {
  MAX_ID_LENGTH,
  ProtocolError,
  isJsonValue,
  parseBridgeMessage,
  stringifyBridgeMessage,
} from "./validate.ts";
export type { ProtocolErrorCode } from "./validate.ts";
