/**
 * 診断 companion が所有する固有契約と相対資産の宣言。
 *
 * RPC 契約型・限定 DTO の定義をここに持ち、自己完結させる。共有型
 * （`InstanceBaseView`）だけを共有契約（`bridge-gui-contract/plugin-instance`）
 * から借りる。表示先は相対 entrypoint の宣言だけを持ち、絶対 `views://`
 * パスや子画面 URL の組み立ては持たない。解決（配置先・`views://` パス・
 * URL 組み立て）はホスト（composition の静的 manifest と対応付け）が行う。
 * 子画面（`index.ts`）と main 側アダプター（`companion.ts`）はここを参照し、
 * 種別トークン・相対 entrypoint を他に分散させない。
 *
 * @packageDocumentation
 */
import type { DiagnosticStats } from "bridge-app-core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";

/**
 * 診断個体の限定表示。echo／ping 統計だけを持ち、本文は持たない。
 */
export interface DiagnosticInstanceView extends InstanceBaseView {
  /** 束縛個体の echo／ping 応答統計。 */
  readonly stats: DiagnosticStats;
}

/**
 * 診断子画面が受け取る snapshot。
 */
export interface DiagnosticInstanceSnapshot extends DiagnosticInstanceView {
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
}

/** main から診断子画面への状態通知。最新の全状態を送る唯一の通知である。 */
export interface DiagnosticInstanceChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: DiagnosticInstanceSnapshot;
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

/** 診断子画面用 RPC の型。main・子画面の両方から参照する。 */
export type DiagnosticInstanceRpc = {
  bun: RpcSchema<
    {
      /** 束縛個体の状態取得。識別子の指定は受け付けない。読み取りは revision を進めない。 */
      getDiagnosticState: { params: {}; response: DiagnosticInstanceSnapshot };
    },
    {}
  >;
  webview: RpcSchema<
    {},
    {
      /** main からの状態 push。 */
      diagnosticStateChanged: DiagnosticInstanceChangedMessage;
    }
  >;
};

/** 診断 companion の種別トークン。マウント識別子に載る。 */
export const DIAGNOSTIC_MOUNT_KIND = "diagnostic";

/**
 * 診断子画面の相対 entrypoint 群。資産ルート（`src/plugin-ui/diagnostic`）起点である。
 *
 * 解決済み `views://` パス・配置先・コピー表の正本はホストの静的 manifest
 * （`src/composition/bundled-plugin-assets.ts`）が持ち、ここでは相対名だけを
 * 宣言する。一致は資産の同期テストで固定する。
 */
export const DIAGNOSTIC_VIEW_ENTRY = "index.html";

/** 診断子画面の表示スクリプトの相対 entrypoint。 */
export const DIAGNOSTIC_SCRIPT_ENTRY = "index.ts";

/** 診断子画面の表示様式の相対 entrypoint。 */
export const DIAGNOSTIC_STYLE_ENTRY = "index.css";
