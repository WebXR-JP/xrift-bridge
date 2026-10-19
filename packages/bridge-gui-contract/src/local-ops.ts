/**
 * 製品向けローカル業務操作の共有契約。
 *
 * 許可操作の分類・依存不要な型・安全な射影・人間操作の定型応答を
 * 型と純粋関数だけで定義する。実行時の依存を持たない（型のみの import と
 * 純粋関数だけ）。契約に zod や node 組み込みは持ち込まない。工具の入力検証と
 * 広告 schema は main 側の同じ schema 定義から行い、ここには置かない。
 * 接続口ごとの差（承認を実行するか、DOM 段階観測を使うか）は各接続口に残し、
 * ここでは接続口の種類で分岐しない。
 *
 * ADR: 許可操作は固定 allowlist であり、任意の操作名・任意コード実行・
 * 画素取得・実入力の自動操作は持たない。承認（ペアリングの承認／拒否）は
 * 分類上は区別するが実行しない。人間の GUI 操作を要する定型応答に落とし、
 * 自動では承認も拒否もしない。開発用接続口では従来どおり実行できるため、
 * 実行するか定型応答に落とすかの差は接続口側に置く。
 *
 * ADR: 射影は allowlist（返す項目を列挙）であり、denylist（落とす項目を列挙）
 * ではない。比較コード本文・通信本文・業務 payload・テキスト本文・生の
 * snapshot は含めない。開発用の要約が件数だけであるのに対し、MCP 用には
 * 操作対象の発見に要る識別子（要求・接続・セッション・種別・個体・旧世代番号）を
 * 選んで返す。`Origin`・認可段階・論理セッション名・endpoint は操作に要らない
 * ため載せない。
 *
 * @packageDocumentation
 */
import type { BackendStatus, ManagementSnapshot } from "./management.ts";
import type { AdoptedPluginView } from "./plugin-instance.ts";

/**
 * 製品向け MCP で実行する許可操作の固定一覧。
 *
 * 設計の操作粒度（受付の有効化／無効化、ペアリングの表示、プラグインの
 * 割当て／解除、子画面の切替え）に状態取得を加えたものである。終了
 * （`quit`）・接続切断・子画面の再試行は含めない。承認／拒否は
 * `LOCAL_HUMAN_ONLY_OPS` に分け、ここには載せない。
 */
export const LOCAL_EXECUTABLE_OPS = [
  "getSnapshot",
  "enableAcceptance",
  "disableAcceptance",
  "getPairingView",
  "assignPlugin",
  "unassignPlugin",
  "setPluginView",
] as const;

/** 製品向け MCP で実行する許可操作名。 */
export type LocalExecutableOpName = (typeof LOCAL_EXECUTABLE_OPS)[number];

/**
 * 製品向け MCP では実行せず、人間の GUI 操作を要する定型応答に落とす操作の一覧。
 *
 * ペアリングの承認／拒否である。開発用接続口では従来どおり実行できるため、
 * 実行するか定型応答に落とすかの差は接続口側に置き、ここでは区別だけを扱う。
 */
export const LOCAL_HUMAN_ONLY_OPS = ["approvePairing", "rejectPairing"] as const;

/** 人間の GUI 操作を要する操作名。 */
export type LocalHumanOnlyOpName = (typeof LOCAL_HUMAN_ONLY_OPS)[number];

/**
 * 製品向け MCP が知っている操作の全一覧（実行する操作＋人間限定の操作）。
 *
 * 工具の一覧広告と未知操作名の拒否に使う。`quit`・接続切断・子画面の再試行・
 * 任意名はここに含めない。
 */
export const LOCAL_KNOWN_OPS = [...LOCAL_EXECUTABLE_OPS, ...LOCAL_HUMAN_ONLY_OPS] as const;

/** 製品向け MCP が知っている操作名。 */
export type LocalKnownOpName = (typeof LOCAL_KNOWN_OPS)[number];

/**
 * 操作名が実行する許可操作にあるか判定する。
 *
 * @param value - 検査する未知値。
 * @returns 実行する許可操作名の場合に真。
 */
export function isLocalExecutableOp(value: unknown): value is LocalExecutableOpName {
  return typeof value === "string" && (LOCAL_EXECUTABLE_OPS as readonly string[]).includes(value);
}

/**
 * 操作名が人間限定の操作にあるか判定する。
 *
 * @param value - 検査する未知値。
 * @returns 人間限定の操作名の場合に真。
 */
export function isLocalHumanOnlyOp(value: unknown): value is LocalHumanOnlyOpName {
  return typeof value === "string" && (LOCAL_HUMAN_ONLY_OPS as readonly string[]).includes(value);
}

/**
 * 操作名が知っている操作の一覧にあるか判定する。
 *
 * @param value - 検査する未知値。
 * @returns 知っている操作名の場合に真。
 */
export function isLocalKnownOp(value: unknown): value is LocalKnownOpName {
  return isLocalExecutableOp(value) || isLocalHumanOnlyOp(value);
}

/** 承認の要求に対する定型応答の文言。例外内容・秘密は載せない。 */
export const LOCAL_APPROVAL_REQUIRED_MESSAGE = "承認は人間の GUI 操作でのみ成立する。";

/**
 * 承認の要求に対する定型応答。人間の GUI 操作を要し、自動では承認も拒否もしない。
 */
export interface LocalHumanApprovalNotice {
  /** 人間の操作を要する場合に真。 */
  readonly requiresHumanOperation: true;
  /** 人間向けの短い理由（定型文のみ）。 */
  readonly message: string;
}

/**
 * 承認の要求に対する定型応答を作る。
 *
 * backend を呼ばず、この応答だけを返す。比較コード本文・業務 payload は含めない。
 *
 * @returns 人間の GUI 操作を要する旨の定型応答。
 */
export function localHumanApprovalNotice(): LocalHumanApprovalNotice {
  return { requiresHumanOperation: true, message: LOCAL_APPROVAL_REQUIRED_MESSAGE };
}

/**
 * プラグイン種別の参照（操作対象の発見用）。
 *
 * 種別の選択に要る項目だけを持ち、上限・本文は載せない。
 */
export interface LocalPluginKindRef {
  /** companion の種別トークン。 */
  readonly pluginKind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
}

/**
 * 所有個体の参照（解除・子画面切替えの対象発見用）。
 *
 * 解除の三識別子と由来だけを持ち、所有の段階・本文は載せない。
 */
export interface LocalOwnedInstanceRef {
  /** companion の種別トークン。 */
  readonly pluginKind: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 束縛した実インスタンスの識別子。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
}

/**
 * 製品向け MCP が返す表示状態の安全な射影。
 *
 * 改訂番号・起動状態・受付の有無と、操作対象の発見に要る識別子（要求・接続・
 * セッション・種別・個体・採用済み表示）だけを持つ。比較コード本文・業務
 * payload・テキスト本文・`Origin`・認可段階・論理セッション名・endpoint・
 * 子画面の配置・遷移規則・生の snapshot は含めない。
 */
export interface LocalStatusSummary {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 起動状態。 */
  readonly backend: BackendStatus;
  /** 受付が有効かどうか。 */
  readonly accepting: boolean;
  /** 照合待ちの要求識別子の一覧。 */
  readonly pendingRequestIds: readonly string[];
  /** 接続識別子の一覧。 */
  readonly connectionIds: readonly string[];
  /** 生存セッションのローカル識別子の一覧。 */
  readonly localSessionIds: readonly string[];
  /** 登録済みプラグイン種別の一覧。 */
  readonly pluginKinds: readonly LocalPluginKindRef[];
  /** 所有中のプラグイン個体の一覧。 */
  readonly ownedInstances: readonly LocalOwnedInstanceRef[];
  /** 現在の採用済み表示対象と世代（切替えの基準世代に使う）。 */
  readonly pluginView: AdoptedPluginView;
}

/**
 * 表示状態を安全な射影に落とす。
 *
 * 許可項目だけを明示的に抜き出し、余分な項目は捨てる。生の snapshot を
 * そのまま返さない。
 *
 * @param snapshot - `GuiBackend` の表示状態。
 * @returns 応答用の要約。
 */
export function summarizeLocalStatus(snapshot: ManagementSnapshot): LocalStatusSummary {
  return {
    revision: snapshot.revision,
    backend: snapshot.backend,
    accepting: snapshot.admission.accepting,
    pendingRequestIds: snapshot.pending.map((entry) => entry.requestId),
    connectionIds: snapshot.connections.map((connection) => connection.connectionId),
    localSessionIds: snapshot.sessions.map((session) => session.localSessionId),
    pluginKinds: snapshot.plugins.kinds.map((kind) => ({
      pluginKind: kind.pluginKind,
      pluginId: kind.pluginId,
    })),
    ownedInstances: snapshot.plugins.instances.map((instance) => ({
      pluginKind: instance.pluginKind,
      pluginId: instance.pluginId,
      instanceId: instance.instanceId,
      localSessionId: instance.localSessionId,
      portId: instance.portId,
    })),
    // ADR: 対象と世代だけを明示射影する。spread では入力側の余分な項目まで
    // 写るため、allowlist であることを構造で保つ。
    pluginView: {
      instanceId: snapshot.pluginView.instanceId,
      viewGeneration: snapshot.pluginView.viewGeneration,
    },
  };
}

/**
 * 業務結果の応答用要約。秘密（比較コード本文・業務 payload・テキスト本文）
 * を含まない。識別子・状態符号・採用状態だけを載せる。
 */
export type LocalOpResultSummary =
  | { readonly kind: "status"; readonly status: LocalStatusSummary }
  | { readonly kind: "admission"; readonly accepting: boolean }
  | {
      readonly kind: "pairingAvailability";
      readonly available: boolean;
      readonly requestId: string | null;
    }
  | {
      readonly kind: "assignment";
      readonly pluginKind: string;
      readonly pluginId: string;
      readonly localSessionId: string;
      readonly instanceId: string;
      readonly portId: string;
    }
  | { readonly kind: "unassignment"; readonly released: boolean; readonly issues: number }
  | {
      readonly kind: "pluginView";
      readonly adopted: boolean;
      readonly instanceId: string | null;
      readonly viewGeneration: number;
    };

/**
 * 工具の正常応答本文。業務結果の要約に操作完了直後の改訂番号を組にしたもの。
 *
 * 改訂番号は操作固有の通番ではなく、変更がなければ進まない場合がある。
 * 応答時までの不変性や GUI の採用・描画完了は保証しない。人間操作の案内定型応答と
 * 失敗応答には付けない。
 */
export type LocalToolResponseBody = LocalOpResultSummary & { readonly revision: number };

/**
 * 業務結果を応答用の要約に落とす。
 *
 * 操作ごとに許可項目だけを抜き出し、比較コード本文・業務 payload・
 * テキスト本文は捨てる。`getPairingView` は有無と要求識別子だけに落とす
 * （本文の取得と承認の自動化をしない）。`setPluginView` は RPC 成功と
 * 採用を混同せず、採用／stale と現在の採用済み対象・世代を残す。
 *
 * @param op - 実行した許可操作名。
 * @param result - backend が返した業務結果。
 * @returns 応答用の要約。
 */
export function summarizeLocalResult(
  op: LocalExecutableOpName,
  result: unknown,
): LocalOpResultSummary {
  // ADR: `as` で実行時の検証を主張しない。`result` は信頼済みの backend 戻り値
  // （または同じ形の試験代役）を射影する前提であり、ここでは object である
  // ことだけを確かめる。項目の有無・型は各分岐の `typeof`・`Array.isArray` 検査で
  // 落とし、未知の形は既定値に倒す。主張する型が成立する根拠はこの前提である。
  const table = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  switch (op) {
    case "getSnapshot": {
      // ADR: `getSnapshot` の結果は backend の表示状態（信頼済み）であり、
      // `summarizeLocalStatus` が許可項目だけを抜く前提である。
      return { kind: "status", status: summarizeLocalStatus(result as ManagementSnapshot) };
    }
    case "enableAcceptance":
    case "disableAcceptance": {
      return { kind: "admission", accepting: table["accepting"] === true };
    }
    case "getPairingView": {
      // 有無と要求識別子だけを返し、比較コード本文・表示形は捨てる。
      if (table["available"] !== true) {
        return { kind: "pairingAvailability", available: false, requestId: null };
      }
      const requestId = table["requestId"];
      return {
        kind: "pairingAvailability",
        available: true,
        requestId: typeof requestId === "string" ? requestId : null,
      };
    }
    case "assignPlugin": {
      return {
        kind: "assignment",
        pluginKind: typeof table["pluginKind"] === "string" ? table["pluginKind"] : "",
        pluginId: typeof table["pluginId"] === "string" ? table["pluginId"] : "",
        localSessionId: typeof table["localSessionId"] === "string" ? table["localSessionId"] : "",
        instanceId: typeof table["instanceId"] === "string" ? table["instanceId"] : "",
        portId: typeof table["portId"] === "string" ? table["portId"] : "",
      };
    }
    case "unassignPlugin": {
      const issues = table["issues"];
      return {
        kind: "unassignment",
        released: table["released"] === true,
        issues: Array.isArray(issues) ? issues.length : 0,
      };
    }
    case "setPluginView": {
      // RPC 成功と採用を混同しないため、採用／stale と現在の採用済みを残す。
      // ADR: `current` は backend 戻り値の採用済み表示（信頼済み）を射影する
      // 前提であり、object であることだけを確かめて各項目を検査する。
      const current =
        typeof table["current"] === "object" && table["current"] !== null
          ? (table["current"] as Record<string, unknown>)
          : {};
      const instanceId = current["instanceId"];
      const viewGeneration = current["viewGeneration"];
      return {
        kind: "pluginView",
        adopted: table["adopted"] === true,
        instanceId: typeof instanceId === "string" && instanceId.length > 0 ? instanceId : null,
        viewGeneration:
          typeof viewGeneration === "number" &&
          Number.isInteger(viewGeneration) &&
          viewGeneration >= 0
            ? viewGeneration
            : -1,
      };
    }
  }
}
