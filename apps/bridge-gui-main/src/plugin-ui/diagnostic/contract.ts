/**
 * 診断 companion が所有する固有契約と表示先。
 *
 * RPC 契約型・限定 DTO の定義をここに持ち、自己完結させる。共有型
 * （`InstanceBaseView`）と mount 識別子・URL 組み立ての共有手段だけを
 * 共有契約（`bridge-gui-contract/plugin-instance`）から借りる。子画面
 * （`index.ts`）と main 側アダプター（`companion.ts`）はここを参照し、
 * 種別トークン・view パス・URL 組み立てを他に分散させない。
 *
 * @packageDocumentation
 */
import type { DiagnosticStats } from "bridge-app-core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { buildPluginViewUrl } from "bridge-gui-contract/plugin-instance";

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
 * 診断子画面の view パス。
 *
 * 遷移規則（共有契約の `PLUGIN_NAVIGATION_RULES`）が含む同梱パスの正本と
 * 一致させること。一致は bridge-gui-main の同期テストで固定する。
 */
export const DIAGNOSTIC_VIEW_PATH = "views://plugin-diagnostic/index.html";

/**
 * マウント識別子つきの診断子画面 URL を作る。
 *
 * main が個体別 RPC の結線後に読み込む先であり、画面からの指定は受け付けない。
 *
 * @param mountId - 再利用しないマウント識別子。空でないこと。
 * @returns 診断子画面の URL。
 */
export function buildDiagnosticViewUrl(mountId: string): string {
  return buildPluginViewUrl(DIAGNOSTIC_VIEW_PATH, mountId);
}
