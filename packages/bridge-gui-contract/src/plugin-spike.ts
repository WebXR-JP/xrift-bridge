/**
 * 段0スパイク（プラグインUI埋込みの独立ゲート検証用）の共有契約。
 *
 * 管理画面と main が交換する配置用 DTO・子画面と main が交換する
 * マウント専用 RPC の型、main が発行する初期 URL の組み立てだけを持つ。
 * 実プラグインの結線には使わない。実行時の依存を持たない。
 *
 * @packageDocumentation
 */

/** 配置用の空ページ。タグの初期配置先であり、検証内容は持たない。 */
export const SPIKE_BLANK_PATH = "views://plugin-host/blank.html";

/** 検証用の小さな子画面。往復と破棄の確認だけを行う。 */
export const SPIKE_VIEW_PATH = "views://plugin-spike/index.html";

/**
 * 子画面タグの作成前から付ける遷移規則。全面拒否を先に置き、
 * 空ページと検証用子画面だけを後に許可する（後に一致した規則が勝つ）。
 */
export const SPIKE_NAVIGATION_RULES: readonly string[] = [
  "^*",
  "views://plugin-host/*",
  "views://plugin-spike/*",
];

/** タグの `navigation-rules` 属性に載せる形。 */
export const SPIKE_NAVIGATION_RULES_ATTRIBUTE: string = JSON.stringify(SPIKE_NAVIGATION_RULES);

/**
 * 管理画面へ渡す配置用 DTO。マウント識別子と初期 URL の組である。
 *
 * 初期 URL は main の静的登録表（空ページ＋識別子の断片）から作り、
 * 画面は申告せずそのまま `src` 属性に載せる。任意 URL・HTML・preload の
 * 指定口は持たない。
 */
export interface PluginMountDto {
  /** 再利用しないマウント識別子。`spike-<連番>` の形である。 */
  readonly mountId: string;
  /** タグの初期配置先。空ページに識別子の断片を付けたもの。 */
  readonly initialUrl: string;
}

/** マウントの結線段階。 */
export type SpikeMountPhase =
  /** 配置を受け付け、子画面の生成待ち。 */
  | "pending"
  /** 生成を照合して専用 RPC を結線し、子画面を読み込み済み。 */
  | "bound";

/** マウント一覧の表示状態。 */
export interface SpikeMountSummary {
  /** 再利用しないマウント識別子。 */
  readonly mountId: string;
  /** 配置用 DTO の初期 URL。再配置の判断に使う。 */
  readonly initialUrl: string;
  /** 結線段階。 */
  readonly phase: SpikeMountPhase;
  /** 子画面の初期 snapshot 採用通知を受けた場合に真。 */
  readonly ready: boolean;
  /** マウント単位の改訂番号。push ごとに進む。 */
  readonly revision: number;
}

/** 子画面が `getSpikeState` で受け取る snapshot。 */
export interface SpikeSnapshot {
  /** 問い合わせたマウントの識別子。 */
  readonly mountId: string;
  /** マウント単位の改訂番号。 */
  readonly revision: number;
}

/** main から子画面への push。本文は含めない。 */
export interface SpikePushMessage {
  /** 送り先マウントの識別子。 */
  readonly mountId: string;
  /** マウント単位の改訂番号。 */
  readonly revision: number;
}

/** 子画面から main への初期 snapshot 採用通知。 */
export interface SpikeReadyNotice {
  /** 採用したマウントの識別子。 */
  readonly mountId: string;
}

/** `spikePush` の応答。後続の状態は子画面側の push 数で確かめる。 */
export interface SpikePushResult {
  /** 送った改訂番号。 */
  readonly revision: number;
}

// ADR: Electrobun の `RPCSchema<I>` は `{requests, messages}` に解決される
// 構造型であり、`ElectrobunRPCSchema` 制約（`{bun, webview}`）も構造適合で
// 満たせる。そのため契約ではこの素朴な構造型で表し、`electrobun/rpc` を
// import しない（契約パッケージのビルドを `.hutch` に依存させない）。
// 制約が構造型を拒否する場合は bridge-gui-main 側のアダプタで最小の型写像を行う。
type RpcSchema<Requests, Messages> = {
  requests: Requests;
  messages: Messages;
};

/** マウント専用 RPC の型。main・子画面の両方から参照する。 */
export type SpikeRpc = {
  bun: RpcSchema<
    {
      /** 子画面の状態取得。識別子の照合に使う。 */
      getSpikeState: { params: { mountId: string }; response: SpikeSnapshot };
    },
    {
      /** 子画面の初期 snapshot 採用通知。準備完了の判定に使う。 */
      spikeReady: SpikeReadyNotice;
    }
  >;
  webview: RpcSchema<
    {},
    {
      /** main からの状態 push。混線の有無を数える。 */
      spikeStateChanged: SpikePushMessage;
    }
  >;
};

/**
 * マウント識別子つきの初期 URL を作る。
 *
 * 識別子は断片（`#mount=`）に載せる。 scheme 側の解決には影響させず、
 * 子画面だけが読み取る。main は発行した文字列の完全一致で照合する。
 *
 * @param mountId - 再利用しないマウント識別子。空でないこと。
 * @returns 空ページの初期 URL。
 */
export function buildBlankUrl(mountId: string): string {
  return `${SPIKE_BLANK_PATH}#mount=${encodeURIComponent(mountId)}`;
}

/**
 * マウント識別子つきの子画面 URL を作る。
 *
 * main が専用 RPC の結線後に `loadURL()` で読み込む先である。
 * 画面からの指定は受け付けない。
 *
 * @param mountId - 再利用しないマウント識別子。空でないこと。
 * @returns 子画面の URL。
 */
export function buildSpikeUrl(mountId: string): string {
  return `${SPIKE_VIEW_PATH}#mount=${encodeURIComponent(mountId)}`;
}

/**
 * URL の断片からマウント識別子を読む。
 *
 * main が発行する `#mount=spike-<連番>` だけを受け付ける。
 * 形式外・空は `null` とし、呼び出し側が回収・拒否する。
 *
 * @param url - 照合・表示対象の URL。`null` の場合がある。
 * @returns マウント識別子。形式外なら `null`。
 */
export function parseMountId(url: string | null): string | null {
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
  if (!/^spike-[1-9][0-9]*$/.test(decoded)) {
    return null;
  }
  return decoded;
}
