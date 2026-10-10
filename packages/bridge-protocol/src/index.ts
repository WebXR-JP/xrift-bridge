/**
 * ワールド内クライアントとブリッジ間で共有するプロトコル定義。
 *
 * フィールド名・型・必須/任意の共有定義はここに置く。外部入力の境界検証は
 * `validate.ts`（受信値は `parseBridgeMessage` で検証してから扱うこと）、
 * 動的契約はテスト、上位の設計判断は `design/protocol.md` を見る。
 *
 * @packageDocumentation
 */

export { PAIRING_CODE_LENGTH, PROTOCOL_VERSION } from "./messages.ts";
export type {
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
  PairingCode,
  PairingPendingMessage,
  PairingRequestId,
  PairingStartMessage,
  RequestId,
  SessionId,
  StreamId,
  StreamKind,
} from "./messages.ts";
export {
  MAX_ID_LENGTH,
  ProtocolError,
  formatPairingCode,
  isJsonValue,
  isPairingCode,
  isPairingRequestId,
  parseBridgeMessage,
  stringifyBridgeMessage,
} from "./validate.ts";
export type { ProtocolErrorCode } from "./validate.ts";
export type * as MessagesExample from "./messages.example.ts";
