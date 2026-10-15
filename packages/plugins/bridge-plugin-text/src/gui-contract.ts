/**
 * テキスト子画面の固有契約の正本（`./gui-contract`）。
 *
 * 限定 DTO・種別トークン・相対 entrypoint・子が使う要求名と通知名の定義元は
 * ここだけであり、重複定義を持たない。移送の外形（`{method, params}`・
 * `{event, payload}`・`PluginRelayResult`）は共有契約
 * （`bridge-gui-contract/plugin-instance` の `CompanionChannelRpc`）を土台にし、
 * 業務上の型・要求名・イベント名・実行時検証はここ（と endpoint）が所有する。
 * アプリ本体は `unknown` として素通しし、内容検査をしない。
 *
 * 表示先は相対 entrypoint の宣言だけを持ち、絶対 `views://` パスや子画面 URL
 * の組み立ては持たない。解決はホストが行う。子画面（`src/view/index.ts`）は
 * 同パッケージ内の相対参照、GUI 側は `bridge-plugin-text/gui-contract` を
 * 参照する。本文は DTO に載せない（本文は送信要求にだけ載せ、表示は
 * 統計・pending・直近結果等に限る）。
 *
 * 実行環境非依存であり、Bun・Node の実行依存を持たない。本体（`plugin.ts`）
 * からは型だけを type-only で借り、実行時 import はしない。
 *
 * @packageDocumentation
 */
import type { TextSendResult, TextStats } from "./plugin.ts";

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
 * 初期取得の要求名。子がイベントハンドラ登録後に送る。
 *
 * `CompanionChannelRpc` の `relay`（`{method, params}`）の `method` に載せる。
 * 引数は空の組みであり、対象個体の指定は受け付けない。
 */
export const TEXT_GET_STATE_METHOD = "getTextState";

/**
 * 本文送信の要求名。束縛個体の現割当てへ送る。
 *
 * `CompanionChannelRpc` の `relay` の `method` に載せる。本文だけを受け、
 * 割当て識別子の指定は受け付けない。
 */
export const TEXT_SEND_TEXT_METHOD = "sendText";

/**
 * 状態通知のイベント名。本体変更の確定ごとに送る唯一の通知である。
 *
 * `CompanionChannelRpc` の `emitted`（`{event, payload}`）の `event` に載せる。
 */
export const TEXT_STATE_CHANGED_EVENT = "textStateChanged";

/**
 * テキスト送信 request の RPC 待機期限（ミリ秒）。
 *
 * プラグインの応答期限（`TEXT_RESPONSE_TIMEOUT_MS`＝10秒）より長くし、
 * 反映確認の到達を RPC 側の期限切れで落とさない。余裕は遅延確認の到達用で
 * あり、自動再送の猶予ではない。RPC 自体の失敗は反映確認とみなさず、
 * 状態再取得で確かめる。
 */
export const TEXT_SEND_REQUEST_TIMEOUT_MS = 15_000;

/** 初期取得の試行回数の上限。使い果たしたら子画面に残す。 */
export const TEXT_INITIAL_FETCH_ATTEMPTS = 3;

/** 初期取得の再試行の間隔（ミリ秒）。 */
export const TEXT_INITIAL_FETCH_RETRY_MS = 200;

/**
 * 子画面が表示するテキスト個体の状態。本文は含めない。
 *
 * `CompanionChannelRpc` の `emitted` の `payload` と `relay` の初期取得の
 * 応答値（`PluginRelayResult` の `value`）に載せる。改訂番号は本体が進めた
 * 値を引き継ぐだけであり、子は新しい状態のみ採用する。
 */
export interface TextChildSnapshot {
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
  /** 束縛した実インスタンスの識別子。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
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
 * 本文送信の要求引数。本文だけを受け、割当て識別子の指定は受け付けない。
 *
 * `relay` の `params` に載せる。詳細検証は endpoint が行う。
 */
export interface TextSendTextParams {
  /** 送信する本文。検証前の値であり、endpoint が検証する。 */
  readonly text: unknown;
}

/**
 * 本文送信の業務拒否。投げず不透明な応答値として返す。
 *
 * `relay` の応答（`PluginRelayResult` の `value`）に載せる。中継自体の失敗
 * （`ok: false`）とは区別する。
 */
export interface TextSendRefused {
  /** 人間向けの短い理由。本文は含めない。 */
  readonly error: string;
}

/**
 * 本文送信の応答値。反映確認・結果不明または業務拒否のいずれかである。
 *
 * 送信処理の失敗（拒否）はここに載せ、`RangeError` を投げない。投げた例外は
 * 想定外の失敗として中継失敗に落とす。
 */
export type TextSendTextResponse = TextSendResult | TextSendRefused;

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
 * 送信要求引数の形状か判定する。endpoint の受付前段であり、本文の詳細検証は
 * 別途行う。
 *
 * @param value - 検査する未知値。
 * @returns `text` 項目を持つ組みであれば真。
 */
export function isTextSendTextParams(value: unknown): value is TextSendTextParams {
  return isRecord(value) && "text" in value;
}

/**
 * 送信結果（反映確認・結果不明）の形状か判定する。
 *
 * @param value - 検査する未知値。
 * @returns 送信の決着の形状であれば真。
 */
export function isTextSendResult(value: unknown): value is TextSendResult {
  if (!isRecord(value)) return false;
  if (value["status"] === "acknowledged") {
    return typeof value["id"] === "string" && (value["id"] as string).length > 0;
  }
  if (value["status"] === "unknown") {
    return (
      typeof value["id"] === "string" &&
      (value["id"] as string).length > 0 &&
      (value["reason"] === "timeout" ||
        value["reason"] === "disconnected" ||
        value["reason"] === "disposed")
    );
  }
  return false;
}

/**
 * 業務拒否の形状か判定する。
 *
 * @param value - 検査する未知値。
 * @returns 短い理由を持つ拒否であれば真。
 */
export function isTextSendRefused(value: unknown): value is TextSendRefused {
  return (
    isRecord(value) &&
    typeof value["error"] === "string" &&
    (value["error"] as string).length > 0 &&
    (value as Record<string, unknown>)["status"] === undefined
  );
}

/**
 * 子画面の表示状態の形状か判定する。子と endpoint の両方が使う。
 *
 * 本文が載っていないことも確かめ、載っていたら偽とする。
 *
 * @param value - 検査する未知値。
 * @returns 表示状態の形状であれば真。
 */
export function isTextChildSnapshot(value: unknown): value is TextChildSnapshot {
  if (!isRecord(value)) return false;
  if ("text" in value) return false;
  const revision = value["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return false;
  if (typeof value["instanceId"] !== "string" || value["instanceId"] === "") return false;
  if (typeof value["localSessionId"] !== "string" || value["localSessionId"] === "") return false;
  if (typeof value["portId"] !== "string" || value["portId"] === "") return false;
  if (typeof value["canSend"] !== "boolean") return false;
  const pendingId = value["pendingId"];
  if (!(pendingId === null || (typeof pendingId === "string" && pendingId.length > 0)))
    return false;
  const lastResult = value["lastResult"];
  if (!(lastResult === null || isTextSendResult(lastResult))) return false;
  const stats = value["stats"];
  if (!isRecord(stats)) return false;
  return (
    typeof stats["attempts"] === "number" &&
    typeof stats["acknowledged"] === "number" &&
    typeof stats["unknown"] === "number"
  );
}
