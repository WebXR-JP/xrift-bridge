import type { TextSnapshot } from "../../text/types.ts";

/** 表示板の入力。 */
export interface Props {
  /** テキスト表示用の写し。生成前・切断時は `null`（未受信表示）。 */
  readonly snapshot: TextSnapshot | null;
  /** 板の配置。親からの相対位置である。 */
  readonly position?: readonly [number, number, number];
}
