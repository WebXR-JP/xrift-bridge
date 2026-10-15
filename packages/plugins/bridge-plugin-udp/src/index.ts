/**
 * UDPプラグインの公開 entry（本体）。
 *
 * プラグイン定義と UI 非依存の状態・操作・統計を提供する。通信契約
 * （データグラム転送の形状と検証）は `./contract` が持ち、ここでは
 * 再 export しない。ブラウザで使う契約だけが必要な箇所は
 * `bridge-plugin-udp/contract` を参照する。
 *
 * @packageDocumentation
 */
export {
  UDP_PLUGIN_ID,
  UDP_PORT_ID,
  createUdpPlugin,
  udpPlugin,
  type UdpBindConfig,
  type UdpControlFailureReason,
  type UdpControlResult,
  type UdpPhase,
  type UdpPluginOperations,
  type UdpPluginOptions,
  type UdpPluginState,
  type UdpSocketAddress,
  type UdpStartParams,
  type UdpStats,
} from "./plugin.ts";
