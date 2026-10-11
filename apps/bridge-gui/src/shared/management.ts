/**
 * 管理画面と GUI バックエンドが RPC で交換する表示データ（DTO）と限定操作の型。
 *
 * Webview へ関数や生オブジェクトを渡さず、このモジュールの表示データと
 * 限定操作だけを RPC で渡す。実行時の依存を持たない（型のみの import だけ）。
 *
 * @packageDocumentation
 */
import type { RPCSchema } from "electrobun/rpc";
import type {
  ApprovalResult,
  BridgeSessionInfo,
  ConnectionPhase,
  RejectionResult,
} from "bridge-server";
import type { TextSendResult, TextStats } from "bridge-app-core";
import type { PluginMountDto, SpikeMountSummary, SpikePushResult } from "./plugin-spike.ts";
import type { PluginUiMountFailure, PluginUiMountPlacement } from "./plugin-instance.ts";

/** GUI バックエンドの起動状態。 */
export type BackendStatus =
  /** bridge-server を組み立て中。 */
  | "starting"
  /** 稼働中。受付の開閉とは無関係。 */
  | "ready"
  /** 起動に失敗し、表示のみ提供する。終了はできる。 */
  | "failed"
  /** 終了処理中。新規操作を受け付けない。 */
  | "stopping";

/** 公開 endpoint の表示状態。 */
export interface EndpointState {
  /** 公開先 URL。 */
  readonly url: string;
  /** 受付中かどうか。 */
  readonly listening: boolean;
}

/**
 * ペアリング受付の表示状態。
 *
 * 残時間はミリ秒。比較コードの本文は含めない。コードが必要な画面は
 * 選択後に限定 request（`getPairingView`）で取得し、snapshot には載せない。
 * 残時間の表示は取得値から画面側の単調時計で減算し、期限・承認可否の
 * 判断は常に server が行う。
 */
export interface AdmissionState {
  /** 受付中かどうか。 */
  readonly accepting: boolean;
  /** 受付の残時間（ミリ秒）。受付中でない場合は 0。 */
  readonly remainingMs: number;
}

/**
 * 照合待ちの保留項目。比較コードの本文は含めない。
 *
 * 一覧と比較コード取得を分ける理由は、通常の snapshot 取得でコード本文が
 * 配布・記録されないようにするためである。取得したコードでの承認は
 * 自動で行わず、明示の `approvePairing` だけが承認する。
 */
export interface PendingEntry {
  /** 照合対象の要求識別子。 */
  readonly requestId: string;
  /** 失効までの残時間（ミリ秒）。 */
  readonly expiresInMs: number;
}

/**
 * 比較コードの表示用取得結果。
 *
 * コードは文字列のまま扱い、数値化しない（先頭ゼロを保持する）。
 * 表示整形は `formatPairingCode` 済みの `displayCode` を使う。
 * 本文・整形形ともログに残さない。
 */
export type PairingViewResult =
  | {
      /** 取得できた場合に真。 */
      readonly available: true;
      /** 照合対象の要求識別子。 */
      readonly requestId: string;
      /** ASCII 数字 6 文字の比較コード。 */
      readonly code: string;
      /** 人間が照合しやすい表示形（例: `"000 123"`、半角スペース）。 */
      readonly displayCode: string;
      /** 承認期限（壁時計ミリ秒・表示用）。 */
      readonly expiresAt: number;
      /** 承認までの残時間（ミリ秒）。 */
      readonly expiresInMs: number;
    }
  | {
      /** 取得できない場合に偽。期限切れ・承認済み・拒否済みの場合がある。 */
      readonly available: false;
      /** 取得できない理由（人間向けの短い説明）。 */
      readonly reason: string;
    };

/** 接続の表示状態。比較コードは含めない。 */
export interface ConnectionSummary {
  /** 接続識別子。 */
  readonly connectionId: string;
  /** 接続時の `Origin`。 */
  readonly origin: string;
  /** 認証済みか。 */
  readonly authorized: boolean;
  /** 認可段階。表示用であり、判定には使わない。 */
  readonly phase: ConnectionPhase;
}

/**
 * 生存セッションの表示状態。
 *
 * 認可後のセッションだけを含み、切替中・未認可は含まない。
 * `sessionId` は表示・関連付け用であり、取得キーには `localSessionId` を使う。
 */
export type SessionSummary = BridgeSessionInfo;

/** 生成済みプラグインインスタンスの表示状態。 */
export interface PluginInstanceSummary {
  /** インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
}

/** 割当ての表示状態。 */
export interface AssignmentSummary {
  /** 割り当てた生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 割当て先インスタンスの識別子。 */
  readonly instanceId: string;
  /** 割当て先接続口の識別子。 */
  readonly portId: string;
}

/** プラグインのインスタンスと割当ての表示状態。 */
export interface PluginAssignmentState {
  /** GUI バックエンドが生成・保持するインスタンスの一覧。 */
  readonly instances: readonly PluginInstanceSummary[];
  /** 現在の割当て一覧の写し。 */
  readonly assignments: readonly AssignmentSummary[];
}

/**
 * 固定テキスト表示の状態。
 *
 * 割当ての有無は識別子で表す。両方が `null` なら未割当て、両方あれば
 * 割当て中であり、片方だけの状態は作らない。本文は含めない（送信時のみ
 * 扱い、snapshot・ログに残さない）。
 */
export interface TextDisplayState {
  /** 割当て中の生存セッションのローカル識別子。未割当てなら `null`。 */
  readonly localSessionId: string | null;
  /** 割当て中のテキストインスタンスの識別子。未割当てなら `null`。 */
  readonly instanceId: string | null;
  /** 割当てがあり実行中でなければ真。 */
  readonly canSend: boolean;
  /** 実行中の要求の相関識別子。待機がなければ `null`。 */
  readonly pendingId: string | null;
  /** 直近の決着。未送信なら `null`。 */
  readonly lastResult: TextSendResult | null;
  /** インスタンス単位の統計。未割当てなら零値である。 */
  readonly stats: TextStats;
}

/**
 * 管理画面の表示スナップショット。
 *
 * 起動状態・endpoint・受付状態／残時間・コードを除く保留一覧・接続一覧と
 * 認可段階・生存セッション一覧・インスタンス識別情報と接続口・割当て状態・
 * 固定テキスト表示の状態を持つ。テキスト本文は含めない。
 */
export interface ManagementSnapshot {
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
  /** 起動状態。 */
  readonly backend: BackendStatus;
  /** 公開 endpoint。未公開の場合は null。 */
  readonly endpoint: EndpointState | null;
  /** 受付状態。 */
  readonly admission: AdmissionState;
  /** 保留一覧（コード本文なし）。 */
  readonly pending: readonly PendingEntry[];
  /** 接続一覧。 */
  readonly connections: readonly ConnectionSummary[];
  /** 生存セッション一覧。 */
  readonly sessions: readonly SessionSummary[];
  /** インスタンス／割当て状態。 */
  readonly plugins: PluginAssignmentState;
  /** 固定テキスト表示の状態。本文は含めない。 */
  readonly text: TextDisplayState;
  /**
   * 実プラグイン子画面の配置一覧。
   *
   * 実在インスタンスに対応するタグ配置用であり、管理画面は追加のみ・
   * 更新で作り直さない規約でタグを配置する。本文は含めない。
   */
  readonly pluginMounts: readonly PluginUiMountPlacement[];
  /**
   * 実プラグイン子画面の失敗一覧。
   *
   * 生成・読込み・初期 RPC の失敗と期限超過をそのマウントに局所化した
   * 表示であり、再生成は明示の再試行で行う。本文は含めない。
   */
  readonly pluginMountFailures: readonly PluginUiMountFailure[];
}

/** main→Webview の状態通知。最新の全状態を送る唯一の通知である。 */
export interface StateChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: ManagementSnapshot;
}

/** 限定操作の受付応答。後続の状態は `stateChanged` で受け取る。 */
export interface OperationAck {
  /** 受け付けた場合に真。 */
  readonly ok: true;
}

/** 管理画面 RPC の型。main・Webview の両方から参照する。 */
export type ManagementRpc = {
  bun: RPCSchema<{
    requests: {
      /** 表示状態の取得。読み取りは revision を進めない。 */
      getSnapshot: { params: {}; response: ManagementSnapshot };
      /** ペアリング受付を開く。 */
      openAcceptance: { params: {}; response: AdmissionState };
      /** ペアリング受付を閉じる。開始待ち・承認待ちを終了し、認可済みは維持する。 */
      closeAcceptance: { params: {}; response: AdmissionState };
      /** 選択した保留の比較コード・期限を表示用に取得する。承認はしない。 */
      getPairingView: { params: { requestId: string }; response: PairingViewResult };
      /** 保留を比較コード照合で承認する。結果の成否は server が決める。 */
      approvePairing: {
        params: { requestId: string; code: string };
        response: ApprovalResult;
      };
      /** 保留を取り下げ、対象の接続を終了する。 */
      rejectPairing: { params: { requestId: string }; response: RejectionResult };
      /** 指定接続だけを切断する。待ち受けと他接続は維持する。 */
      disconnectConnection: { params: { connectionId: string }; response: OperationAck };
      /**
       * スパイク専用の診断割当て。reliable Session ごとに診断インスタンスを
       * 1つ生成し `"diagnostic"` 接続口へ割り当てる。
       *
       * 論理名がテキスト表示用のセッションは対象外である。
       */
      assignDiagnostics: { params: { localSessionId: string }; response: AssignmentSummary };
      /**
       * 固定テキスト表示の明示割当て。引数は取らない。
       *
       * 論理名がテキスト表示用で未割当ての生存セッションが全接続を通じて
       * 一件だけある場合に、テキストインスタンスを生成して割り当てる。
       * 候補ゼロ・複数・割当て中の再要求は理由付きで拒否する。
       */
      assignText: { params: {}; response: AssignmentSummary };
      /**
       * 固定テキストの送信。画面が認識している割当て識別子を含める。
       *
       * 現在の割当てと一致しなければ拒否し、古い画面の要求を新しい割当てへ
       * 転送しない。本文は送信時のみ扱い、snapshot・ログに残さない。
       */
      sendText: {
        params: { localSessionId: string; instanceId: string; text: string };
        response: TextSendResult;
      };
      /**
       * 固定テキストの明示解除。割当て表示を消し、生成分を回収する。
       *
       * 対象セッションの中断は基盤の解除規約に従う。未割当てなら拒否する。
       */
      unassignText: { params: {}; response: OperationAck };
      /**
       * 段0スパイクの子画面配置。配置用 DTO（識別子＋初期 URL）を返す。
       *
       * 識別子は再利用しない。初期 URL は空ページに限る。
       */
      spikeCreate: { params: {}; response: PluginMountDto };
      /**
       * 段0スパイクの子画面破棄。所有表からの削除と表示の破棄を行う。
       *
       * 配置待ちの破棄では遅延生成の回収に回す。
       */
      spikeDestroy: { params: { mountId: string }; response: OperationAck };
      /**
       * 段0スパイクの子画面へ push を送る。混線の確認用である。
       *
       * 当該マウントだけに送り、他には届けない。
       */
      spikePush: { params: { mountId: string }; response: SpikePushResult };
      /** 段0スパイクの所有中マウント一覧。表示用である。 */
      spikeList: { params: {}; response: readonly SpikeMountSummary[] };
      /**
       * 段0スパイクの全マウント破棄。再読込み掃除と終了処理に使う。
       *
       * 識別子の連番は巻き戻さない。
       */
      spikeReset: { params: {}; response: OperationAck };
      /**
       * 実プラグイン子画面の失敗消去と現割当てへの再配置。
       *
       * 失敗表示を消し、現在の割当てに配置が無いものを作り直す。
       * 既存の配置・割当て・送信には触らない。
       */
      retryPluginMounts: { params: {}; response: OperationAck };
      /** アプリ終了を要求する。後始末完了後に終了する。 */
      quit: { params: {}; response: OperationAck };
    };
    messages: {
      /** Webview の準備完了通知。main は受信を記録する。 */
      viewReady: { title: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      /** main からの状態 push。 */
      stateChanged: StateChangedMessage;
    };
  }>;
};

/**
 * 受信した表示状態を採用すべきか判定し、採用すべきものだけを返す。
 *
 * 単調増加の revision が新しいときだけ採用する。古い応答や再送、
 * 同一 revision の再取得では現在の状態を保ち、巻き戻さない。
 *
 * @param current - 現在採用中の表示状態。未取得の場合は null。
 * @param incoming - 受信した表示状態。
 * @returns 採用すべき表示状態。
 */
export function selectNewer(
  current: ManagementSnapshot | null,
  incoming: ManagementSnapshot,
): ManagementSnapshot {
  if (current === null || incoming.revision > current.revision) {
    return incoming;
  }
  return current;
}
