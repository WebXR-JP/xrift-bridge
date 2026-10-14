/**
 * 事前生成物を載せる view 用の汎用スタブ。
 *
 * 実体は事前生成物（管理画面は Angular CLI の `bridge-gui-ui` の `dist`、
 * staged 方式のプラグイン子画面は `src/plugin-view-dist/*` の完成資産）であり、
 * Hutch の view バンドル対象ではない。Hutch は view ごとに entrypoint を
 * 要求するため最小のスタブを置く。生成される `index.js` は載せた側の
 * `index.html` から参照されず無害である（staged 方式では同名の完成資産が
 * `copy` で上書きする）。
 */
export {};
