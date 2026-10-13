/**
 * テキスト companion が所有する固有契約と表示先。
 *
 * RPC 契約型・限定 DTO の定義をここに持ち、自己完結させる。共有型
 * （`InstanceBaseView`）と mount 識別子・URL 組み立ての共有手段だけを
 * 共有契約（`bridge-gui-contract/plugin-instance`）から借りる。子画面
 * （`index.ts`）と main 側アダプター（`companion.ts`）はここを参照し、
 * 種別トークン・view パス・URL 組み立てを他に分散させない。
 *
 * @packageDocumentation
 */
import type { TextSendResult, TextStats } from "bridge-app-core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { buildPluginViewUrl } from "bridge-gui-contract/plugin-instance";

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
 * テキスト子画面の view パス。
 *
 * 遷移規則（共有契約の `PLUGIN_NAVIGATION_RULES`）が含む同梱パスの正本と
 * 一致させること。一致は bridge-gui-main の同期テストで固定する。
 */
export const TEXT_VIEW_PATH = "views://plugin-text/index.html";

/**
 * マウント識別子つきのテキスト子画面 URL を作る。
 *
 * main が個体別 RPC の結線後に読み込む先であり、画面からの指定は受け付けない。
 *
 * @param mountId - 再利用しないマウント識別子。空でないこと。
 * @returns テキスト子画面の URL。
 */
export function buildTextViewUrl(mountId: string): string {
  return buildPluginViewUrl(TEXT_VIEW_PATH, mountId);
}
