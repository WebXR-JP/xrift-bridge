/**
 * ブリッジのサーバーコア。GUI/CLI が利用する管理境界。
 *
 * `127.0.0.1` に明示 bind する WebSocket サーバと、受付の開閉・保留一覧・
 * 承認/拒否・接続管理の API を提供する。import しただけでは起動しない。
 * 起動は {@link createBridgeServer} が返す管理口で行う。
 *
 * @packageDocumentation
 */
export { createBridgeServer, OPERATOR_DISCONNECT_REASON } from "./server.ts";
export type {
  BridgeOptions,
  BridgeServer,
  BridgeSessionInfo,
  BridgeStats,
  ConnectionPhase,
  ConnectionInfo,
  AcceptanceInfo,
  LocalSessionId,
  PendingPairingInfo,
  ApprovalResult,
  RejectionResult,
  ManagementEvent,
  ManagementListener,
  ServerSession,
  Unsubscribe,
} from "./server.ts";
export { DEFAULT_LIMITS, resolveLimits } from "./config.ts";
export type { BridgeLimits } from "./config.ts";
export { BRIDGE_PATH, LOOPBACK_HOST, PRODUCTION_ORIGIN } from "./verify.ts";
export { defaultLogger, logEvent } from "./log.ts";
export type { BridgeLogger, BridgeLogEvent } from "./log.ts";
export { systemClock } from "./clock.ts";
export type { Clock } from "./clock.ts";
