/** 文字板の入力。 */
export interface Props {
  /** 表示する行。上から順に描く。 */
  readonly lines: readonly string[];
  /** 板の幅（メートル）。 */
  readonly width: number;
  /** 板の高さ（メートル）。 */
  readonly height: number;
  /** 行ごとの文字色。省略時は既定色で描く。 */
  readonly colorOf?: (line: string) => string;
}
