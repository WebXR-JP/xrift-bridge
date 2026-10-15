/**
 * 実プラグイン子画面用の中継契約。
 *
 * 子画面とプラグイン本体は、起動時の静的登録で決めた不透明な契約でだけ
 * 通信する。アプリ本体は中継だけを担い、要求・通知の中身を解釈しない。
 * 管理画面と main が交換する管理 RPC（`management.ts`）とは別の型・別の接続で
 * 使い、マウントごとに独立した接続を結ぶ。全個体を呼び分ける共有
 * dispatcher は作らない。要求相関・応答待ちは既存 Electrobun RPC を使い、
 * 独自 RPC 基盤を追加しない。
 *
 * 業務上の型・要求名・イベント名・実行時検証は各プラグインの
 * `gui-contract` と endpoint が所有する。アプリは外形（`method`・`event` が
 * 空でない文字列であること）だけを見て内容検査をしない。
 * 実行時の依存を持たない。
 *
 * @packageDocumentation
 */

/**
 * 子からプラグイン本体への中継要求の共通形。
 *
 * `params` はアプリでは `unknown` であり、検証は受け取った endpoint が行う。
 * 対象個体・種別の指定は載せない。配送先は接続に閉じ込めたマウントから
 * ホストが引き、payload の内容では変えない。
 */
export interface PluginRelayRequest {
  /** 要求名。空でない文字列であること。業務名の解釈は endpoint が行う。 */
  readonly method: string;
  /** 要求引数。アプリでは不透明であり、検証は endpoint が行う。 */
  readonly params: unknown;
}

/**
 * プラグイン本体から子への通知の共通形。
 *
 * `payload` はアプリでは `unknown` であり、表示用 DTO の組立ては
 * プラグイン所有の GUI アダプターが行う。アプリは同一マウント生存時のみ
 * 素通しし、キュー・再配信・最新状態キャッシュを持たない。
 */
export interface PluginRelayEvent {
  /** イベント名。空でない文字列であること。業務名の解釈は子が行う。 */
  readonly event: string;
  /** 通知内容。アプリでは不透明であり、素通しする。 */
  readonly payload: unknown;
}

/**
 * 中継自体の失敗符号。アプリ自身の照合結果だけを表す。
 *
 * 業務の成否はプラグインの結果（不透明な応答値）として返し、この符号には
 * 載せない。プラグイン endpoint が投げた `RangeError` を失効と解釈しない。
 */
export type PluginRelayErrorCode =
  /** マウント失効後の到達。要求・emit の到達停止後の利用である。 */
  | "unmounted"
  /** endpoint 終了後の到達。終了口の実行後である。 */
  | "endpoint-closed"
  /** 外形の破損（`method` が空でない文字列でない等）。内容の検証ではない。 */
  | "bad-envelope";

/**
 * 中継自体の失敗。アプリ自身の照合で付け、業務内容は載せない。
 */
export interface PluginRelayError {
  /** 失敗の符号。アプリ自身の照合結果である。 */
  readonly code: PluginRelayErrorCode;
  /** 人間向けの短い理由。本文・payload は含めない。 */
  readonly message: string;
}

/**
 * 中継要求への応答。不透明な値または中継自体の失敗のいずれかである。
 *
 * 正常応答の `value` はアプリでは不透明であり、業務エラーもここに載せる
 * （プラグインの結果として扱う）。`error` はアプリ自身の照合結果だけに使う。
 */
export type PluginRelayResult =
  | {
      /** 正常に応答できた場合に真。業務エラーもこちらに載せる。 */
      readonly ok: true;
      /** プラグイン endpoint が返した不透明な値。 */
      readonly value: unknown;
    }
  | {
      /** 中継自体が失敗した場合に偽。 */
      readonly ok: false;
      /** アプリ自身の照合による失敗。業務内容は含めない。 */
      readonly error: PluginRelayError;
    };

// ADR: Electrobun の `RPCSchema<I>` は `{requests, messages}` に解決される
// 構造型であり、`ElectrobunRPCSchema` 制約も構造適合で満たせる。そのため
// 契約ではこの素朴な構造型で表し、`electrobun/rpc` を import しない。
type RpcSchema<Requests, Messages> = {
  requests: Requests;
  messages: Messages;
};

/**
 * マウントごとの中継接続の型。固定の中継要求一つ＋中継通知一つだけを持つ。
 *
 * 子は `relay` だけを呼べ、アプリ本体への専用 ready・ping・状態取得口は
 * 持たない。ホストは結線時に束縛した個体の endpoint へ素通しし、文字列で
 * 配送先を選ぶ口は作らない。main・子画面の両方から参照する。
 */
export type CompanionChannelRpc = {
  bun: RpcSchema<
    {
      /** 子からプラグイン本体への中継要求。応答は不透明な値か中継失敗である。 */
      relay: { params: PluginRelayRequest; response: PluginRelayResult };
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}
  >;
  webview: RpcSchema<
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {},
    {
      /** プラグイン本体から子への通知。同一マウント生存時のみ届ける。 */
      emitted: PluginRelayEvent;
    }
  >;
};

/**
 * 中継要求の外形か判定する。アプリの受付で使う前段であり、内容の検証は
 * endpoint が行う。`params` の中身は問わない。
 *
 * @param value - 検査する未知値。
 * @returns `method` が空でない文字列で `params` 項目を持つ場合に真。
 */
export function isRelayRequestShape(value: unknown): value is PluginRelayRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const table = value as Record<string, unknown>;
  return typeof table["method"] === "string" && table["method"].length > 0 && "params" in table;
}

/**
 * 通知の外形か判定する。アプリの素通し前段であり、内容の検証は子が行う。
 * `payload` の中身は問わない。
 *
 * @param value - 検査する未知値。
 * @returns `event` が空でない文字列で `payload` 項目を持つ場合に真。
 */
export function isRelayEventShape(value: unknown): value is PluginRelayEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const table = value as Record<string, unknown>;
  return typeof table["event"] === "string" && table["event"].length > 0 && "payload" in table;
}

/**
 * 実プラグイン子画面の配置・表示契約。
 *
 * 割当てだけでは子を作らず、操作画面への表示要求があるときに選ばれた
 * 一個体の子を新規生成する。マウント識別子は権限証明ではなく、main が
 * 発行した初期 URL 完全一致＋親 Webview 一致で照合する。
 * 実行時の依存を持たない。
 */

/** 実プラグイン子画面の配置先（空ページ）。初期配置先であり、検証内容は持たない。 */
export const PLUGIN_BLANK_PATH = "views://plugin-host/blank.html";

/**
 * 配置受付から最初の正常な plugin 応答までの総予算（ミリ秒）。
 *
 * 要求到達だけでは plugin の停まりを見逃すため、正常応答の到達を期限と
 * する。子が採用したこと・描画・業務準備完了の証明ではない。期限超過は
 * 回収して失敗表示に回し、自動で作り直さない。再生成は明示の再試行に任せる。
 */
export const PLUGIN_PENDING_TIMEOUT_MS = 15_000;

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
 * 対象インスタンス／割当ての要約・表示期間の世代の組である。
 *
 * 初期 URL は main の静的登録表（空ページ＋識別子の断片）から作り、
 * 画面は申告せずそのまま `src` 属性に載せる。任意 URL・HTML・preload の
 * 指定口は持たない。本文は含めない。プラグイン状態の改訂番号は載せない
 * （改訂の所有者はプラグイン本体であり、子は新しい状態のみ採用する）。
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
  /**
   * 表示期間を識別する世代。表示要求の世代を写す。
   *
   * 古い世代の配置では子を復活させない。同一表示期間の再試行は世代を
   * 維持し、画面を離れての再表示は新しい世代・新しい mountId で読み直す。
   */
  readonly viewGeneration: number;
  /** plugin の最初の正常応答を受けた場合に真。受付・要求到達とは区別する。 */
  readonly pluginResponded: boolean;
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
}

/**
 * 実プラグイン子画面の失敗表示。生成・読込み・中継の失敗と期限超過を
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
  /**
   * 対象だった表示期間の世代。特定できない場合は `null`。
   *
   * 古い世代の失敗表示では子を復活させない。
   */
  readonly viewGeneration: number | null;
}

/**
 * Angular から main への表示要求。表示対象一個体または無しを伝える。
 *
 * 管理画面の配置制御であり、子とアプリ本体の直接のデータ交換ではない。
 * 世代は表示期間の識別であり、業務の改訂番号とは別物である。子 payload
 * にはこの世代を要求しない。
 */
export interface PluginViewRequest {
  /** 表示する実インスタンスの識別子。無しの場合は `null`。 */
  readonly instanceId: string | null;
  /**
   * 表示期間を識別する世代。単調増加であり、画面を離れての再表示では
   * 新しい値を使う。同一表示期間の再試行は値を維持する。
   */
  readonly viewGeneration: number;
}

/**
 * 表示要求の外形か判定する。受付の前段であり、個体の存在・割当ての確認は
 * main が行う。
 *
 * @param value - 検査する未知値。
 * @returns 世代が有限の非負整数で対象が識別子または無しの場合に真。
 */
export function isPluginViewRequest(value: unknown): value is PluginViewRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const table = value as Record<string, unknown>;
  const instanceId = table["instanceId"];
  const viewGeneration = table["viewGeneration"];
  const idOk = instanceId === null || (typeof instanceId === "string" && instanceId.length > 0);
  const generationOk =
    typeof viewGeneration === "number" && Number.isInteger(viewGeneration) && viewGeneration >= 0;
  return idOk && generationOk;
}

/**
 * 初期応答の状態。配置受付から最初の正常な plugin 応答までの見立てである。
 *
 * 子が採用したこと・描画・業務準備完了の証明ではなく、期限管理と代替表示の
 * ための区分である。
 */
export type PluginMountFirstResponse =
  /** 正常応答待ち。配置はあるが応答・失敗のいずれも未確定である。 */
  | "waiting"
  /** 最初の正常な plugin 応答を受けた。 */
  | "answered"
  /** 回収済み。対応する失敗表示がある。 */
  | "failed";

/**
 * 配置の初期応答の状態を求める。
 *
 * 同一世代の失敗表示がある場合は `failed`、配置が最初の正常応答を
 * 受けていれば `answered`、いずれでもなければ `waiting` とする。
 * 古い世代の失敗表示では `failed` にしない。
 *
 * @param mount - 判定する配置。
 * @param failures - 現在の失敗表示の一覧。
 * @returns 初期応答の状態。
 */
export function firstResponseOf(
  mount: PluginUiMountPlacement,
  failures: readonly PluginUiMountFailure[],
): PluginMountFirstResponse {
  if (mount.pluginResponded) {
    return "answered";
  }
  const failed = failures.some(
    (failure) =>
      failure.viewGeneration !== null &&
      failure.viewGeneration === mount.viewGeneration &&
      (failure.instanceId === null || failure.instanceId === mount.instanceId),
  );
  return failed ? "failed" : "waiting";
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
 * 画面からの指定は受け付けない。view パスはホストが解決した値だけを使い、
 * 種別ごとの組み立てはここに持たない。
 *
 * @param viewPath - 同梱子画面の view パス（`views://...`）。ホストの解決済みであること。
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
 * 形式外・空は `null` とし、呼び出し側が回収・拒否する。
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
