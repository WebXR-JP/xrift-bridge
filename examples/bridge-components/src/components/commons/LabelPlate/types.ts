/** 単一行の名板の入力。 */
export interface Props {
  /** 表示する文字列。 */
  readonly text: string;
  /** 名板の背景色。 */
  readonly background: string;
  /** 名板の幅（メートル）。 */
  readonly width: number;
  /** 名板の高さ（メートル）。 */
  readonly height: number;
}
