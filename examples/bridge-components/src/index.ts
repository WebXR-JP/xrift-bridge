/**
 * XRift ワールド向けサンプルコンポーネントの公開 entry。
 *
 * ローカルブリッジへの接続（`BridgeConnection`・`useBridgeConnection`）と、
 * 認可後にテキスト表示要求を受ける手順（`TextReceiver`・`useTextReceiver`）を
 * UI 非依存の層として提供し、3D 側の部品（接続盤・テキスト表示板）と、それらを
 * 結線した示例（`BridgeExample`）を重ねる。
 *
 * 通信の意味は `world-client` と `bridge-plugin-text/contract` を正本とする。
 *
 * @packageDocumentation
 */
export { BridgeConnection } from "./connection/connection.ts";
export { useBridgeConnection, type UseBridgeConnectionArgs } from "./connection/hooks.ts";
export type {
  BridgeConnectionOptions,
  BridgeErrorView,
  BridgeListener,
  BridgePhase,
  BridgeSnapshot,
  CreateConnectionRequestFn,
  PairingView,
} from "./connection/types.ts";
export { TextReceiver, type TextReceiverOptions } from "./text/receiver.ts";
export { useTextReceiver, type UseTextReceiverArgs } from "./text/hooks.ts";
export type { TextListener, TextReceiveStatus, TextSnapshot } from "./text/types.ts";
export { DEFAULT_PORT, buildEndpoint, parsePortInput, type ParsedPort } from "./endpoint.ts";
export { CanvasPlate } from "./components/commons/CanvasPlate/index.tsx";
export type { Props as CanvasPlateProps } from "./components/commons/CanvasPlate/types.ts";
export { LabelPlate } from "./components/commons/LabelPlate/index.tsx";
export type { Props as LabelPlateProps } from "./components/commons/LabelPlate/types.ts";
export { BridgeConnectionPanel } from "./components/BridgeConnectionPanel/index.tsx";
export type { Props as BridgeConnectionPanelProps } from "./components/BridgeConnectionPanel/types.ts";
export { BridgeTextBoard } from "./components/BridgeTextBoard/index.tsx";
export type { Props as BridgeTextBoardProps } from "./components/BridgeTextBoard/types.ts";
export {
  BridgeExample,
  type Props as BridgeExampleProps,
} from "./components/BridgeExample/index.tsx";
