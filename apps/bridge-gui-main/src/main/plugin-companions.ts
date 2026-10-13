/**
 * プラグイン所有の GUI companion の静的登録表。
 *
 * companion（固有RPC契約・子画面UI・main側アダプター）は `src/plugin-ui/<種別>/`
 * が所有し、ホストはこの登録表で種別トークンから記述子を引く。
 * 共通の対応付け・結線（binder・coordinator・channel factory）は種別分岐を
 * 持たず、ここから引いた記述子に委譲する。新しい companion の追加はこの表への
 * 登録だけであり、共通コードの分岐追加は要らない。
 *
 * 実同梱には登録表への追加だけでは足りない。共通対応付け層の範囲に限り、
 * 登録だけで配置・結線・状態取得・push が通る。子画面の実体は別途
 * `electrobun.config.ts` の `build.views`（子画面 entrypoint）と `copy`
 * （HTML・CSS の同梱）に載せ、共有契約の `PLUGIN_NAVIGATION_RULES` が
 * view パスを許可すること（同期はテストで固定する）。
 *
 * WebView 生成・transport・個体束縛・失効・同梱許可・管理 DTO はホストが
 * 持ち続ける。`bridge-app-core` への GUI 逆依存は足さない。
 *
 * @packageDocumentation
 */
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { diagnosticCompanion } from "../plugin-ui/diagnostic/companion.ts";
import { textCompanion } from "../plugin-ui/text/companion.ts";

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
 * backend は不透明に受け取り、用途別の最小口だけを使う。子→main の
 * 操作名引きの口は作らず、要求名から処理への表は種別ごとに固定する。
 *
 * backend の形状の前提: 記述子の各口が使う最小口（`getTextBinding` など）を
 * backend が持つこと。持たない backend への到達は配線の不備であり、不足口の
 * 呼び出しが `TypeError` で失敗する。失効の合図は射影が `RangeError` で示し、
 * `TypeError` は失効として回収しない。要望読みの失敗は種類を問わず呼び出し側
 * （対応付けの `readDesired`）が種別単位で隔離する。
 * push・bind 経路の `catch` は `RangeError` 以外（配線不備の `TypeError` 等）も失敗表示に回してクラッシュより可視失敗を優先し、読取経路が `RangeError` のみ回収するのは入力検証等の失敗で失効扱いにしないためである。
 */
export interface PluginCompanion {
  /** マウント識別子に載る種別トークン。小文字始まりの英数字であること。 */
  readonly kind: string;
  /** 失敗表示用の種別名（表示名のみ）。 */
  readonly label: string;
  /** 結線後に読み込む同梱子画面の view パス。 */
  readonly viewPath: string;
  /**
   * 結線後に読み込む子画面 URL を作る。
   *
   * @param mountId - 再利用しないマウント識別子。
   * @returns 子画面の URL。
   */
  buildViewUrl(mountId: string): string;
  /**
   * 現割当ての要望一覧を読む。取得失敗時は例外とし、呼び出し側が隔離する。
   *
   * @param backend - 対応付けが預かる backend。不透明に受け取る。
   * @returns 要望の一覧。無ければ空配列。
   */
  listDesired(backend: unknown): CompanionDesiredBinding[];
  /**
   * 束縛個体の限定表示を読む。他個体・管理情報は返さない。
   *
   * @param backend - 対応付けが預かる backend。不透明に受け取る。
   * @param instanceId - 束縛個体の識別子。対応付けが決める。
   * @throws `RangeError` — 束縛外・現割当て失効の場合。
   */
  readView(backend: unknown, instanceId: string): InstanceBaseView;
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
   * @param backend - 対応付けが預かる backend。不透明に受け取る。
   * @param instanceId - 束縛個体の識別子。対応付けが決める。
   * @param params - 操作の引数。
   * @throws `RangeError` — 束縛外・現割当て失効の場合（同期的）。
   */
  send?(backend: unknown, instanceId: string, params: unknown): Promise<unknown>;
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
 * companion の登録表。種別トークンから記述子を引く。
 *
 * 本番配線は既定の共有登録表（`defaultPluginCompanionRegistry`）を使う。
 * 試験では自前の表を作り、共有表を汚さずに companion を差し替える。
 * テスト専用の unregister は持たない（表を使い捨てる）。
 */
export class PluginCompanionRegistry {
  private readonly companions = new Map<string, PluginCompanion>();

  /**
   * companion を登録する。同梱 companion だけを共有表に登録し、任意の追加はしない。
   *
   * @param companion - 登録する companion の記述子。
   * @throws `Error` — 種別トークンが空・形式外・登録済みの場合。
   */
  register(companion: PluginCompanion): void {
    if (!/^[a-z][a-z0-9]*$/.test(companion.kind)) {
      throw new Error("companion の種別トークンが形式外である。");
    }
    if (this.companions.has(companion.kind)) {
      throw new Error(`companion は登録済みである: ${companion.kind}`);
    }
    this.companions.set(companion.kind, companion);
  }

  /**
   * 種別トークンから記述子を引く。未登録なら `undefined` とし、
   * 呼び出し側が拒否・回収する。
   *
   * @param kind - 照合する種別トークン。
   * @returns 記述子。未登録なら `undefined`。
   */
  get(kind: string): PluginCompanion | undefined {
    return this.companions.get(kind);
  }

  /**
   * 登録済み companion を登録順に返す。配置の要望読みに使う。
   *
   * @returns 登録済みの記述子の一覧。
   */
  list(): readonly PluginCompanion[] {
    return [...this.companions.values()];
  }
}

/** 本番配線が使う既定の共有登録表。同梱 companion だけを載せる。 */
export const defaultPluginCompanionRegistry = new PluginCompanionRegistry();

/**
 * companion を既定の共有表へ静的に登録する。同梱 companion だけを登録し、任意の追加はしない。
 *
 * @param companion - 登録する companion の記述子。
 * @throws `Error` — 種別トークンが空・形式外・登録済みの場合。
 */
export function registerPluginCompanion(companion: PluginCompanion): void {
  defaultPluginCompanionRegistry.register(companion);
}

/**
 * 種別トークンから記述子を既定の共有表から引く。未登録なら `undefined` とし、
 * 呼び出し側が拒否・回収する。
 *
 * @param kind - 照合する種別トークン。
 * @returns 記述子。未登録なら `undefined`。
 */
export function getPluginCompanion(kind: string): PluginCompanion | undefined {
  return defaultPluginCompanionRegistry.get(kind);
}

/**
 * 既定の共有表の登録済み companion を登録順に返す。配置の要望読みに使う。
 *
 * @returns 登録済みの記述子の一覧。
 */
export function listPluginCompanions(): readonly PluginCompanion[] {
  return defaultPluginCompanionRegistry.list();
}

// 同梱 companion の静的登録。配置の優先順は登録順であり、変えない。
registerPluginCompanion(textCompanion);
registerPluginCompanion(diagnosticCompanion);
