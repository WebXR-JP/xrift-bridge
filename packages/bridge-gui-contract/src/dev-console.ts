/**
 * 開発専用の AI 操作・観測口（loopback 接続口）の契約。
 *
 * AI から loopback 接続口→Bun main→限定 Webview RPC→共通操作サービス→
 * 既存管理 RPC→backend の経路で操作と段階観測を行う。実行時の依存を
 * 持たない（型のみの import と純粋関数だけ）。
 *
 * ADR: 有効条件は三つ（開発ビルドかつ明示 opt-in かつ隔離実行）であり、
 * stable は環境変数を設定しても待受を開かない。開発ビルドの判定は
 * Electrobun の包装時チャンネル（dev 包装の `Resources/version.json`・
 * stable 包装の `Resources/metadata.json` の `channel`。devkit の
 * `BuildConfig`（`api/sdks/main/core/BuildConfig.ts`）も同じ `channel`
 * を読む）で行い、不明時は閉じたままにする（開く方向の代替は置かない）。
 * 隔離実行は構造で保つ（`127.0.0.1` 束縛・実行ごとの乱数 token・
 * `Origin`／`Host` 制限・CORS 無効・終了時の閉鎖）。
 *
 * ADR: 許可操作は固定 allowlist であり、任意 JS・任意関数名・DOM 全文・
 * 実体/injector 取得口は持たない。汎用ジョブ履歴・再送基盤は作らず、
 * 相関識別子・revision の追跡に留める。比較コード取得からの自動承認は
 * せず、承認は独立操作として呼ぶ。
 *
 * 秘密（比較コード本文・業務 payload・テキスト本文）は要約・応答・
 * ログに載せない。`getPairingView` の応答要約は有無だけに落とす。
 *
 * @packageDocumentation
 */
import type { NgDevObserveResult } from "./management.ts";

/**
 * 開発接続口で呼び出せる操作の固定一覧。
 *
 * 既存管理 RPC の限定操作のうち、開発口から許可するものだけを載せる。
 * アプリ終了（`quit`）は含めない（接続口からの終了はさせない）。
 */
export const DEV_OPS = [
  "getSnapshot",
  "enableAcceptance",
  "disableAcceptance",
  "getPairingView",
  "approvePairing",
  "rejectPairing",
  "disconnectConnection",
  "assignDiagnostics",
  "assignText",
  "sendText",
  "unassignText",
  "spikeCreate",
  "spikeDestroy",
  "spikePush",
  "spikeList",
  "spikeReset",
  "retryPluginMounts",
] as const;

/** 開発接続口で呼び出せる操作名。 */
export type DevOpName = (typeof DEV_OPS)[number];

/** 包装時チャンネル（Electrobun の包装物が記録する値）。 */
export type DevBuildChannel = "dev" | "stable" | "canary";

/** 要求本文の上限（バイト）。 */
export const DEV_CONSOLE_MAX_BODY_BYTES = 64 * 1024;

/** 操作1件の期限（ミリ秒。業務実行＋段階観測の全体）。 */
export const DEV_CONSOLE_OP_TIMEOUT_MS = 10_000;

/** DOM 段階観測の待ちの上限（ミリ秒）。超過時は未確定として返す。 */
export const DEV_CONSOLE_DOM_TIMEOUT_MS = 5_000;

/** 相関識別子の上限（文字数）。 */
export const DEV_CONSOLE_MAX_CORRELATION_CHARS = 64;

/**
 * 未知の包装時チャンネル表記を判定用に落とす。
 *
 * @param value - 包装物の記録または検出処理の戻り値。
 * @returns `dev`・`stable`・`canary` のいずれか。不明は `"unknown"`。
 */
export function parseDevChannel(value: unknown): DevBuildChannel | "unknown" {
  if (value === "dev" || value === "stable" || value === "canary") {
    return value;
  }
  return "unknown";
}

/**
 * 開発接続口を開いてよいか判定する。
 *
 * 開発ビルド（`dev`）かつ明示 opt-in の場合だけ真である。`stable`・
 * `canary`・不明のいずれでも偽であり、環境変数を設定しても開かない。
 * 隔離実行（loopback 束縛・乱数 token）は起動処理が構造で保つ。
 *
 * @param channel - 包装時チャンネル（不明時は `"unknown"`）。
 * @param optIn - 明示 opt-in（`BRIDGE_GUI_DEV_CONSOLE=1`）があるか。
 * @returns 開いてよい場合に真。
 */
export function isDevConsoleEnabled(channel: DevBuildChannel | "unknown", optIn: boolean): boolean {
  return channel === "dev" && optIn;
}

/**
 * 操作名が固定 allowlist にあるか判定する。
 *
 * @param value - 検査する未知値。
 * @returns 許可操作名の場合に真。
 */
export function isDevOpName(value: unknown): value is DevOpName {
  return typeof value === "string" && (DEV_OPS as readonly string[]).includes(value);
}

/** 開発接続口の要求本文の検証結果。 */
export type ParsedDevRequest =
  | {
      /** 検証できた場合に真。 */
      readonly ok: true;
      /** 許可操作名。 */
      readonly op: DevOpName;
      /** 操作引数（对象であることだけを保証する。中身は backend が検証する）。 */
      readonly params: Record<string, unknown>;
      /** 相関識別子。省略時は `null`。 */
      readonly correlationId: string | null;
    }
  | {
      /** 検証できない場合に偽。 */
      readonly ok: false;
      /** 人間向けの短い理由（入力内容は載せない）。 */
      readonly error: string;
    };

/**
 * 開発接続口の要求本文を検証する。
 *
 * 許可外操作・非对象引数・過長な相関識別子を拒否する。引数の中身の
 * 検証は backend 側が行い、ここでは形だけを見る。
 *
 * @param bodyLengthBytes - 要求本文のバイト数。
 * @param raw - 解釈済みの要求本文（JSON 解釈の成否は呼び出し側で分ける）。
 * @returns 検証済みの要求または拒否理由。
 */
export function parseDevRequestBody(bodyLengthBytes: number, raw: unknown): ParsedDevRequest {
  if (!Number.isFinite(bodyLengthBytes) || bodyLengthBytes > DEV_CONSOLE_MAX_BODY_BYTES) {
    return { ok: false, error: "要求本文が大きすぎる。" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "要求本文は对象であること。" };
  }
  const table = raw as Record<string, unknown>;
  if (!isDevOpName(table["op"])) {
    return { ok: false, error: "許可されていない操作である。" };
  }
  const params = table["params"];
  if (
    params !== undefined &&
    (typeof params !== "object" || params === null || Array.isArray(params))
  ) {
    return { ok: false, error: "引数は对象であること。" };
  }
  const correlationId = table["correlationId"];
  if (correlationId !== undefined) {
    if (
      typeof correlationId !== "string" ||
      correlationId.length === 0 ||
      correlationId.length > DEV_CONSOLE_MAX_CORRELATION_CHARS
    ) {
      return { ok: false, error: "相関識別子が不正である。" };
    }
    return {
      ok: true,
      op: table["op"],
      params: (params ?? {}) as Record<string, unknown>,
      correlationId,
    };
  }
  return {
    ok: true,
    op: table["op"],
    params: (params ?? {}) as Record<string, unknown>,
    correlationId: null,
  };
}

/**
 * `Host` 頭が loopback の待受自身を指すか判定する。
 *
 * @param host - `Host` 頭の値。欠けている場合は `null`。
 * @returns 主部が `127.0.0.1` の場合に真。
 */
export function checkDevHost(host: string | null): boolean {
  if (host === null || host.length === 0) {
    return false;
  }
  // 主部だけを取り、利用者ポートの有無は問わない。
  const name = host.split(",")[0]?.trim().split(":")[0]?.trim().toLowerCase() ?? "";
  return name === "127.0.0.1";
}

/**
 * `Origin` 頭が許容できるか判定する。
 *
 * curl 等の非ブラウザ（頭なし・空・`null`）を通し、ブラウザ由来の
 * 頭がある場合は待受自身の起点だけを通す。ブラウザ向け CORS は開かない
 * （応答に `Access-Control-Allow-Origin` を載せない）。
 *
 * @param origin - `Origin` 頭の値。欠けている場合は `null`。
 * @param port - 待受中の開発接続口のポート番号。
 * @returns 許容できる場合に真。
 */
export function checkDevOrigin(origin: string | null, port: number): boolean {
  if (origin === null || origin === "" || origin === "null") {
    return true;
  }
  return origin === `http://127.0.0.1:${port}`;
}

/**
 * 接続元が loopback か判定する。
 *
 * @param address - 接続元アドレス。欠けている場合は `null`。
 * @returns loopback（`127.0.0.1`・`::1`・写像形）の場合に真。
 */
export function isDevLoopbackAddress(address: string | null | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// ADR: token 照合の `as` を避ける理由は、入力が外部由来の未知値であり、
// 主張より逐次比較の実行時検証を正とするためである。長さの不一致は
// 直ちに偽とし、内容は定数時間で比べる（早抜けしない）。
/**
 * 実行ごとの乱数 token を検証する。
 *
 * @param provided - 要求の `Authorization` 頭から取り出した token。欠けている場合は `null`。
 * @param expected - 実行時に発行した token。
 * @returns 一致する場合に真。
 */
export function verifyDevToken(provided: string | null, expected: string): boolean {
  if (provided === null || provided.length === 0 || expected.length === 0) {
    return false;
  }
  if (provided.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * `Authorization` 頭から `Bearer` token を取り出す。
 *
 * @param header - `Authorization` 頭の値。欠けている場合は `null`。
 * @returns token。形が違う場合は `null`。
 */
export function extractBearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return null;
  }
  const token = header.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * 業務結果の応答用要約。秘密（比較コード本文・業務 payload・テキスト本文）
 * を含まない。識別子・状態符号・件数・改訂番号だけを載せる。
 */
export type DevBusinessSummary =
  | {
      readonly kind: "snapshot";
      readonly revision: number;
      readonly accepting: boolean;
      readonly pending: number;
      readonly connections: number;
      readonly sessions: number;
    }
  | { readonly kind: "admission"; readonly accepting: boolean }
  | { readonly kind: "pairingAvailability"; readonly available: boolean }
  | { readonly kind: "pairingDecision"; readonly status: string }
  | { readonly kind: "ack" }
  | {
      readonly kind: "assignment";
      readonly localSessionId: string;
      readonly instanceId: string;
      readonly portId: string;
    }
  | { readonly kind: "textSend"; readonly status: string; readonly reason: string | null }
  | { readonly kind: "spikeCreated"; readonly mountId: string }
  | { readonly kind: "spikePushed"; readonly revision: number }
  | { readonly kind: "spikeList"; readonly count: number };

/**
 * 業務結果を応答用の要約に落とす。
 *
 * 操作ごとに許可項目だけを抜き出し、比較コード本文・業務 payload・
 * テキスト本文は捨てる。`getPairingView` は有無だけに落とす
 * （本文の取得と承認の自動化をしない）。
 *
 * @param op - 実行した許可操作名。
 * @param result - backend・所有表が返した業務結果。
 * @returns 応答用の要約。
 * @throws `RangeError` — 許可外操作の場合（到達しない想定）。
 */
export function summarizeBusinessResult(op: DevOpName, result: unknown): DevBusinessSummary {
  const table = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  switch (op) {
    case "getSnapshot": {
      const snapshot = table as {
        revision?: unknown;
        admission?: { accepting?: unknown };
        pending?: readonly unknown[];
        connections?: readonly unknown[];
        sessions?: readonly unknown[];
      };
      return {
        kind: "snapshot",
        revision: typeof snapshot.revision === "number" ? snapshot.revision : -1,
        accepting: snapshot.admission?.accepting === true,
        pending: Array.isArray(snapshot.pending) ? snapshot.pending.length : 0,
        connections: Array.isArray(snapshot.connections) ? snapshot.connections.length : 0,
        sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0,
      };
    }
    case "enableAcceptance":
    case "disableAcceptance": {
      return { kind: "admission", accepting: table["accepting"] === true };
    }
    case "getPairingView": {
      // 有無だけを返し、比較コード本文・表示形は捨てる。
      return { kind: "pairingAvailability", available: table["available"] === true };
    }
    case "approvePairing":
    case "rejectPairing": {
      return {
        kind: "pairingDecision",
        status: typeof table["status"] === "string" ? table["status"] : "UNKNOWN",
      };
    }
    case "disconnectConnection":
    case "unassignText":
    case "spikeDestroy":
    case "spikeReset":
    case "retryPluginMounts": {
      return { kind: "ack" };
    }
    case "assignDiagnostics":
    case "assignText": {
      return {
        kind: "assignment",
        localSessionId: typeof table["localSessionId"] === "string" ? table["localSessionId"] : "",
        instanceId: typeof table["instanceId"] === "string" ? table["instanceId"] : "",
        portId: typeof table["portId"] === "string" ? table["portId"] : "",
      };
    }
    case "sendText": {
      return {
        kind: "textSend",
        status: typeof table["status"] === "string" ? table["status"] : "UNKNOWN",
        reason: typeof table["reason"] === "string" ? table["reason"] : null,
      };
    }
    case "spikeCreate": {
      return {
        kind: "spikeCreated",
        mountId: typeof table["mountId"] === "string" ? table["mountId"] : "",
      };
    }
    case "spikePush": {
      return {
        kind: "spikePushed",
        revision: typeof table["revision"] === "number" ? table["revision"] : -1,
      };
    }
    case "spikeList": {
      return { kind: "spikeList", count: Array.isArray(result) ? result.length : 0 };
    }
  }
}

/**
 * native 画素観測の未対応応答。
 *
 * `Screen.captureRegion()` はデスクトップ矩形の取得であり、Webview 単体の
 * 画素観測には使えない。実装できないため「未対応」と返し、後続単位に委ねる。
 */
export const DEV_NATIVE_OBSERVATION_UNSUPPORTED = {
  supported: false as const,
  reason: "Webview 単体の画素観測は未対応である（後続単位に委ねる）。",
};

/** native 画素観測の応答（未対応の定型）。 */
export type DevNativeObservation = typeof DEV_NATIVE_OBSERVATION_UNSUPPORTED;

/**
 * 段階観測付きの操作応答。
 *
 * RPC 成功や rAF を描画完了とは呼ばない。操作受付・業務結果・snapshot 採用
 * （revision）・Angular の DOM 反映・native 画素観測を分けて返す。
 */
export interface DevStagedResponse {
  /** 受け付けた場合に真。 */
  readonly ok: true;
  /** 実行した許可操作名。 */
  readonly op: DevOpName;
  /** 要求の相関識別子。省略時は `null`。 */
  readonly correlationId: string | null;
  /** 操作受付の時刻（壁時計ミリ秒）。 */
  readonly acceptedAt: number;
  /** 業務結果の要約（秘密なし）。 */
  readonly business: DevBusinessSummary;
  /** snapshot 採用の改訂番号。 */
  readonly snapshotRevision: number;
  /** Angular の DOM 反映の観測（期限切れ時は無効応答）。 */
  readonly dom: NgDevObserveResult;
  /** native 画素観測（未対応の定型）。 */
  readonly native: DevNativeObservation;
}

/** 開発接続口の失敗応答。本文・秘密は載せない。 */
export interface DevErrorResponse {
  /** 失敗の場合は偽。 */
  readonly ok: false;
  /** 人間向けの短い理由（定型文のみ）。 */
  readonly error: string;
}
