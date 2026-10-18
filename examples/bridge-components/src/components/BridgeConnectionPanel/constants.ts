/** 接続盤の配置と大きさ（メートル）。 */

/** 盤の既定配置。親からの相対位置である。 */
export const PANEL_POSITION: readonly [number, number, number] = [0, 0, 0];

/** 盤（背面の箱）の大きさ。 */
export const PANEL_SIZE: readonly [number, number, number] = [3.6, 3.1, 0.1];

/** 状態文字板の大きさ。 */
export const STATUS_SIZE: readonly [number, number] = [3.4, 2.1];

/** ボタンを並べる高さ。 */
export const BUTTON_Y = -1.25;

/** ボタンの X 座標（接続・ポート変更・取消／切断）。 */
export const BUTTON_X = [-1.1, 0, 1.1] as const;

/** ボタンの箱の大きさ。 */
export const BUTTON_SIZE: readonly [number, number, number] = [0.62, 0.3, 0.08];

/** ボタン名板の大きさ。 */
export const BUTTON_LABEL_SIZE: readonly [number, number] = [0.58, 0.22];
