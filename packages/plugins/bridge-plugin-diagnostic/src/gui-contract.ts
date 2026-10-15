/**
 * 診断子画面の固有契約の正本（`./gui-contract`）。
 *
 * 要求名・イベント名・限定 DTO・実行時検証・種別トークン・相対 entrypoint の
 * 定義元はここだけであり、重複定義を持たない。中継の共通形
 * （子→プラグイン `{method, params}`・プラグイン→子 `{event, payload}`）の
 * 外形だけを共有契約（`bridge-gui-contract/plugin-instance`）から借り、
 * 業務上の型・名前・検証はここが所有する。アプリ本体は不透明中継のみであり、
 * 内容を解釈しない。表示先は相対 entrypoint の宣言だけを持ち、絶対
 * `views://` パスや子画面 URL の組み立ては持たない。解決（配置先・`views://`
 * パス・URL 組み立て）はホスト（composition の静的 manifest と対応付け）が
 * 行う。子画面（`src/view/index.ts`）は同パッケージ内の相対参照、GUI 側は
 * `bridge-plugin-diagnostic/gui-contract` を参照する。実行時依存を持たず、
 * ブラウザ安全な構成とする。
 *
 * @packageDocumentation
 */

/**
 * 診断の応答統計の表示用抜粋。echo／ping 件数だけを持ち、本文は持たない。
 */
export interface DiagnosticViewStats {
  /** echo 応答の送信試行件数。 */
  readonly diagnosticEcho: number;
  /** ping 応答の送信試行件数。 */
  readonly diagnosticPing: number;
}

/**
 * 診断個体の限定表示。束縛情報と応答統計と改訂番号の組である。
 *
 * 子画面は状態を持たず、この表示を改訂番号の新旧で採用するだけである。
 */
export interface DiagnosticInstanceView {
  /** 束縛した実インスタンスの識別子。再利用しない。 */
  readonly instanceId: string;
  /** 由来プラグインの識別子。 */
  readonly pluginId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛個体の echo／ping 応答統計。 */
  readonly stats: DiagnosticViewStats;
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
}

/** 子から診断プラグインへの初期取得の要求名。唯一の要求である。 */
export const DIAGNOSTIC_RELAY_METHOD_GET_STATE = "getDiagnosticState";

/** 診断プラグインから子への状態通知のイベント名。唯一の通知である。 */
export const DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED = "diagnosticStateChanged";

/**
 * 未知の要求・不正な引数に対する不透明なエラー値。
 *
 * 業務エラーは投げず値として返す（プラグインの結果として扱う）。投げた例外は
 * 想定外の失敗として中継失敗に落とす。`RangeError` を投げても束縛失効とは
 * 解釈しない（失効はホスト自身の照合が決める）。
 */
export interface DiagnosticRelayError {
  /** 業務上の失敗である印。中継自体の失敗（`PluginRelayResult` の `error`）とは別である。 */
  readonly ok: false;
  /** 失敗の符号。 */
  readonly code: "unknown-method" | "bad-params";
  /** 人間向けの短い理由。本文・payload は含めない。 */
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
 * 空でない文字列か判定する。
 *
 * @param value - 判定する値。
 * @returns 空でない文字列であれば真。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 有限の非負整数か判定する。
 *
 * @param value - 判定する値。
 * @returns 有限の非負整数であれば真。
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 初期取得の引数の形状か判定する。引数は空の組みだけを受け付ける。
 *
 * @param value - 検査する未知値。
 * @returns 空のプレーンオブジェクトであれば真。
 */
export function isDiagnosticGetStateParams(value: unknown): value is Record<string, never> {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 0;
}

/**
 * 診断個体の限定表示の形状か判定する。子と endpoint の両方が使う。
 *
 * @param value - 検査する未知値。
 * @returns 限定表示の形状であれば真。
 */
export function isDiagnosticInstanceView(value: unknown): value is DiagnosticInstanceView {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["instanceId"])) return false;
  if (!isNonEmptyString(value["pluginId"])) return false;
  if (!isNonEmptyString(value["portId"])) return false;
  if (!isNonEmptyString(value["localSessionId"])) return false;
  if (!isNonNegativeInteger(value["revision"])) return false;
  const stats: unknown = value["stats"];
  if (!isRecord(stats)) return false;
  if (!isNonNegativeInteger(stats["diagnosticEcho"])) return false;
  if (!isNonNegativeInteger(stats["diagnosticPing"])) return false;
  return true;
}

/**
 * 不透明なエラー値の形状か判定する。子が業務エラーを識別するために使う。
 *
 * @param value - 検査する未知値。
 * @returns 不透明なエラー値の形状であれば真。
 */
export function isDiagnosticRelayError(value: unknown): value is DiagnosticRelayError {
  if (!isRecord(value)) return false;
  if (value["ok"] !== false) return false;
  const code: unknown = value["code"];
  if (code !== "unknown-method" && code !== "bad-params") return false;
  const message: unknown = value["message"];
  return typeof message === "string" && message.length > 0;
}

/** 診断 companion の種別トークン。マウント識別子に載る。 */
export const DIAGNOSTIC_MOUNT_KIND = "diagnostic";

/**
 * 診断子画面の相対 entrypoint。資産ルート（`src/view`）起点である。
 *
 * 解決済み `views://` パス・配置先・コピー表の正本はホストの静的 manifest
 * （`src/composition/bundled-plugin-assets.ts`）が持ち、ここでは相対名だけを
 * 宣言する。一致は資産の同期テストで固定する。ホストへ宣言する bundle の
 * entry はこの解決後の相対 entry（`index.html`）だけである。
 */
export const DIAGNOSTIC_VIEW_ENTRY = "index.html";

/** 診断子画面の表示スクリプトの相対 entrypoint。 */
export const DIAGNOSTIC_SCRIPT_ENTRY = "index.ts";

/** 診断子画面の表示様式の相対 entrypoint。 */
export const DIAGNOSTIC_STYLE_ENTRY = "index.css";
