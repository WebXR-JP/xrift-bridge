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
 * @packageDocumentation
 */
import type { RPCSchema } from "electrobun/rpc";
import type { DiagnosticStats, TextSendResult, TextStats } from "bridge-app-core";

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
 * 診断個体の限定表示。echo／ping 統計だけを持ち、本文は持たない。
 */
export interface DiagnosticInstanceView extends InstanceBaseView {
  /** 束縛個体の echo／ping 応答統計。 */
  readonly stats: DiagnosticStats;
}

/**
 * テキスト子画面が受け取る snapshot。
 */
export interface TextInstanceSnapshot extends TextInstanceView {
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
}

/**
 * 診断子画面が受け取る snapshot。
 */
export interface DiagnosticInstanceSnapshot extends DiagnosticInstanceView {
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

/** main から診断子画面への状態通知。最新の全状態を送る唯一の通知である。 */
export interface DiagnosticInstanceChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: DiagnosticInstanceSnapshot;
}

/** テキスト子画面用 RPC の型。main・子画面の両方から参照する。 */
export type TextInstanceRpc = {
  bun: RPCSchema<{
    requests: {
      /** 束縛個体の状態取得。識別子の指定は受け付けない。読み取りは revision を進めない。 */
      getTextState: { params: {}; response: TextInstanceSnapshot };
      /**
       * 束縛個体の現割当てへの本文送信。本文だけを受け、割当て識別子の
       * 指定は受け付けない。main が束縛した個体の現割当てに委譲する。
       */
      sendText: { params: { text: string }; response: TextSendResult };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      /** main からの状態 push。 */
      textStateChanged: TextInstanceChangedMessage;
    };
  }>;
};

/** 診断子画面用 RPC の型。main・子画面の両方から参照する。 */
export type DiagnosticInstanceRpc = {
  bun: RPCSchema<{
    requests: {
      /** 束縛個体の状態取得。識別子の指定は受け付けない。読み取りは revision を進めない。 */
      getDiagnosticState: { params: {}; response: DiagnosticInstanceSnapshot };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      /** main からの状態 push。 */
      diagnosticStateChanged: DiagnosticInstanceChangedMessage;
    };
  }>;
};

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
