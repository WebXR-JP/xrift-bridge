/**
 * 管理画面シェルの画面定義。
 *
 * ページヘッダと左ナビが同一定義を参照する。順序はナビの表示順である。
 * 件数は snapshot から都度導出し、ここには載せない（別 signal への複製はしない）。
 */

/** 画面の識別子。Router ではなく App のローカル signal で保持する。 */
export type ViewKey = "connections" | "sessions" | "plugins" | "operations" | "log";

/** 1画面の静的定義。 */
export interface ViewDefinition {
  /** 画面の識別子。 */
  readonly key: ViewKey;
  /** ナビ項目の表示名。 */
  readonly navLabel: string;
  /** `<ng-icon>` に渡す登録名（shell が `provideIcons` で明示登録する）。 */
  readonly iconName: string;
  /** 右ページヘッダの題。 */
  readonly title: string;
  /** 右ページヘッダの副題。 */
  readonly subtitle: string;
}

/** 5画面の定義。順序はナビの表示順である。 */
export const VIEW_DEFINITIONS: readonly ViewDefinition[] = [
  {
    key: "connections",
    navLabel: "接続",
    iconName: "lucidePlug",
    title: "接続",
    subtitle: "接続の受け入れと確立、現在の状態。",
  },
  {
    key: "sessions",
    navLabel: "セッション一覧",
    iconName: "lucideRadio",
    title: "セッション一覧",
    subtitle: "接続中のセッション。",
  },
  {
    key: "plugins",
    navLabel: "プラグイン一覧",
    iconName: "lucidePuzzle",
    title: "プラグイン一覧",
    subtitle: "配置と起動中のプラグインを管理する。",
  },
  {
    key: "operations",
    navLabel: "プラグイン操作",
    iconName: "lucideAppWindow",
    title: "プラグイン操作",
    subtitle: "起動中のプラグインを切り替えて操作する。",
  },
  {
    key: "log",
    navLabel: "受信記録",
    iconName: "lucideScrollText",
    title: "受信記録",
    subtitle: "直近に受信した管理イベント。",
  },
];

/** 初期に選ぶ画面。 */
export const DEFAULT_VIEW_KEY: ViewKey = "connections";
