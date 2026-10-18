import type { BridgeConnection } from "../../connection/connection.ts";
import type { BridgeSnapshot } from "../../connection/types.ts";

/** 接続盤の入力。接続手順は呼び出し側が所有する。 */
export interface Props {
  /** 接続手順。生成前は `null`。 */
  readonly connection: BridgeConnection | null;
  /** 接続状態の写し。生成前は `null`。 */
  readonly snapshot: BridgeSnapshot | null;
  /** 表示中の接続ポート。 */
  readonly port: number;
  /** ポート変更の通知。接続先の組み立ては呼び出し側が行う。 */
  readonly onChangePort: (port: number) => void;
  /** 盤の配置。親からの相対位置である。 */
  readonly position?: readonly [number, number, number];
}
