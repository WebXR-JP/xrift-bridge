/**
 * 開発専用の AI 操作・観測口（loopback 接続口）。
 *
 * Bun main 上で完結する開発専用の待受であり、別プロセスは要らない。
 * AI→loopback 接続口→Bun main→限定 Webview RPC→共通操作サービス→
 * 既存管理 RPC→backend の経路で操作と段階観測を行う。
 *
 * ADR: 有効条件は三つ（開発ビルドかつ明示 opt-in かつ隔離実行）である。
 * 開発ビルドの判定は包装時チャンネルで行う。devkit の `BuildConfig`
 * （`api/sdks/main/core/BuildConfig.ts`）は `Resources/version.json` の
 * `channel` を読み、`dev` で非包装・`stable`／`canary` で包装とする。
 * 実測した包装物の記録は、dev 包装の `Resources/version.json` が
 * `"channel":"dev"`、stable 包装の `Resources/metadata.json` が
 * `"channel":"stable"` である（`apps/bridge-gui-main/build/` で確認）。
 * devkit の読取り失敗時の代替（dev 扱い）は開く方向の代替になるため、
 * ここでは採用しない。不明時は閉じたままにする。
 * 隔離実行は構造で保つ（`127.0.0.1` 束縛・実行ごとの乱数 token・
 * `Origin`／`Host` 制限・CORS 無効・終了時の閉鎖）。
 *
 * ADR: 操作の実行は `GuiBackend`・段0所有表・実プラグイン対応付けの
 * 既存操作に委譲し、接続口側に業務 logic を複写しない。応答の要約は
 * 契約（`bridge-gui-contract/dev-console`）の純粋関数で行い、比較コード
 * 本文・業務 payload・テキスト本文を落とす。RPC 成功や rAF を描画完了
 * とは呼ばず、Webview の段階観測（`ngDevObserve`）の到達を DOM 反映の
 * 観測とする。native 画素観測は未対応の定型で返し、後続単位に委ねる
 * （`Screen.captureRegion()` はデスクトップ矩形であり、Webview 単体の
 * 取得ではない）。
 *
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import {
  checkDevHost,
  checkDevOrigin,
  DEV_CONSOLE_DOM_TIMEOUT_MS,
  DEV_CONSOLE_MAX_BODY_BYTES,
  DEV_CONSOLE_OP_TIMEOUT_MS,
  DEV_NATIVE_OBSERVATION_UNSUPPORTED,
  extractBearerToken,
  isDevConsoleEnabled,
  isDevLoopbackAddress,
  isDevOpName,
  parseDevChannel,
  parseDevRequestBody,
  summarizeBusinessResult,
  verifyDevToken,
  type DevBusinessSummary,
  type DevOpName,
} from "bridge-gui-contract/dev-console";
import type { ManagementSnapshot, NgDevObserveResult } from "bridge-gui-contract/management";
import type { GuiBackend } from "./backend.ts";
import type { PluginUiOperations, SpikeMountOperations } from "./rpc.ts";

/** 開発接続口の明示 opt-in の環境変数。 */
export const DEV_CONSOLE_OPT_IN_ENV = "BRIDGE_GUI_DEV_CONSOLE";

/** 開発接続口の束縛先。loopback のみであり、外部には開かない。 */
export const DEV_CONSOLE_HOST = "127.0.0.1";

/**
 * 包装時チャンネルを検出する。
 *
 * devkit の `BuildConfig.getSync()` の読取り失敗時の代替（dev 扱い）は
 * 開く方向に倒れるため、ここでは包装物の記録を直接読む。dev 包装の
 * `Resources/version.json`・stable 包装の `Resources/metadata.json` の
 * `channel` を見て、最初に読めた値を採る。読めなければ不明とする。
 *
 * @returns 包装時チャンネル。読めない場合は `"unknown"`。
 */
export function detectDevChannel(): "dev" | "stable" | "canary" | "unknown" {
  const candidates = ["../Resources/version.json", "../Resources/metadata.json"];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { channel?: unknown };
      const channel = parseDevChannel(parsed.channel);
      if (channel !== "unknown") {
        return channel;
      }
    } catch {
      // 読めない配置は次の候補へ回す（検出自体は止めない）。
    }
  }
  return "unknown";
}

/**
 * 開発接続口の起動可否を環境から判定する。
 *
 * @returns 開いてよい場合に真。stable は opt-in があっても偽である。
 */
export function shouldStartDevConsole(): boolean {
  return isDevConsoleEnabled(detectDevChannel(), process.env[DEV_CONSOLE_OPT_IN_ENV] === "1");
}

/** DOM 段階観測の Webview 呼び出し口。 */
export interface DevConsoleObserver {
  /**
   * 操作実行後の DOM 反映を観測する。
   *
   * @param revision - 操作実行後の snapshot 改訂番号（相関用）。
   * @returns 段階観測の応答。期限切れ時は無効応答に落とすこと。
   */
  readonly observeDom: (revision: number) => Promise<NgDevObserveResult>;
}

/** 開発接続口の起動設定。 */
export interface DevConsoleOptions {
  /** 待ち受けポート。省略時は空きポートを自動選択する。 */
  readonly port?: number;
}

/** 開発接続口の待受。終了時は必ず閉じる。 */
export interface DevConsole {
  /** 待ち受け中のポート番号。 */
  readonly port: number;
  /** 実行時に発行した token。本文・生成物には残さない。 */
  readonly token: string;
  /** 待受を閉じる。冪等である。 */
  readonly close: () => Promise<void>;
}

/**
 * DOM 段階観測の無効応答（期限切れ・到達不能時）。
 *
 * 観測不能時は採用したことにならないため、採用改訂番号は載せない
 * （`adoptedRevision: null`。`available:false` と整合させる）。
 *
 * @returns 無効の段階観測応答。
 */
export function unavailableDomObservation(): NgDevObserveResult {
  return {
    available: false,
    reason: "段階観測が期限切れまたは到達不能である。",
    adoptedRevision: null,
    focus: false,
    activeKey: null,
    elements: [],
    hasNg: false,
    componentMounted: false,
    resolvedComponent: false,
  };
}

/** 操作全体の期限切れの定型理由。本文・秘密は載せない。 */
export const DEV_OP_TIMEOUT_ERROR = "操作の期限が切れた。";

/** 要求処理の選択肢（試験用の期限上書きに限る）。 */
export interface DevRequestOptions {
  /** 操作全体の期限（ミリ秒）。省略時は契約の既定値を使う。 */
  readonly timeoutMs?: number;
}

/**
 * 操作全体に期限を付ける。期限超過時は期限切れの失敗応答に落とす。
 *
 * DOM 観測待ちの上限（5秒）はこの全体期限の中で動く。時計の注入口として
 * 期限とタイマー操作を受け、試験では実時間待ちなしに両側の分岐を固定できる。
 *
 * @param work - 業務実行＋段階観測の全体処理の応答。
 * @param timeoutMs - 操作全体の期限（ミリ秒）。省略時は契約の既定値。
 * @param schedule - タイマー登録口。省略時は実行系の `setTimeout`。
 * @param unschedule - タイマー解除口。省略時は実行系の `clearTimeout`。
 * @returns 期限内なら本来の応答、期限超過なら `504` の定型応答。
 */
export function raceDevOpWithTimeout(
  work: Promise<Response>,
  timeoutMs: number = DEV_CONSOLE_OP_TIMEOUT_MS,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
  unschedule: (timer: unknown) => void = (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
): Promise<Response> {
  let timer: unknown;
  const timeout = new Promise<Response>((resolve) => {
    timer = schedule(() => {
      resolve(Response.json({ ok: false, error: DEV_OP_TIMEOUT_ERROR }, { status: 504 }));
    }, timeoutMs);
    // ADR: `as` で `unref` の有無を主張する理由は、実行系でタイマー型が
    // 異なるためである。待機の維持には使わず、単独滞留での固着を避ける
    // ために外せる場合だけ外す。無い環境では何もしない。
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      // 解除の失敗は期限監視を止めない。
    }
  });
  return Promise.race([work, timeout]).finally(() => {
    try {
      unschedule(timer);
    } catch {
      // 解除の失敗は応答を変えない。
    }
  });
}

/**
 * 業務操作を実行する。既存操作への委譲であり、業務 logic を複写しない。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param spike - 段0スパイクのマウント操作口。
 * @param pluginUi - 実プラグイン子画面の配置操作口。
 * @param op - 許可操作名。
 * @param params - 操作引数（中身の検証は各操作側が行う）。
 * @returns 業務結果（要約前の生の応答）。
 * @throws `RangeError` — 引数・状態の不備の場合（400 に写す）。
 * @throws `Error` — 終了中・起動失敗の場合（500 に写す）。
 */
export async function runDevOperation(
  backend: GuiBackend,
  spike: SpikeMountOperations,
  pluginUi: PluginUiOperations,
  op: DevOpName,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (op) {
    case "getSnapshot":
      return backend.getSnapshot();
    case "enableAcceptance":
      return backend.enableAcceptance();
    case "disableAcceptance":
      return backend.disableAcceptance();
    case "getPairingView":
      return backend.getPairingView({ requestId: params["requestId"] });
    case "approvePairing":
      return backend.approvePairing({ requestId: params["requestId"], code: params["code"] });
    case "rejectPairing":
      return backend.rejectPairing({ requestId: params["requestId"] });
    case "disconnectConnection":
      return backend.disconnectConnection({ connectionId: params["connectionId"] });
    case "assignDiagnostics":
      return backend.assignDiagnostics({ localSessionId: params["localSessionId"] });
    case "assignText":
      return backend.assignText();
    case "sendText":
      return backend.sendText({
        localSessionId: params["localSessionId"],
        instanceId: params["instanceId"],
        text: params["text"],
      });
    case "unassignText":
      return backend.unassignText();
    case "spikeCreate":
      return spike.createSpikeMount();
    case "spikeDestroy":
      return spike.destroySpikeMount(params["mountId"]);
    case "spikePush":
      return spike.pushSpikeMount(params["mountId"]);
    case "spikeList":
      return spike.listSpikeMounts();
    case "spikeReset":
      return spike.resetSpikeMounts();
    case "retryPluginMounts":
      return pluginUi.retryPluginUiMounts();
  }
}

/**
 * 開発接続口を開始する。呼び出し前に有効条件の判定を済ませること。
 *
 * `127.0.0.1` のみ束縛し、実行ごとの乱数 token を発行する。終了処理で
 * 必ず閉じる（`close` を `GuiBackend.close()` と同じ終了経路に結線する）。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param spike - 段0スパイクのマウント操作口。
 * @param pluginUi - 実プラグイン子画面の配置操作口。
 * @param observer - DOM 段階観測の Webview 呼び出し口。
 * @param options - 待ち受けポートの設定。
 * @returns 待受（ポート・token・閉鎖口）。
 */
export function startDevConsole(
  backend: GuiBackend,
  spike: SpikeMountOperations,
  pluginUi: PluginUiOperations,
  observer: DevConsoleObserver,
  options: DevConsoleOptions = {},
): DevConsole {
  // 実行ごとの乱数 token。比較コード本文と同様に記録・生成物に残さない。
  const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  let closed = false;
  // ADR: 待受自身の参照は閉包で遅延して渡す。生成式の評価時点では未確定で
  // あるが、要求到達時には確定している（到達は生成より後である）。
  // Bun の待受は `DevUpstream` の構造に適合するため、そのまま渡す。
  const server = Bun.serve({
    hostname: DEV_CONSOLE_HOST,
    port: options.port ?? 0,
    fetch: (request, upstream): Promise<Response> => {
      // ADR: `as` で要求実体の包含を主張する理由は、実行時の要求が同一の
      // fetch `Request` 実体であり、読む項目（URL・方式・頭・本文）の存在が
      // fetch 仕様で保証されるためである。`requestIP` の戻りも住所項目の
      // 存在だけを使う。
      const adapter: DevUpstream = {
        port: upstream.port ?? 0,
        requestIP: (candidate) =>
          upstream.requestIP(candidate as unknown as Request) as unknown as {
            address: string;
          } | null,
      };
      return handleDevConsoleRequest(request, adapter, {
        backend,
        spike,
        pluginUi,
        observer,
        token,
      });
    },
  });
  // 束縛直後の実ポート。自動選択時はここで確定する。
  const boundPort = server.port ?? options.port ?? 0;
  return {
    port: boundPort,
    token,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await server.stop();
    },
  };
}

/** 要求処理に要る実行時の結線。 */
export interface DevRequestContext {
  readonly backend: GuiBackend;
  readonly spike: SpikeMountOperations;
  readonly pluginUi: PluginUiOperations;
  readonly observer: DevConsoleObserver;
  readonly token: string;
}

/**
 * 開発接続口が読む要求の最小形。fetch の `Request` が適合する。
 *
 * 試験では素朴な代役で `Host`・`Origin` の不正値を載せられる
 * （fetch の `Request` 生成では禁則頭になるため）。
 */
export interface DevHttpRequest {
  /** 要求 URL。 */
  readonly url: string;
  /** 要求方式。 */
  readonly method: string;
  /** 要求頭。 */
  readonly headers: { get: (name: string) => string | null };
  /** 本文の読取り。 */
  text(): Promise<string>;
}

/**
 * 開発接続口の上流（待受）の最小形。Bun の待受が適合する。
 */
export interface DevUpstream {
  /** 待ち受け中のポート番号（`Origin` 照合用）。 */
  readonly port: number;
  /** 接続元アドレスの取得。 */
  requestIP(request: DevHttpRequest): { address: string } | null;
}

/**
 * 開発接続口の要求を1件処理する。
 *
 * 順序は token 検証→`Host`→接続元→`Origin`→経路・方式→本文上限・
 * 検証→業務実行→段階観測である。失敗応答に本文・秘密・例外内容は
 * 載せず、定型文だけを返す。ブラウザ向け CORS 頭は載せない。
 * 業務実行＋段階観測の全体には操作1件の期限を付け、超過時は `504` の
 * 定型応答に落とす（DOM 観測待ちの上限はこの中で動く）。
 *
 * @param request - 受信した要求。
 * @param upstream - 接続元照合に使う待受。
 * @param context - 実行時の結線。
 * @param options - 期限上書き（試験用）。省略時は契約の既定値。
 * @returns 段階観測付きの応答または失敗応答。
 */
export async function handleDevConsoleRequest(
  request: DevHttpRequest,
  upstream: DevUpstream,
  context: DevRequestContext,
  options: DevRequestOptions = {},
): Promise<Response> {
  const unauthorized = (error: string): Response =>
    Response.json({ ok: false, error }, { status: 401 });
  // token の有無・一致を先に確かめる（以降の詳細判別を漏らさない）。
  if (!verifyDevToken(extractBearerToken(request.headers.get("authorization")), context.token)) {
    return unauthorized("認証に失敗した。");
  }
  if (!checkDevHost(request.headers.get("host"))) {
    return Response.json({ ok: false, error: "許可されていない Host である。" }, { status: 403 });
  }
  let remote: string | null = null;
  try {
    remote = upstream.requestIP(request)?.address ?? null;
  } catch {
    remote = null;
  }
  if (!isDevLoopbackAddress(remote)) {
    return Response.json({ ok: false, error: "loopback 以外からの要求である。" }, { status: 403 });
  }
  if (!checkDevOrigin(request.headers.get("origin"), upstream.port)) {
    return Response.json({ ok: false, error: "許可されていない Origin である。" }, { status: 403 });
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/dev/status") {
    return Response.json({
      ok: true,
      channel: "dev",
      revision: context.backend.getSnapshot().revision,
    });
  }
  if (request.method !== "POST" || url.pathname !== "/dev/op") {
    return Response.json({ ok: false, error: "存在しない経路である。" }, { status: 404 });
  }
  let bodyText = "";
  try {
    bodyText = await request.text();
  } catch {
    return Response.json({ ok: false, error: "要求本文を読めない。" }, { status: 400 });
  }
  const bodyBytes = new TextEncoder().encode(bodyText).length;
  if (bodyBytes > DEV_CONSOLE_MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "要求本文が大きすぎる。" }, { status: 413 });
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch {
    return Response.json({ ok: false, error: "要求本文は JSON であること。" }, { status: 400 });
  }
  const parsed = parseDevRequestBody(bodyBytes, raw);
  if (!parsed.ok) {
    const status = parsed.error === "許可されていない操作である。" ? 404 : 400;
    return Response.json({ ok: false, error: parsed.error }, { status });
  }
  if (!isDevOpName(parsed.op)) {
    return Response.json({ ok: false, error: "許可されていない操作である。" }, { status: 404 });
  }
  const op: DevOpName = parsed.op;
  const acceptedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEV_CONSOLE_OP_TIMEOUT_MS;
  // 操作全体（業務実行＋段階観測）に期限を付け、超過時は定型応答に落とす。
  const work = (async (): Promise<Response> => {
    let business: DevBusinessSummary;
    try {
      const result = await runDevOperation(
        context.backend,
        context.spike,
        context.pluginUi,
        op,
        parsed.params,
      );
      business = summarizeBusinessResult(op, result);
    } catch (error: unknown) {
      // 引数・状態の不備は 400、終了中・起動失敗は 500 に写す。
      // 例外内容（本文の混入があり得る）は載せない。
      if (error instanceof RangeError) {
        return Response.json({ ok: false, error: "要求が不正である。" }, { status: 400 });
      }
      return Response.json({ ok: false, error: "操作に失敗した。" }, { status: 500 });
    }
    // snapshot 採用（revision）の確定。読み取りは revision を進めないが、
    // 保留中の通知は先に確定するため、業務直後の最新を読む。
    let snapshot: ManagementSnapshot;
    try {
      snapshot = context.backend.getSnapshot();
    } catch {
      return Response.json({ ok: false, error: "状態を読めない。" }, { status: 500 });
    }
    // Angular の DOM 反映の観測。期限切れ・到達不能は無効応答に落とし、
    // RPC 成功を描画完了とは呼ばない。
    let dom: NgDevObserveResult = unavailableDomObservation();
    try {
      dom = await Promise.race([
        context.observer.observeDom(snapshot.revision),
        new Promise<NgDevObserveResult>((resolve) => {
          const timer = setTimeout(
            () => resolve(unavailableDomObservation()),
            DEV_CONSOLE_DOM_TIMEOUT_MS,
          );
          // ADR: `as` で `unref` の有無を主張する理由は、実行系でタイマー型が
          // 異なるためである。待機の維持には使わず、単独滞留での固着を避ける
          // ために外せる場合だけ外す。無い環境では何もしない。
          try {
            (timer as unknown as { unref?: () => void }).unref?.();
          } catch {
            // 解除の失敗は観測を止めない。
          }
        }),
      ]);
    } catch {
      dom = unavailableDomObservation();
    }
    return Response.json({
      ok: true,
      op,
      correlationId: parsed.correlationId,
      acceptedAt,
      business,
      snapshotRevision: snapshot.revision,
      dom,
      native: DEV_NATIVE_OBSERVATION_UNSUPPORTED,
    });
  })();
  return raceDevOpWithTimeout(work, timeoutMs);
}
