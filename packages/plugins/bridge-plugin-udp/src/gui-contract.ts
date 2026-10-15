/**
 * UDP子画面の固有契約の正本（`./gui-contract`）。
 *
 * 子 WebView とプラグイン本体は、起動時の静的登録で決めた不透明な RPC で
 * だけ通信する。中継の共通形は子→プラグイン `{method, params}`、
 * プラグイン→子 `{event, payload}` であり、アプリ本体は不透明中継のみで
 * 内容を解釈しない。業務上の型・要求名・イベント名・実行時検証はここ
 * （`gui-contract`）と endpoint が所有する。
 *
 * 本体（`plugin.ts`）は `node:dgram` を import するため、ここからは型だけを
 * type-only で借り、実行時 import はしない。子画面・endpoint から実行時に
 * 使う純粋関数・定数はここに置く。表示先は相対 entrypoint の宣言だけを
 * 持ち、絶対 `views://` パスや子画面 URL の組み立ては持たない。解決は
 * ホスト（composition の静的 manifest と対応付け）が行う。
 *
 * @packageDocumentation
 */
import type {
  UdpBindConfig,
  UdpControlResult,
  UdpPhase,
  UdpSocketAddress,
  UdpStats,
} from "./plugin.ts";

/** UDP companion の種別トークン。マウント識別子に載る。 */
export const UDP_MOUNT_KIND = "udp";

/**
 * UDP子画面の相対 entrypoint。資産ルート（`src/view`）起点である。
 *
 * 解決済み `views://` パス・配置先・コピー表の正本はホストの静的 manifest
 * （`src/composition/bundled-plugin-assets.ts`）が持ち、ここでは相対名だけを
 * 宣言する。一致は資産の同期テストで固定する。ホストへ宣言する bundle の
 * entry はこの解決後の相対 entry（`index.html`）だけである。
 */
export const UDP_VIEW_ENTRY = "index.html";

/** UDP子画面の表示スクリプトの相対 entrypoint。 */
export const UDP_SCRIPT_ENTRY = "index.ts";

/** UDP子画面の表示様式の相対 entrypoint。 */
export const UDP_STYLE_ENTRY = "index.css";

/**
 * UDP 開始・停止 request の RPC 待機期限（ミリ秒）。
 *
 * 制御操作は手元の bind・閉塞完了待ちであり、応答待ちのような長期待機は
 * 無い。余裕は OS の bind・閉塞の遅延用であり、自動再送の猶予ではない。
 * RPC 自体の失敗は開始・停止の成否とみなさず、状態再取得で確かめる。
 */
export const UDP_SEND_REQUEST_TIMEOUT_MS = 10_000;

/** 子→プラグインの要求名。初期状態の取得であり、識別子の指定は受け付けない。 */
export const UDP_RELAY_METHOD_GET_STATE = "getState";

/** 子→プラグインの要求名。bind 設定と非 loopback 確認だけを受け付ける。 */
export const UDP_RELAY_METHOD_START = "start";

/** 子→プラグインの要求名。束縛個体の UDP 受信停止であり、引数は要らない。 */
export const UDP_RELAY_METHOD_STOP = "stop";

/** プラグイン→子のイベント名。表示用 DTO の到着であり、最新値へ集約してよい。 */
export const UDP_RELAY_EVENT_STATE = "stateChanged";

/**
 * 束縛個体の表示用 DTO。payload 本文は含めない（統計だけを持つ）。
 *
 * 本体の状態に束縛の要約（個体・割当て・接続口）を付けたものであり、
 * endpoint が組み立てて emission port へ送り、子が表示する。
 * `revision` は本体が所有する単調増加の改訂番号を引き継ぐだけであり、
 * 子は新しい状態のみ採用する。
 */
export interface UdpCompanionSnapshot {
  /** 本体が所有する単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
  /** 現在の段階。 */
  readonly phase: UdpPhase;
  /** 直近に要求した bind 設定。未開始なら `null`。 */
  readonly requestedBind: UdpBindConfig | null;
  /** 実際の待受け先。待受け中でなければ `null`。 */
  readonly boundAddress: UdpSocketAddress | null;
  /** `start()` を受け付ける状態なら真。 */
  readonly canStart: boolean;
  /** 待受け中なら真。 */
  readonly isRunning: boolean;
  /** インスタンス単位の統計。 */
  readonly stats: UdpStats;
  /** 直近の異常終了・失敗の説明。無ければ `null`。 */
  readonly lastError: string | null;
}

/**
 * `start` 要求の params の形。bind 設定と非 loopback 確認だけを持つ。
 *
 * 個体識別子の指定は受け付けない。詳細検証は本体の操作口が行い、
 * ここでは外形だけを見る。
 */
export interface UdpStartRelayParams {
  /** bind 設定。 */
  readonly bind: unknown;
  /** 非 loopback への bind を許すか。 */
  readonly allowNonLoopback: unknown;
}

/**
 * 未知 method への不透明なエラー値。業務エラーとして子へ返す。
 *
 * 投げた例外（中継失敗）とは区別し、反射呼出しはしない。
 */
export interface UdpUnknownMethodError {
  /** 成功しなかったことを表す。 */
  readonly ok: false;
  /** 未知の要求名であること。 */
  readonly reason: "unknown-method";
  /** 人間向けの短い理由。 */
  readonly message: string;
}

/**
 * プレーンオブジェクトか判定する。
 *
 * @param value - 判定する値。
 * @returns 配列でないオブジェクトであれば真。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * bind 設定の外形か判定する。詳細検証は本体の操作口が行う。
 *
 * @param value - 検査する未知値。
 * @returns `{address, port}` 項目を持てば真。
 */
function isBindShape(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && "address" in value && "port" in value;
}

/**
 * 表示用 DTO の外形か判定する。子・endpoint の受付前段であり、統計値の
 * 範囲までは問わない。
 *
 * @param value - 検査する未知値。
 * @returns 表示に要る項目をすべて持てば真。
 */
export function isUdpCompanionSnapshot(value: unknown): value is UdpCompanionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value["revision"] === "number" &&
    Number.isInteger(value["revision"]) &&
    (value["revision"] as number) >= 0 &&
    typeof value["instanceId"] === "string" &&
    typeof value["localSessionId"] === "string" &&
    typeof value["portId"] === "string" &&
    typeof value["phase"] === "string" &&
    (value["requestedBind"] === null || isBindShape(value["requestedBind"])) &&
    (value["boundAddress"] === null || isRecord(value["boundAddress"])) &&
    typeof value["canStart"] === "boolean" &&
    typeof value["isRunning"] === "boolean" &&
    isRecord(value["stats"]) &&
    (value["lastError"] === null || typeof value["lastError"] === "string")
  );
}

/**
 * `start` 要求の params の外形か判定する。詳細検証は本体の操作口が行う。
 *
 * @param value - 検査する未知値。
 * @returns `{bind, allowNonLoopback}` 項目を持てば真。
 */
export function isUdpStartRelayParams(value: unknown): value is UdpStartRelayParams {
  if (!isRecord(value)) return false;
  return "bind" in value && "allowNonLoopback" in value;
}

/**
 * 開始・停止の結果の外形か判定する。子が不透明な応答値を解釈する前段である。
 *
 * @param value - 検査する未知値。
 * @returns 成功または理由付きの失敗の形であれば真。
 */
export function isUdpControlResult(value: unknown): value is UdpControlResult {
  if (!isRecord(value)) return false;
  if (value["ok"] === true) return true;
  return (
    value["ok"] === false &&
    typeof value["reason"] === "string" &&
    typeof value["message"] === "string"
  );
}
