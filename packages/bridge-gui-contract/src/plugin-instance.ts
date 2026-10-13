/**
 * プラグイン子画面用の個体別 RPC の共有契約。
 *
 * 管理画面と main が交換する管理 RPC（`management.ts`）とは別の型・別の接続・
 * 別のハンドラで使う。子画面は自分のインスタンスの限定情報と操作だけを使え、
 * 受付・保留・照合・承認・接続断・割当て／解除・インスタンス管理・終了といった
 * 管理操作、他個体の情報、候補一覧、保留情報はここに載せない。
 * 子から任意の `instanceId`／`localSessionId` を受け取って振り分ける口は持たず、
 * main が束縛した個体の現割当てだけを使う。実行時の依存を持たない。
 *
 * 種別ごとの固有契約（限定表示・snapshot・通知・RPC 型・view パス）は各
 * companion が所有する（`apps/bridge-gui-main/src/plugin-ui/<種別>/contract.ts`）。
 * ここには全 companion で共通の手段だけを置く。
 *
 * @packageDocumentation
 */

/**
 * 束縛個体の共通表示。自分の識別情報・接続口・現割当てだけを持つ。
 *
 * 他個体の情報・候補一覧・保留情報は載せない。失効時は要求自体を拒否し、
 * 未割当ての表示は作らない。
 */
export interface InstanceBaseView {
  /** 束縛されたインスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 束縛された接続口の識別子。 */
  readonly portId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
}

/**
 * 受信した個体別表示を採用すべきか判定し、採用すべきものだけを返す。
 *
 * 管理画面の `selectNewer` と同じ規約であり、単調増加の revision が
 * 新しいときだけ採用する。古い応答や再送、同一 revision の再取得では
 * 現在の状態を保ち、巻き戻さない。
 *
 * @param current - 現在採用中の表示状態。未取得の場合は null。
 * @param incoming - 受信した表示状態。
 * @returns 採用すべき表示状態。
 */
export function selectNewerInstanceSnapshot<T extends { readonly revision: number }>(
  current: T | null,
  incoming: T,
): T {
  if (current === null || incoming.revision > current.revision) {
    return incoming;
  }
  return current;
}

/**
 * 実プラグイン子画面の配置・表示契約（段2・段3）。
 *
 * 段0スパイク（`plugin-spike.ts`）とは別の識別子名前空間・別の初期 URL・
 * 別の子画面を使い、検証専用の結線と混線させない。子画面は自分の束縛個体の
 * 限定情報と操作だけを使い、受付・保留・照合・承認・接続断・割当て／解除・
 * インスタンス管理・終了といった管理操作、他個体の情報、候補一覧、
 * 保留情報はここに載せない。実行時の依存を持たない。
 */

/** 実プラグイン子画面の配置先（空ページ）。初期配置先であり、検証内容は持たない。 */
export const PLUGIN_BLANK_PATH = "views://plugin-host/blank.html";

/**
 * 実プラグイン子画面タグの遷移規則。全面拒否を先に置き、
 * 空ページと実プラグイン子画面だけを後に許可する（後に一致した規則が勝つ）。
 *
 * 同梱パスの文字列は各 companion の view パス（`TEXT_VIEW_PATH`・
 * `DIAGNOSTIC_VIEW_PATH`）の正本と一致させること。一致は bridge-gui-main の
 * 同期テストで固定し、ここでの列挙と登録表の二重定義のずれを検出する。
 */
export const PLUGIN_NAVIGATION_RULES: readonly string[] = buildPluginNavigationRules([
  "views://plugin-text/index.html",
  "views://plugin-diagnostic/index.html",
]);

/** タグの `navigation-rules` 属性に載せる形。 */
export const PLUGIN_NAVIGATION_RULES_ATTRIBUTE: string = JSON.stringify(PLUGIN_NAVIGATION_RULES);

/**
 * テキスト送信 request の RPC 待機期限（ミリ秒）。
 *
 * プラグインの応答期限（`TEXT_RESPONSE_TIMEOUT_MS`＝10秒）より長くし、
 * 反映確認の到達を RPC 側の期限切れで落とさない。余裕は遅延確認の到達用で
 * あり、自動再送の猶予ではない。RPC 自体の失敗は反映確認とみなさず、
 * 状態再取得で確かめる。
 */
export const TEXT_SEND_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 子画面の生成待ちが失効するまでの時間（ミリ秒）。
 *
 * 配置からタグ生成の照合が無いまま過ぎたら、配置の不備として回収し、
 * 失敗表示に回す。自動で作り直さず、再生成は明示の再試行に任せる。
 */
export const PLUGIN_PENDING_TIMEOUT_MS = 15_000;

/**
 * 子画面の初回取得の試行回数。
 *
 * 初回同期の到達保証であり、RPC の既定待機での取りこぼし
 * （子画面側の接続確立・主処理の混雑）に備えて bounded に再試行する。
 * 使い果たしたら子画面に残し、main 側の準備完了待ちの期限超過に任せる。
 */
export const PLUGIN_INITIAL_FETCH_ATTEMPTS = 3;

/**
 * 子画面の初回取得の再試行間隔（ミリ秒）。
 */
export const PLUGIN_INITIAL_FETCH_RETRY_MS = 1_000;

/** 実プラグイン子画面の種別。main の静的登録表にある companion の種別トークンである。 */
export type PluginUiMountKind = string;

/** 実プラグイン子画面の結線段階。 */
export type PluginUiMountPhase =
  /** 配置を受け付け、子画面の生成待ち。 */
  | "pending"
  /** 生成を照合して個体別 RPC を結線し、子画面を読み込み済み。 */
  | "bound";

/**
 * 管理画面へ渡す配置用 DTO。マウント識別子・種別・初期 URL・結線状態と
 * 対象インスタンス／割当ての要約の組である。
 *
 * 初期 URL は main の静的登録表（空ページ＋識別子の断片）から作り、
 * 画面は申告せずそのまま `src` 属性に載せる。任意 URL・HTML・preload の
 * 指定口は持たない。本文は含めない。
 */
export interface PluginUiMountPlacement {
  /** 再利用しないマウント識別子。`plugin-<種別>-<連番>` の形である。 */
  readonly mountId: string;
  /** 束縛する個体の種別。 */
  readonly kind: PluginUiMountKind;
  /** タグの初期配置先。空ページに識別子の断片を付けたもの。 */
  readonly initialUrl: string;
  /** 結線段階。 */
  readonly phase: PluginUiMountPhase;
  /** 子画面の初期状態取得を受けた場合に真。 */
  readonly ready: boolean;
  /** 対応付け単位の改訂番号。push ごとに進む。 */
  readonly revision: number;
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
}

/**
 * 実プラグイン子画面の失敗表示。生成・読込み・初期 RPC の失敗と期限超過を
 * そのマウントに局所化するための情報であり、インスタンスや Session の
 * 状態、送信本文は含めない。
 */
export interface PluginUiMountFailure {
  /** 失敗した配置の種別。 */
  readonly kind: PluginUiMountKind;
  /** 人間向けの短い理由。識別子・本文は含めない。 */
  readonly reason: string;
  /** 対象だった実インスタンスの識別子。特定できない場合は `null`。 */
  readonly instanceId: string | null;
  /** 対象だった割当てのローカル識別子。特定できない場合は `null`。 */
  readonly localSessionId: string | null;
}

/**
 * マウント識別子つきの初期 URL を作る。
 *
 * 識別子は断片（`#mount=`）に載せる。scheme 側の解決には影響させず、
 * 子画面だけが読み取る。main は発行した文字列の完全一致で照合する。
 *
 * @param mountId - 再利用しないマウント識別子。空でないこと。
 * @returns 空ページの初期 URL。
 */
export function buildPluginBlankUrl(mountId: string): string {
  return `${PLUGIN_BLANK_PATH}#mount=${encodeURIComponent(mountId)}`;
}

/**
 * マウント識別子つきの子画面 URL を作る。
 *
 * main が個体別 RPC の結線後に `loadURL()` で読み込む先である。
 * 画面からの指定は受け付けない。種別ごとの view パスは各 companion が持つ。
 *
 * @param viewPath - 同梱子画面の view パス（`views://...`）。
 * @param mountId - 再利用しないマウント識別子。空でないこと。
 * @returns 子画面の URL。
 */
export function buildPluginViewUrl(viewPath: string, mountId: string): string {
  return `${viewPath}#mount=${encodeURIComponent(mountId)}`;
}

/**
 * 実プラグイン子画面タグの遷移規則を作る。全面拒否を先に置き、
 * 空ページと登録済みの子画面だけを後に許可する（後に一致した規則が勝つ）。
 *
 * @param viewPaths - 登録済み companion の view パスの一覧。
 * @returns 遷移規則の一覧。
 */
export function buildPluginNavigationRules(viewPaths: readonly string[]): readonly string[] {
  const scopes = viewPaths.map((viewPath) => {
    const slash = viewPath.indexOf("/", viewPath.indexOf("://") + 3);
    const scope = slash < 0 ? viewPath : viewPath.slice(0, slash);
    return `${scope}/*`;
  });
  return ["^*", "views://plugin-host/*", ...scopes];
}

/**
 * URL の断片から実プラグインのマウント識別子を読む。
 *
 * main が発行する `#mount=plugin-<種別>-<連番>` だけを受け付ける。
 * 種別の既知・未登録はここでは問わず、呼び出し側の登録表が許可する。
 * 段0スパイクの識別子（`spike-<連番>`）は対象外であり、形式外・空は
 * `null` とし、呼び出し側が回収・拒否する。
 *
 * @param url - 照合・表示対象の URL。`null` の場合がある。
 * @returns マウント識別子。形式外なら `null`。
 */
export function parsePluginMountId(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  const marker = "#mount=";
  const at = url.indexOf(marker);
  if (at < 0) {
    return null;
  }
  const raw = url.slice(at + marker.length).split("&", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // main の発行形式だけを受け付ける（使い回し・偽装の混入を避ける）。
  // 種別トークンは小文字始まりの英数字であり、連番は 0 始まりにしない。
  if (!/^plugin-[a-z][a-z0-9]*-[1-9][0-9]*$/.test(decoded)) {
    return null;
  }
  return decoded;
}

/**
 * マウント識別子から種別を読む。
 *
 * main が発行した形式だけを受け付け、形式外は `null` とする。
 * 既知・未登録の判定は main の登録表が行い、ここでは形式だけを見る。
 *
 * @param mountId - 照合するマウント識別子。
 * @returns 種別トークン。形式外なら `null`。
 */
export function pluginMountKindOf(mountId: string): PluginUiMountKind | null {
  const matched = /^plugin-([a-z][a-z0-9]*)-[1-9][0-9]*$/.exec(mountId);
  if (matched === null) {
    return null;
  }
  return matched[1] ?? null;
}
