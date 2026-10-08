/** 診断ワールドの3D配置の最小定数。装飾・壁・影は持たない。 */
export const WORLD_CONFIG = {
  /** 床の一辺（メートル）。最小限の歩行範囲に絞る。 */
  size: 20,
} as const;

/** 床の色。 */
export const COLORS = {
  ground: "#8a8f98",
} as const;
