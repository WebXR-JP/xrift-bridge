/**
 * テキスト子画面の固有契約の正本（`./gui-contract`）。
 *
 * RPC 契約型・限定 DTO・種別トークン・相対 entrypoint の定義元はここだけであり、
 * 重複定義を持たない。共有型（`InstanceBaseView`）だけを共有契約
 * （`bridge-gui-contract/plugin-instance`）から借りる。表示先は相対 entrypoint
 * の宣言だけを持ち、絶対 `views://` パスや子画面 URL の組み立ては持たない。
 * 解決（配置先・`views://` パス・URL 組み立て）はホスト（composition の静的
 * manifest と対応付け）が行う。子画面（`src/view/index.ts`）は同パッケージ内の
 * 相対参照、GUI 側は `bridge-plugin-text/gui-contract` を参照する。
 *
 * @packageDocumentation
 */
import type { TextSendResult, TextStats } from "./plugin.ts";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";

/**
 * テキスト個体の限定表示。本文は含めない（送信時のみ扱う）。
 */
export interface TextInstanceView extends InstanceBaseView {
  /** 割当てがあり実行中でなければ真。 */
  readonly canSend: boolean;
  /** 実行中の要求の相関識別子。待機がなければ `null`。 */
  readonly pendingId: string | null;
  /** 直近の決着。未送信なら `null`。 */
  readonly lastResult: TextSendResult | null;
  /** インスタンス単位の統計。 */
  readonly stats: TextStats;
}

/**
 * テキスト子画面が受け取る snapshot。
 */
export interface TextInstanceSnapshot extends TextInstanceView {
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
}

/** main からテキスト子画面への状態通知。最新の全状態を送る唯一の通知である。 */
export interface TextInstanceChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: TextInstanceSnapshot;
}

// ADR: Electrobun の `RPCSchema<I>` は `{requests, messages}` に解決される
// 構造型であり、`ElectrobunRPCSchema` 制約（`{bun, webview}`）も構造適合で
// 満たせる。そのため契約ではこの素朴な構造型で表し、`electrobun/rpc` を
// import しない（main 側のビルドを `.hutch` に依存させない）。
// 制約が構造型を拒否する場合は bridge-gui-main 側のアダプタで最小の型写像を行う。
type RpcSchema<Requests, Messages> = {
  requests: Requests;
  messages: Messages;
};

/** テキスト子画面用 RPC の型。main・子画面の両方から参照する。 */
export type TextInstanceRpc = {
  bun: RpcSchema<
    {
      /** 束縛個体の状態取得。識別子の指定は受け付けない。読み取りは revision を進めない。 */
      getTextState: { params: {}; response: TextInstanceSnapshot };
      /**
       * 束縛個体の現割当てへの本文送信。本文だけを受け、割当て識別子の
       * 指定は受け付けない。main が束縛した個体の現割当てに委譲する。
       */
      sendText: { params: { text: string }; response: TextSendResult };
    },
    {}
  >;
  webview: RpcSchema<
    {},
    {
      /** main からの状態 push。 */
      textStateChanged: TextInstanceChangedMessage;
    }
  >;
};

/** テキスト companion の種別トークン。マウント識別子に載る。 */
export const TEXT_MOUNT_KIND = "text";

/**
 * テキスト子画面の相対 entrypoint。資産ルート（`src/view`）起点である。
 *
 * 解決済み `views://` パス・配置先・コピー表の正本はホストの静的 manifest
 * （`src/composition/bundled-plugin-assets.ts`）が持ち、ここでは相対名だけを
 * 宣言する。一致は資産の同期テストで固定する。ホストへ宣言する bundle の
 * entry はこの解決後の相対 entry（`index.html`）だけである。
 */
export const TEXT_VIEW_ENTRY = "index.html";

/** テキスト子画面の表示スクリプトの相対 entrypoint。 */
export const TEXT_SCRIPT_ENTRY = "index.ts";

/** テキスト子画面の表示様式の相対 entrypoint。 */
export const TEXT_STYLE_ENTRY = "index.css";

/**
 * テキスト送信 request の RPC 待機期限（ミリ秒）。
 *
 * プラグインの応答期限（`TEXT_RESPONSE_TIMEOUT_MS`＝10秒）より長くし、
 * 反映確認の到達を RPC 側の期限切れで落とさない。余裕は遅延確認の到達用で
 * あり、自動再送の猶予ではない。RPC 自体の失敗は反映確認とみなさず、
 * 状態再取得で確かめる。
 */
export const TEXT_SEND_REQUEST_TIMEOUT_MS = 15_000;
