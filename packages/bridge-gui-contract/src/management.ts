/**
 * 管理画面と GUI バックエンドが RPC で交換する表示データ（DTO）と限定操作の型。
 *
 * Webview へ関数や生オブジェクトを渡さず、このモジュールの表示データと
 * 限定操作だけを RPC で渡す。実行時の依存を持たない（型のみの import だけ）。
 *
 * @packageDocumentation
 */
import type {
  ApprovalResult,
  BridgeSessionInfo,
  ConnectionPhase,
  RejectionResult,
} from "bridge-server";
import type {
  PluginUiMountFailure,
  PluginUiMountPlacement,
  PluginViewRequest,
} from "./plugin-instance.ts";

/** GUI バックエンドの起動状態。 */
export type BackendStatus =
  /** bridge-server を組み立て中。 */
  | "starting"
  /** 稼働中。受付の有効/無効とは無関係。 */
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
 * 有効/無効の2状態だけを持ち、残時間・終了時刻は持たない。比較コードの
 * 本文は含めない。コードが必要な画面は選択後に限定 request
 * （`getPairingView`）で取得し、snapshot には載せない。承認可否の
 * 判断は常に server が行う。
 */
export interface AdmissionState {
  /** 受付が有効かどうか。 */
  readonly accepting: boolean;
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
    }
  | {
      /** 取得できない場合に偽。承認済み・拒否済みの場合がある。 */
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

/** プラグイン種別の表示状態。管理記述子の登録内容の写しである。 */
export interface PluginKindSummary {
  /** companion の種別トークン。 */
  readonly pluginKind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 失敗表示用の種別名（表示名のみ）。 */
  readonly label: string;
  /** 同時所有の上限。`null` は上限なし。 */
  readonly maxInstances: number | null;
}

/**
 * 所有の段階（表示用）。
 *
 * main 側の所有段階の写しであり、main の型は import しない。
 * `initializing`・`releasing` は手続き中、`cleanupFailed` は回収に失敗して
 * 残ったものであり、最終回収はホストの基盤終了に委ねる。
 */
export type PluginOwnershipPhase = "initializing" | "active" | "releasing" | "cleanupFailed";

/** 管理層が所有する個体の表示状態。段階の絞り込みはしない。 */
export interface OwnedPluginInstanceSummary {
  /** companion の種別トークン。 */
  readonly pluginKind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
  /** 所有の段階。 */
  readonly phase: PluginOwnershipPhase;
}

/** 現割当ての表示状態。基盤の割当て一覧の写しである。 */
export interface PluginAssignmentSummary {
  /** 割り当てた生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 割当て先インスタンスの識別子。 */
  readonly instanceId: string;
  /** 割当て先接続口の識別子。 */
  readonly portId: string;
}

/** プラグインの種別・所有・割当ての表示状態。 */
export interface PluginAssignmentState {
  /** 登録済み種別の一覧。 */
  readonly kinds: readonly PluginKindSummary[];
  /** 管理層が所有する個体の一覧。段階の絞り込みはしない。 */
  readonly instances: readonly OwnedPluginInstanceSummary[];
  /** 現在の割当て一覧の写し。 */
  readonly assignments: readonly PluginAssignmentSummary[];
}

/** 確定した割当ての表示状態。種別と由来・三識別子を持つ。 */
export interface PluginBindingSummary {
  /** companion の種別トークン。 */
  readonly pluginKind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
}

/**
 * 解放時の問題の表示状態。
 *
 * 失敗した段階だけを持ち、原因・状態は載せない（本文の混入があり得るため）。
 */
export interface PluginReleaseIssueSummary {
  /** 失敗した段階。 */
  readonly stage: string;
}

/** 個体の解放結果の表示状態。 */
export interface UnassignPluginResult {
  /** 初回解除なら真。二重解除なら偽。 */
  readonly released: boolean;
  /** 回収・通知の過程で起きた問題の一覧。無ければ空配列。 */
  readonly issues: readonly PluginReleaseIssueSummary[];
}

/**
 * 管理画面の表示スナップショット。
 *
 * 起動状態・endpoint・受付状態・コードを除く保留一覧・接続一覧と
 * 認可段階・生存セッション一覧・種別／所有／割当て状態を持つ。
 * テキスト本文は含めない。
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
  /** 種別／所有／割当て状態。 */
  readonly plugins: PluginAssignmentState;
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
  /**
   * 実プラグイン子画面タグの遷移規則。
   *
   * backend が登録成功後に登録済み companion の解決済み view パス集合から
   * `buildPluginNavigationRules` で生成した値の写しである。管理画面は採用中
   * snapshot のこの値をタグ属性に載せ、旧固定値や全面許可へ fallback しない。
   * 静的登録のため backend 生存期間中は不変であり、改訂進行で既存タグを
   * 作り直さない。許可範囲は空ページ＋登録済み全プラグイン scope である。
   */
  readonly pluginNavigationRules: readonly string[];
  /**
   * 現在の表示要求（表示対象一個体または無し＋表示期間の世代）。
   *
   * 管理画面はこの世代だけを正とし、古い世代の配置・応答・失敗表示では
   * 子を復活させない。管理画面遷移で世代を失効させる。業務の改訂番号とは
   * 別物であり、子 payload には載せない。
   */
  readonly pluginView: PluginViewRequest;
}

/** main→Webview の状態通知。最新の全状態を送る唯一の通知である。 */
export interface StateChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: ManagementSnapshot;
}

/**
 * 開発専用の Angular 観測口の応答。
 *
 * 管理画面（Angular）の開発ビルドだけが有効応答を返し、製品ビルドでは無効応答に
 * なる（`available` が偽）。
 * 許可するのは可否・件数・改訂番号のみであり、比較コード本文・業務
 * payload・テキスト本文は含めない。
 */
export interface NgDebugProbeResult {
  /** 開発口として有効な場合に真。 */
  readonly available: boolean;
  /** 無効の場合の理由。定型文のみ。 */
  readonly reason: string;
  /** `globalThis.ng` が存在する場合に真。 */
  readonly hasNg: boolean;
  /** ルートコンポーネントが文書にある場合に真。 */
  readonly componentMounted: boolean;
  /**
   * `ng.getComponent`（無ければ `ng.getOwningComponent`）が関数として
   * 使える場合に真。存在確認ではなく呼べることが条件である。
   */
  readonly hasGetComponent: boolean;
  /**
   * ルート要素からコンポーネント実体が取得できた場合に真。
   *
   * 有無だけを見て、実体・injector は返さない。
   */
  readonly resolvedComponent: boolean;
  /** 採用中の表示状態の改訂番号。未取得なら `null`。 */
  readonly revision: number | null;
  /** 文書にある `electrobun-webview` 要素の数。 */
  readonly webviewTagCount: number;
  /** main の JS 実行標識を検出した場合に真。 */
  readonly execMark: boolean;
}

/**
 * 開発専用の Angular 段階観測（DOM 反映）の要素単位の記録。
 *
 * 固定要素キー・矩形・表示/disabled だけを持ち、入力値・本文は
 * 含めない。矩形は表示上の確認用であり、画素の取得ではない。
 */
export interface NgDevObserveElement {
  /** 固定の要素キー（観測対象表のいずれか）。 */
  readonly key: string;
  /** 対応する要素が文書にある場合に真。 */
  readonly present: boolean;
  /** 表示されている（寸法があり隠されていない）場合に真。 */
  readonly visible: boolean;
  /** 無効化されている入力要素を含む場合に真。 */
  readonly disabled: boolean;
  /** 要素の矩形（丸めた整数）。不在・測定不能なら `null`。 */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

/**
 * 開発専用の Angular 段階観測（DOM 反映）の応答。
 *
 * RPC 成功や rAF を描画完了とは呼ばず、この DTO の到達を DOM 反映の
 * 観測とする。許可するのは固定要素キー・矩形・表示/disabled・
 * `document.hasFocus()`・activeElement キーに限り、入力値・本文・
 * 実体・injector は含めない。
 */
export interface NgDevObserveResult {
  /** 開発口として有効な場合に真。 */
  readonly available: boolean;
  /** 無効の場合の理由。定型文のみ。 */
  readonly reason: string;
  /** Angular が実際に採用した revision。観測不能時（`available:false`）は `null`。 */
  readonly adoptedRevision: number | null;
  /** 文書が焦点を持っている場合に真。 */
  readonly focus: boolean;
  /** 焦点要素の固定キー。表外・不在なら `null`。 */
  readonly activeKey: string | null;
  /** 固定要素表の順の要素単位の記録。 */
  readonly elements: readonly NgDevObserveElement[];
  /** `globalThis.ng` が存在する場合に真（補助観測）。 */
  readonly hasNg: boolean;
  /** ルートコンポーネントが文書にある場合に真（補助観測）。 */
  readonly componentMounted: boolean;
  /** ルート要素からコンポーネント実体が取得できた場合に真（有無のみ）。 */
  readonly resolvedComponent: boolean;
}

/** 限定操作の受付応答。後続の状態は `stateChanged` で受け取る。 */
export interface OperationAck {
  /** 受け付けた場合に真。 */
  readonly ok: true;
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

/** 管理画面 RPC の型。main・Webview の両方から参照する。 */
export type ManagementRpc = {
  bun: RpcSchema<
    {
      /** 表示状態の取得。読み取りは revision を進めない。 */
      getSnapshot: { params: {}; response: ManagementSnapshot };
      /** ペアリング受付を有効化する。 */
      enableAcceptance: { params: {}; response: AdmissionState };
      /** ペアリング受付を無効化する。認可済みは維持する。 */
      disableAcceptance: { params: {}; response: AdmissionState };
      /** 選択した保留の比較コードを表示用に取得する。承認はしない。 */
      getPairingView: { params: { requestId: string }; response: PairingViewResult };
      /** 保留を要求 ID だけで承認する。比較コードは表示専用（snapshot に載せない）。結果の成否は server が決める。 */
      approvePairing: {
        params: { requestId: string };
        response: ApprovalResult;
      };
      /** 保留を取り下げ、対象の接続を終了する。 */
      rejectPairing: { params: { requestId: string }; response: RejectionResult };
      /** 指定接続だけを切断する。待ち受けと他接続は維持する。 */
      disconnectConnection: { params: { connectionId: string }; response: OperationAck };
      /**
       * 汎用プラグインの割当て。種別トークンと生存セッションの指定だけを受け、
       * 管理記述子に従って割り当てる。
       *
       * `localSessionId` を省略した場合は方針に従い候補から選ぶ。指定した
       * 場合はその生存セッションへ割り当て、方針の選択結果が指定と一致しな
       * ければ拒否する。
       */
      assignPlugin: {
        params: { pluginKind: string; localSessionId?: string };
        response: PluginBindingSummary;
      };
      /**
       * 汎用プラグインの解除。描画した所有記録の三識別子で照合し、
       * 完全一致する所有だけを回収する。
       *
       * 所有があるのに三識別子が不一致の場合は拒否し、新束縛へ転送しない。
       * 回収済み・未知の識別子は `{released:false, issues:[]}` とする。
       */
      unassignPlugin: {
        params: { instanceId: string; localSessionId: string; portId: string };
        response: UnassignPluginResult;
      };
      /**
       * 実プラグイン子画面の失敗消去と現割当てへの再配置（個体限定）。
       *
       * 指定した実インスタンスの失敗表示だけを消し、その個体が現割当てに
       * あれば配置を作り直す。他個体の失敗・既存の配置・割当て・送信には
       * 触らない。受付であり準備完了を保証しない。同一表示期間の再試行は
       * 世代を維持し、自動ループはしない。
       */
      retryPluginMount: { params: { instanceId: string }; response: OperationAck };
      /**
       * 実プラグイン子画面の表示要求。表示対象一個体または無しを伝える。
       *
       * 管理画面の配置制御であり、子とアプリ本体の直接のデータ交換では
       * ない。世代は表示期間の識別であり、業務の改訂番号とは別物である。
       * 受付であり、古い世代は snapshot への反映を行わない。画面は
       * snapshot の `pluginView` の世代だけを正とする。管理画面遷移では
       * 無し・新しい世代を送り、旧世代を失効させる。
       */
      setPluginView: { params: PluginViewRequest; response: OperationAck };
      /** アプリ終了を要求する。後始末完了後に終了する。 */
      quit: { params: {}; response: OperationAck };
    },
    {/** Webview からの通知口。子専用の ready・ping・状態取得は持たない。 */}
  >;
  webview: RpcSchema<
    {
      /**
       * 開発専用の Angular 観測口。管理画面（Angular）の開発ビルドだけが
       * 有効応答を返し、製品ビルドでは無効応答になる。
       * main は明示の opt-in（`BRIDGE_GUI_NG_DEBUG=1`）でのみ呼ぶ。
       */
      ngDebugProbe: { params: {}; response: NgDebugProbeResult };
      /**
       * 開発専用の Angular 段階観測（DOM 反映）。管理画面（Angular）の開発ビルドだけが
       * 有効応答を返し、製品ビルドでは無効応答になる。固定要素キー・矩形・
       * 表示/disabled・焦点だけを返し、入力値・本文は含めない。開発接続口
       * （loopback）が操作実行後の段階観測として呼ぶ。
       */
      ngDevObserve: { params: { revision: number }; response: NgDevObserveResult };
    },
    {
      /** main からの状態 push。 */
      stateChanged: StateChangedMessage;
    }
  >;
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
