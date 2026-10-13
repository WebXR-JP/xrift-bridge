/**
 * プラグイン所有の GUI companion の公開面。
 *
 * 固有 RPC 契約・表示先・限定射影への到達だけを持ち、WebView 生成・
 * transport・束縛・失効は持たない。ホスト側の `PluginCompanionRegistry`
 * 実装はここに置かず、ホストが所有する。具象プラグインの import・既定登録の
 * 副作用・Electrobun/Bun/Node 実体・ホストソースパス参照を持たない。
 *
 * @packageDocumentation
 */
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";

/** 現割当てへの要望。対応付けが配置を作る材料である。 */
export interface CompanionDesiredBinding {
  /** 束縛する実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛する接続口の識別子。 */
  readonly portId: string;
}

/**
 * companion が RPC ハンドラ表を作るときに使う main 側の汎用口。
 *
 * 種別トークンは companion が決め打ちで渡し、子からの入力では選ばない。
 * 子へ生の backend を渡さず、対応付け済みの個体だけを扱う。
 */
export interface CompanionRequestEnv {
  /**
   * 束縛個体の限定表示を改訂番号付きで読む。読み取りは改訂を進めない。
   *
   * @param kind - companion の種別トークン。対応付けの記録と照合する。
   * @param mountId - 照合済みのマウント識別子。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合。
   */
  readSnapshot(kind: string, mountId: string): unknown;
  /**
   * 束縛個体の操作へ委譲する。子は操作の引数だけを渡す。
   *
   * @param kind - companion の種別トークン。対応付けの記録と照合する。
   * @param mountId - 照合済みのマウント識別子。
   * @param params - 操作の引数。本文などの識別子外の値だけを受け付ける。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合（同期的）。
   */
  send(kind: string, mountId: string, params: unknown): Promise<unknown>;
  /**
   * 初期状態取得を受けた記録。変化があれば通知を予約する。
   *
   * @param mountId - 照合済みのマウント識別子。
   */
  markReady(mountId: string): void;
}

/**
 * プラグイン所有の GUI companion の記述子。固有RPC契約・表示先・限定射影への
 * 到達だけを持ち、WebView 生成・transport・束縛・失効は持たない。
 *
 * `viewPath` はホストが解決した同梱子画面の配置先だけを載せる。相対
 * entrypoint の宣言は {@link PluginCompanionDeclaration} が持ち、解決前の
 * companion は登録表に載せない。子画面 URL の組み立ては対応付けが汎用の
 * `buildPluginViewUrl` で行い、ここに種別ごとの組み立ては持たない。
 *
 * backend は factory で capture し、各口の引数には載せない。到達は対応付け済みの
 * 個体だけに限り、子→main の操作名引きの口は作らず、要求名から処理への表は
 * 種別ごとに固定する。失効の合図は射影が `RangeError` で示す。要望読みの失敗は
 * 種類を問わず呼び出し側（対応付けの `readDesired`）が種別単位で隔離する。
 * push・bind 経路の `catch` は `RangeError` 以外も失敗表示に回してクラッシュより
 * 可視失敗を優先し、読取経路が `RangeError` のみ回収するのは入力検証等の失敗で
 * 失効扱いにしないためである。
 */
export interface PluginCompanion {
  /** マウント識別子に載る種別トークン。小文字始まりの英数字であること。 */
  readonly kind: string;
  /** 失敗表示用の種別名（表示名のみ）。 */
  readonly label: string;
  /** 結線後に読み込む同梱子画面の view パス。ホストが解決した値だけを載せる。 */
  readonly viewPath: string;
  /**
   * 現割当ての要望一覧を読む。取得失敗時は例外とし、呼び出し側が隔離する。
   *
   * 到達は factory で capture した限定口だけを使う。
   *
   * @returns 要望の一覧。無ければ空配列。
   */
  listDesired(): CompanionDesiredBinding[];
  /**
   * 束縛個体の限定表示を読む。他個体・管理情報は返さない。
   *
   * @param instanceId - 束縛個体の識別子。対応付けが決める。
   * @throws `RangeError` — 束縛外・現割当て失効の場合。
   */
  readView(instanceId: string): InstanceBaseView;
  /**
   * 限定表示に改訂番号を付けて snapshot にする。
   *
   * @param view - `readView` が返した限定表示。
   * @param revision - 対応付けが持つ改訂番号。
   * @returns 子画面へ渡せる snapshot。
   */
  toSnapshot(view: InstanceBaseView, revision: number): unknown;
  /**
   * 束縛個体の操作へ委譲する。持たない companion は定義しない。
   *
   * @param instanceId - 束縛個体の識別子。対応付けが決める。
   * @param params - 操作の引数。
   * @throws `RangeError` — 束縛外・現割当て失効の場合（同期的）。
   */
  send?(instanceId: string, params: unknown): Promise<unknown>;
  /** main から子画面への状態通知名。 */
  readonly pushMessageName: string;
  /**
   * 個体別 RPC の要求処理を組み立てる。載せた要求だけを子が呼べる。
   *
   * @param mountId - 結び付けるマウント識別子。
   * @param env - main 側の汎用口。
   * @returns 要求名から処理への表。
   */
  buildRequestHandlers(
    mountId: string,
    env: CompanionRequestEnv,
  ): Record<string, (...args: never[]) => unknown>;
}

/**
 * 解決前の companion の宣言。振る舞いと相対 entrypoint だけを持ち、
 * 解決済み view パス・子画面 URL の組み立ては持たない。
 *
 * プラグイン側の factory が返し、composition が静的 manifest と照合して
 * 解決済み view パスを付与し、{@link PluginCompanion} として登録表に載せる。
 * 解決前の宣言を登録表に載せない。
 */
export type PluginCompanionDeclaration = Omit<PluginCompanion, "viewPath"> & {
  /** 子画面の view 配置先を起点とする相対 entrypoint（例 `index.html`）。空でないこと。 */
  readonly viewEntry: string;
};
