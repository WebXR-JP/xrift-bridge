/**
 * UDP 受信転送プラグイン（ローカル UDP データグラム→ワールドの片方向転送）。
 *
 * 接続口は一つで、`reliable`・`bidirectional` のみ受け付ける。
 * 受信ソケットの bind 開始・停止、受信一件ごとの base64 転送、統計を担う。
 * 逆方向の送信はしない。
 *
 * `attach` では bind しない。bind は子画面操作の `start` でのみ行う。
 * 転送は送信同時一件・待機域なしであり、送信未完了中の新着は符号化せず
 * 破棄して数える。送信失敗は数えるだけで再送しない。復号後上限
 * （48,000 バイト）を超える受信は破棄して数え、セッションは切断しない。
 *
 * 世代番号で古いソケットの遅延配送を無視する。失効・セッション終了・
 * `dispose()` では転送を即時禁止し、ソケット閉塞を開始する。
 * `dispose()` は既存契約どおり同期であり、OS 上の閉塞完了まで同期保証しない。
 * `stop()` と再 bind は閉塞完了を待つ。
 *
 * @packageDocumentation
 */
import {
  UDP_DATAGRAM_OP,
  UDP_MAX_DATAGRAM_BYTES,
  encodeUdpData,
  isIPv4LiteralAddress,
  isIPv6LiteralAddress,
  isLoopbackAddress,
  isUdpSource,
  type UdpDatagramMessage,
} from "./contract.ts";
import { createNodeUdpSocket } from "./node-udp-socket.ts";
import type { UdpReceiverSocket, UdpSocketAddress, UdpSocketFactory } from "./udp-socket.ts";
import type {
  AssignedSession,
  PluginDefinition,
  PluginInstance,
  Unsubscribe,
} from "bridge-app-core/core";

/** UDP プラグインの識別子。 */
export const UDP_PLUGIN_ID = "udp";

/** UDP プラグインの接続口識別子。 */
export const UDP_PORT_ID = "udp";

/** UDP ソケットの待受け先。子画面・GUI へ公開する表示用の型である。 */
export type { UdpSocketAddress };

/**
 * UDP インスタンスの段階。
 *
 * - `unassigned`: 割当て待ち。`start` は転送先が無いため取り消す。
 * - `stopped`: 割当て済み・待受けなし。`start` を受け付ける。
 * - `starting`: bind 手続き中。新規 `start` は拒否し、`stop` は取消優先である。
 * - `running`: 待受け中。`start` は再 bind（旧閉塞完了→新 bind）である。
 * - `stopping`: 閉塞手続き中。新規 `start` は拒否する。
 * - `error`: 直近の bind 失敗。`stop` で `stopped` に戻せる。
 * - `disposed`: 破棄済み。以後の操作は受け付けない。
 */
export type UdpPhase =
  | "unassigned"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error"
  | "disposed";

/**
 * UDP の bind 設定（子画面の入力）。
 *
 * 自動開始・永続化はしない。実行時の `start` ごとに渡す。
 */
export interface UdpBindConfig {
  /** 待受けアドレスの数値リテラル（IPv4/IPv6）。ホスト名・空は不可。 */
  readonly address: string;
  /** 待受けポート番号。1..65535 の整数である。 */
  readonly port: number;
}

/**
 * UDP の開始引数。
 */
export interface UdpStartParams {
  /** bind 設定。 */
  readonly bind: UdpBindConfig;
  /** 非 loopback への bind を許すか。非 loopback には `true` が要る。 */
  readonly allowNonLoopback: boolean;
}

/** UDP の開始・停止の失敗理由。 */
export type UdpControlFailureReason =
  | "invalid-config"
  | "confirmation-required"
  | "busy"
  | "bind-failed"
  | "cancelled";

/**
 * UDP の開始・停止の結果。
 *
 * 成功は `{ ok: true }`、失敗は理由付きの `{ ok: false, ... }` であり、
 * `Promise` の拒否では表さない（操作失敗と実装異常を区別するため）。
 */
export type UdpControlResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: UdpControlFailureReason;
      readonly message: string;
    };

/**
 * UDP 転送の統計（インスタンス単位）。
 *
 * 受信・転送完了の件数とバイト（受信バイト列基準）、破棄の内訳、
 * 送信失敗の件数であり、輸送統計には混ぜない。payload 本文は残さない。
 */
export interface UdpStats {
  /** ソケットが届けた受信件数（破棄分を含む）。 */
  readonly receivedDatagrams: number;
  /** 受信バイト列の合計（バイト。破棄分を含む）。 */
  readonly receivedBytes: number;
  /** `sendReliable` が完了した転送件数。 */
  readonly forwardedDatagrams: number;
  /** 転送完了した受信バイト列の合計（バイト）。 */
  readonly forwardedBytes: number;
  /** 上限超過による破棄件数。 */
  readonly droppedOversize: number;
  /** 送信未完了中の新着による破棄件数。 */
  readonly droppedBusy: number;
  /** 不正な送信元表記による破棄件数。 */
  readonly droppedInvalidMetadata: number;
  /** 転送先の不在・送信処理の失敗件数。再送しない。 */
  readonly sendFailures: number;
}

/**
 * UDP プラグインの UI 非依存の状態。
 *
 * 段階・要求した bind・実際の bind 先・統計・直近異常・開始可否を提供する。
 * payload 本文は含まない。`revision` は本体が所有する単調増加の改訂番号で
 * あり、状態変更で進め読み取りでは進めない。GUI アダプターは引き継ぐだけ
 * であり、子は新しい状態のみ採用する。
 */
export interface UdpPluginState {
  /** 本体が所有する単調増加の改訂番号。生成直後は 0 であり、状態変更で進む。 */
  readonly revision: number;
  /** 現在の段階。 */
  readonly phase: UdpPhase;
  /** 直近に要求した bind 設定。未開始なら `null`。 */
  readonly requestedBind: UdpBindConfig | null;
  /** 実際の待受け先。待受け中でなければ `null`。 */
  readonly boundAddress: UdpSocketAddress | null;
  /** インスタンス単位の統計。 */
  readonly stats: UdpStats;
  /** 直近の異常終了・失敗の説明。成功した `start` で消える。 */
  readonly lastError: string | null;
  /** `start()` を受け付ける状態なら真。 */
  readonly canStart: boolean;
  /** 待受け中なら真。 */
  readonly isRunning: boolean;
}

/**
 * UDP プラグイン固有の操作口。
 *
 * 汎用の任意 payload 送信口は作らず、開始・停止と状態購読だけを提供する。
 * backend はこの口で状態を子画面へ結線できる。
 */
export interface UdpPluginOperations {
  /**
   * UDP 受信を開始する。稼働中は再 bind（旧閉塞完了→新 bind）である。
   *
   * @param params - bind 設定と非 loopback 確認。
   * @returns 成功または理由付きの失敗。`Promise` の拒否では表さない。
   */
  start(params: UdpStartParams): Promise<UdpControlResult>;
  /**
   * UDP 受信を停止する。開始途中でも取消優先で閉塞する。
   *
   * @returns 成功または理由付きの失敗。`Promise` の拒否では表さない。
   */
  stop(): Promise<UdpControlResult>;
  /**
   * 状態変化を購読する。
   *
   * @param handler - 最新の状態を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 破棄済みの場合。
   */
  onStateChanged(handler: (state: UdpPluginState) => void): Unsubscribe;
}

/**
 * UDP プラグイン生成時の設定。
 */
export interface UdpPluginOptions {
  /**
   * 受信ソケットの生成口。
   *
   * テスト注入専用であり、利用者の bind 設定とは分ける。
   *
   * @defaultValue `createNodeUdpSocket`（省略時に生成処理が適用）。
   */
  readonly socketFactory?: UdpSocketFactory;
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
 * bind 設定の検証結果。
 */
type BindValidation =
  | { readonly ok: true; readonly config: UdpBindConfig }
  | { readonly ok: false; readonly message: string };

/**
 * bind 設定を検証する。
 *
 * アドレスは数値の IPv4/IPv6 リテラルのみを受け付け、ホスト名・空・
 * 暗黙の全 interface を拒否する。ポートは 1..65535 の整数である。
 *
 * @param bind - 検証する未知値。
 * @returns 検証結果。成功時は正規化した設定を返す。
 */
function validateBindConfig(bind: unknown): BindValidation {
  if (!isRecord(bind)) {
    return { ok: false, message: "bind は {address, port} の組みであること。" };
  }
  const address = bind["address"];
  if (typeof address !== "string" || address.length === 0) {
    return { ok: false, message: "bind.address は空でない文字列であること。" };
  }
  if (!isIPv4LiteralAddress(address) && !isIPv6LiteralAddress(address)) {
    return {
      ok: false,
      message:
        "bind.address は数値の IPv4/IPv6 リテラルであること（ホスト名・空・暗黙の全 interface は不可）。",
    };
  }
  const port = bind["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: "bind.port は 1..65535 の整数であること。" };
  }
  return { ok: true, config: { address, port } };
}

/**
 * 開始引数の検証結果。
 */
type StartValidation =
  | { readonly ok: true; readonly params: UdpStartParams }
  | {
      readonly ok: false;
      readonly reason: "invalid-config" | "confirmation-required";
      readonly message: string;
    };

/**
 * 開始引数を検証する。
 *
 * bind 設定の検証に加え、非 loopback への bind には
 * `allowNonLoopback: true` を必須にする（本体側の検証）。
 *
 * @param params - 検証する未知値。
 * @returns 検証結果。成功時は正規化した引数を返す。
 */
function validateStartParams(params: unknown): StartValidation {
  if (!isRecord(params)) {
    return {
      ok: false,
      reason: "invalid-config",
      message: "start の引数は {bind, allowNonLoopback} の組みであること。",
    };
  }
  const bindResult = validateBindConfig(params["bind"]);
  if (!bindResult.ok) {
    return { ok: false, reason: "invalid-config", message: bindResult.message };
  }
  const allowNonLoopback = params["allowNonLoopback"];
  if (typeof allowNonLoopback !== "boolean") {
    return {
      ok: false,
      reason: "invalid-config",
      message: "allowNonLoopback は真偽値であること。",
    };
  }
  if (!allowNonLoopback && !isLoopbackAddress(bindResult.config.address)) {
    return {
      ok: false,
      reason: "confirmation-required",
      message:
        "非 loopback への bind には allowNonLoopback:true が要る（子画面で確認して再試行すること）。",
    };
  }
  return { ok: true, params: { bind: bindResult.config, allowNonLoopback } };
}

/** UDP インスタンス（単一の reliable 接続口を受ける）。 */
class UdpInstance implements PluginInstance<UdpPluginState, UdpPluginOperations> {
  private session: Extract<AssignedSession, { kind: "reliable" }> | null = null;
  private sessionUnsubs: Unsubscribe[] = [];
  private forwardingAllowed = false;
  private socket: UdpReceiverSocket | null = null;
  private socketUnsubs: (() => void)[] = [];
  private closePromise: Promise<void> | null = null;
  private generation = 0;
  private revision = 0;
  private phase: UdpPhase = "unassigned";
  private requestedBind: UdpBindConfig | null = null;
  private boundAddress: UdpSocketAddress | null = null;
  private lastError: string | null = null;
  private receivedDatagrams = 0;
  private receivedBytes = 0;
  private forwardedDatagrams = 0;
  private forwardedBytes = 0;
  private droppedOversize = 0;
  private droppedBusy = 0;
  private droppedInvalidMetadata = 0;
  private sendFailures = 0;
  private sendInFlight = false;
  private cancelStartRequested = false;
  private readonly stateListeners = new Set<(state: UdpPluginState) => void>();
  private disposed = false;

  /**
   * @param socketFactory - 受信ソケットの生成口。テスト注入専用である。
   */
  constructor(private readonly socketFactory: UdpSocketFactory) {}

  /** {@inheritDoc PluginInstance.attach} */
  attach(portId: string, session: AssignedSession): void {
    if (this.disposed) throw new RangeError("破棄済みのインスタンスである。");
    if (portId !== UDP_PORT_ID) throw new RangeError(`不明な接続口である: ${portId}`);
    if (session.kind !== "reliable" || session.direction !== "bidirectional") {
      throw new RangeError("UDP の接続口に合わない操作口である。");
    }
    // ADR: 付け替え時は転送先だけを差し替え、待受けソケットは維持する。
    // 受信の bind 状態と転送先の割当ては独立であり、付け替えで受信を
    // 止めない。転送禁止は明示の失効・終了・破棄でのみ行う。
    this.detachSession();
    this.session = session;
    this.forwardingAllowed = true;
    this.subscribeSession(session);
    if (this.phase === "unassigned") {
      this.phase = "stopped";
    }
    this.markChanged();
  }

  /** {@inheritDoc PluginInstance.getState} */
  getState(): UdpPluginState {
    return {
      revision: this.revision,
      phase: this.phase,
      requestedBind: this.requestedBind === null ? null : { ...this.requestedBind },
      boundAddress: this.boundAddress === null ? null : { ...this.boundAddress },
      stats: {
        receivedDatagrams: this.receivedDatagrams,
        receivedBytes: this.receivedBytes,
        forwardedDatagrams: this.forwardedDatagrams,
        forwardedBytes: this.forwardedBytes,
        droppedOversize: this.droppedOversize,
        droppedBusy: this.droppedBusy,
        droppedInvalidMetadata: this.droppedInvalidMetadata,
        sendFailures: this.sendFailures,
      },
      lastError: this.lastError,
      canStart: this.canStartNow(),
      isRunning: this.phase === "running",
    };
  }

  /** {@inheritDoc PluginInstance.getOperations} */
  getOperations(): UdpPluginOperations {
    return {
      start: (params) => this.start(params),
      stop: () => this.stop(),
      onStateChanged: (handler) => this.addStateListener(handler),
    };
  }

  /** {@inheritDoc PluginInstance.dispose} */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // ADR: `dispose()` は同期であり、OS 上の閉塞完了まで同期保証しない。
    // 転送禁止と購読破棄は同期で行い、閉塞の完了待ちは `stop()`・再 bind に委ねる。
    this.forwardingAllowed = false;
    this.cancelStartRequested = true;
    this.detachSession();
    this.session = null;
    // 待受け中でなければ `boundAddress` は `null` の不変条件を保つ。
    this.boundAddress = null;
    this.stateListeners.clear();
    if (this.socket !== null || this.closePromise !== null) {
      void this.beginClose();
    }
    this.revision += 1;
    this.phase = "disposed";
  }

  /**
   * `start()` を受け付ける状態か判定する。
   *
   * @returns 破棄・開始・停止の手続き中でなく、転送先が生存していれば真。
   */
  private canStartNow(): boolean {
    if (this.disposed) return false;
    if (this.phase !== "stopped" && this.phase !== "error" && this.phase !== "running") {
      return false;
    }
    return this.hasLiveSession();
  }

  /**
   * 転送先の生存セッションがあるか判定する。
   *
   * @returns 転送が許可され、操作口が生存していれば真。
   */
  private hasLiveSession(): boolean {
    const session = this.session;
    return this.forwardingAllowed && session !== null && session.isAlive;
  }

  /**
   * UDP 受信を開始する。
   *
   * 判定順序は固定する：破棄→手続き中→設定検証→転送先の生存。
   * 稼働中は設定検証の後に旧ソケットの閉塞完了を待って新 bind する
   * （旧→新の順序厳守）。新 bind の失敗は `error` とし、自動 rollback・
   * 自動再試行はしない。
   *
   * @param params - bind 設定と非 loopback 確認。
   * @returns 成功または理由付きの失敗。
   */
  private async start(params: UdpStartParams): Promise<UdpControlResult> {
    if (this.disposed) {
      return { ok: false, reason: "cancelled", message: "破棄済みのため開始しない。" };
    }
    if (this.phase === "starting" || this.phase === "stopping") {
      return {
        ok: false,
        reason: "busy",
        message: "操作中のため開始しない。終わってから再試行すること。",
      };
    }
    const validated = validateStartParams(params);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, message: validated.message };
    }
    if (!this.hasLiveSession()) {
      return {
        ok: false,
        reason: "cancelled",
        message: "割当て中の生存セッションが無いため開始しない。",
      };
    }
    const wanted = validated.params.bind;
    this.phase = "starting";
    this.requestedBind = { ...wanted };
    this.cancelStartRequested = false;
    this.markChanged();
    // ADR: 旧→新の順序を厳守する。factory の呼出し（新ソケットの生成）は
    // 旧ソケットの閉塞完了の後に行い、新旧の待受けを混在させない。
    if (this.socket !== null || this.closePromise !== null) {
      await this.beginClose();
      if (this.disposed) {
        return { ok: false, reason: "cancelled", message: "破棄されたため開始を取り消した。" };
      }
      if (this.cancelStartRequested) {
        this.phase = "stopped";
        this.markChanged();
        return { ok: false, reason: "cancelled", message: "停止・失効のため開始を取り消した。" };
      }
    }
    let created: UdpReceiverSocket;
    try {
      // ADR: IPv6 の待受けは `ipv6Only` で IPv6 のみに限る。dual-stack の
      // 暗黙の IPv4 混入を避け、待受け範囲を明示するためである。
      const useIPv6 = wanted.address.includes(":");
      created = this.socketFactory({ type: useIPv6 ? "udp6" : "udp4", ipv6Only: true });
    } catch (error: unknown) {
      return this.failBind(`ソケットの生成に失敗した: ${describeFailure(error)}`);
    }
    const generation = this.generation;
    this.socket = created;
    this.socketUnsubs.push(
      created.onMessage((data, rinfo) => {
        this.handleDatagram(generation, data, rinfo);
      }),
      created.onError((error) => {
        this.handleSocketError(generation, error);
      }),
    );
    let bound: UdpSocketAddress;
    try {
      bound = await created.bind(wanted.address, wanted.port);
    } catch (error: unknown) {
      this.detachSocket(created);
      await this.beginCloseDetached(created);
      if (this.disposed) {
        return { ok: false, reason: "cancelled", message: "破棄されたため開始を取り消した。" };
      }
      if (this.cancelStartRequested || generation !== this.generation) {
        this.phase = "stopped";
        this.markChanged();
        return { ok: false, reason: "cancelled", message: "停止・失効のため開始を取り消した。" };
      }
      return this.failBind(`bind に失敗した: ${describeFailure(error)}`);
    }
    if (this.disposed) {
      this.detachSocket(created);
      await this.beginCloseDetached(created);
      return { ok: false, reason: "cancelled", message: "破棄されたため開始を取り消した。" };
    }
    if (this.cancelStartRequested || generation !== this.generation) {
      // ADR: 開始途中の取消（`stop()`・失効・終了）を優先する。bind 済みの
      // 新ソケットはここで閉じ、待受けの残存を作らない。進行中の `stop()` が
      // あっても `stopped` への収束は変わらないため、無条件に落とす。
      this.detachSocket(created);
      await this.beginCloseDetached(created);
      this.phase = "stopped";
      this.markChanged();
      return { ok: false, reason: "cancelled", message: "停止・失効のため開始を取り消した。" };
    }
    this.boundAddress = { ...bound };
    this.lastError = null;
    this.phase = "running";
    this.markChanged();
    return { ok: true };
  }

  /**
   * UDP 受信を停止する。
   *
   * 開始途中でも取消優先で閉塞する。待受けが無ければ成功とする（冪等）。
   *
   * @returns 成功または理由付きの失敗。
   */
  private async stop(): Promise<UdpControlResult> {
    if (this.disposed) {
      return { ok: false, reason: "cancelled", message: "破棄済みのため停止しない。" };
    }
    if (this.phase === "unassigned" || this.phase === "stopped") {
      return { ok: true };
    }
    if (this.phase === "error") {
      this.phase = "stopped";
      this.markChanged();
      return { ok: true };
    }
    if (this.phase === "stopping") {
      // ADR: 停止の重複は合流させる。二重の閉塞は作らず、進行中の閉塞完了を
      // 待って成功とする（`beginClose` は閉塞を共有する）。
      const pending = this.closePromise;
      if (pending !== null) {
        await pending;
      }
      if (this.disposed) {
        return { ok: false, reason: "cancelled", message: "破棄されたため停止を取り消した。" };
      }
      if (this.phase === "stopping") this.phase = "stopped";
      this.boundAddress = null;
      this.markChanged();
      return { ok: true };
    }
    // ADR: 開始途中（`starting`）の停止は取消優先である。取消標識を立てて
    // 進行中の閉塞を待ち、開始側の継続で bind させない。待機順序は開始側の
    // 継続が先であり、標識を見て bind せず `stopped` に落ち着く。
    this.cancelStartRequested = true;
    this.phase = "stopping";
    this.markChanged();
    await this.beginClose();
    if (this.disposed) {
      return { ok: false, reason: "cancelled", message: "破棄されたため停止を取り消した。" };
    }
    if (this.phase === "stopping") this.phase = "stopped";
    this.boundAddress = null;
    this.markChanged();
    return { ok: true };
  }

  /**
   * bind 失敗を `error` に確定する。
   *
   * 自動 rollback・自動再試行はしない。要求した設定は残し、実際の bind 先は
   * 空にする。
   *
   * @param message - 失敗の説明。
   * @returns `bind-failed` の失敗結果。
   */
  private failBind(message: string): UdpControlResult {
    this.boundAddress = null;
    this.lastError = message;
    this.phase = "error";
    this.markChanged();
    return { ok: false, reason: "bind-failed", message };
  }

  /**
   * セッション失効・終了で転送を即時禁止し、ソケット閉塞を開始する。
   *
   * 開始途中の `start` は取り消す。段階は待受け系から `stopped` に落とし、
   * 理由を `lastError` に残す（成功した `start` で消える）。
   */
  private handleSessionGone(): void {
    if (this.disposed) return;
    const hadSocket = this.socket !== null || this.closePromise !== null;
    const wasActive =
      this.phase === "running" || this.phase === "starting" || this.phase === "stopping";
    this.forwardingAllowed = false;
    this.cancelStartRequested = true;
    if (hadSocket) {
      void this.beginClose();
    }
    if (wasActive) {
      this.phase = "stopped";
      this.boundAddress = null;
      this.lastError = "セッションが終了したため転送を停止した。";
    }
    this.markChanged();
  }

  /**
   * 受信データグラムを転送する（ソケット配送口）。
   *
   * 古い世代の遅延配送は数えずに無視する。分類順序は固定する：
   * 送信元表記→上限→送信中→転送先の生存。送信確定後に base64 化し、
   * 送れない受信の符号化は行わない。
   *
   * @param generation - bind 時に捕捉した世代番号。
   * @param data - 受信バイト列。
   * @param rinfo - ソケットが報告した送信者。
   */
  private handleDatagram(
    generation: number,
    data: Uint8Array,
    rinfo: { address: string; port: number },
  ): void {
    // ADR: 世代番号で古いソケットの遅延配送を無視する。閉塞開始と同時に
    // 世代を進めるため、閉塞中の到着は数えず、転送もしない。
    if (generation !== this.generation) return;
    this.receivedDatagrams += 1;
    this.receivedBytes += data.length;
    if (!isUdpSource({ address: rinfo.address, port: rinfo.port })) {
      this.droppedInvalidMetadata += 1;
      this.markChanged();
      return;
    }
    if (data.length > UDP_MAX_DATAGRAM_BYTES) {
      // ADR: 上限超過は破棄して数え、セッションを切断しない。巨大受信で
      // 輸送フレーム上限（65,536 バイト）を超えると接続全体が壊れるため、
      // 復号後 48,000 バイトで先に落とす。
      this.droppedOversize += 1;
      this.markChanged();
      return;
    }
    // ADR: 送信同時一件・待機域なしである。送信未完了中の新着は base64 化せず
    // 破棄して数える。待機域を作ると遅延転送の山ができ、最新性の意味が崩れる。
    if (this.sendInFlight) {
      this.droppedBusy += 1;
      this.markChanged();
      return;
    }
    const session = this.session;
    if (!this.forwardingAllowed || session === null || !session.isAlive) {
      // ADR: 失効・全体終端・相手 FIN は各購読（`onRevoked`・`onEnd`・
      // `onRemoteEnd`）が転送停止と閉塞開始を行うため、通常ここには到達
      // しない。付替え直後・終端直後の生存確認に対する防御であり、転送
      // 不能は送信失敗に数える（再送はしない）。
      this.sendFailures += 1;
      this.markChanged();
      return;
    }
    this.sendInFlight = true;
    const byteLength = data.length;
    const message: UdpDatagramMessage = {
      op: UDP_DATAGRAM_OP,
      dataBase64: encodeUdpData(data),
      source: { address: rinfo.address, port: rinfo.port },
    };
    void session.sendReliable(message).then(
      () => {
        this.sendInFlight = false;
        this.forwardedDatagrams += 1;
        this.forwardedBytes += byteLength;
        this.markChanged();
      },
      () => {
        // ADR: 送信失敗は数えるだけで再送しない。順序保証のある再送は
        // 待機域を要求し、片方向転送の意味を崩すためである。
        this.sendInFlight = false;
        this.sendFailures += 1;
        this.markChanged();
      },
    );
  }

  /**
   * ソケット異常を記録する（受信は維持する）。
   *
   * @param generation - bind 時に捕捉した世代番号。古ければ無視する。
   * @param error - 異常の内容。
   */
  private handleSocketError(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    if (this.disposed) return;
    this.lastError = `ソケット異常を検出した: ${describeFailure(error)}`;
    this.markChanged();
  }

  /**
   * 失効通知を購読する（失効・全体終端・相手FINのいずれでも転送を止める）。
   *
   * 失効以外の終端経路のため `onEnd`・`onRemoteEnd` の購読も残す。
   *
   * @param session - 割当て期間だけ有効な操作口。
   */
  private subscribeSession(session: Extract<AssignedSession, { kind: "reliable" }>): void {
    this.sessionUnsubs.push(
      session.onRevoked(() => this.handleSessionGone()),
      session.onEnd(() => this.handleSessionGone()),
      session.onRemoteEnd(() => this.handleSessionGone()),
    );
  }

  /** 現在のセッション購読を外す（転送先の参照には触れない）。 */
  private detachSession(): void {
    for (const unsubscribe of this.sessionUnsubs.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は付け替えを止めない。
      }
    }
  }

  /**
   * 現在のソケット購読を外し、参照を切り離す（閉塞はしない）。
   *
   * @param created - 切り離す対象。現在のソケットと一致する場合のみ外す。
   */
  private detachSocket(created: UdpReceiverSocket): void {
    if (this.socket === created) {
      this.socket = null;
    }
    for (const unsubscribe of this.socketUnsubs.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は閉塞を止めない。
      }
    }
  }

  /**
   * 現在のソケットの閉塞を開始・共有する。
   *
   * 世代を進めて遅延配送を無効化し、進行中の閉塞があれば合流する。
   * 旧→新の順序は呼出し側が `await` で守る。
   *
   * @returns 閉塞の完了で解ける約束。
   */
  private beginClose(): Promise<void> {
    // ADR: 世代は閉塞開始と同時に進める。閉塞完了を待たずに遅延配送を
    // 無効化し、古いソケットの到着を数えないためである。
    this.generation += 1;
    const target = this.socket;
    this.socket = null;
    for (const unsubscribe of this.socketUnsubs.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は閉塞を止めない。
      }
    }
    if (target === null) {
      return this.closePromise ?? Promise.resolve();
    }
    // ADR: 進行中の閉塞が無ければ即時に閉じる。閉塞鎖に繋ぐのは重複時の
    // 直列化のためであり、単発の停止・失効では同期的に閉塞を開始する。
    const previous = this.closePromise;
    const closing = previous === null ? target.close() : previous.then(() => target.close());
    const tracked = closing.then(
      () => {
        if (this.closePromise === tracked) this.closePromise = null;
      },
      () => {
        // ADR: 閉塞自体の失敗は握りつぶす。送受信の成否ではなく後始末であり、
        // 失敗を `lastError` に載せると直近の bind 失敗の説明を上書きするためである。
        if (this.closePromise === tracked) this.closePromise = null;
      },
    );
    this.closePromise = tracked;
    return tracked;
  }

  /**
   * 切り離し済みソケットの閉塞を閉塞鎖に繋いで待つ。
   *
   * bind 失敗・取消で生じた宙ぶらりんのソケットを残さないための口であり、
   * 世代には触れない（呼出し側で既に進めている）。
   *
   * @param created - 閉じる対象。
   * @returns 閉塞の完了で解ける約束。
   */
  private beginCloseDetached(created: UdpReceiverSocket): Promise<void> {
    // ADR: `beginClose` と同じく、進行中の閉塞が無ければ即時に閉じる。
    const previous = this.closePromise;
    const closing = previous === null ? created.close() : previous.then(() => created.close());
    const tracked = closing.then(
      () => {
        if (this.closePromise === tracked) this.closePromise = null;
      },
      () => {
        if (this.closePromise === tracked) this.closePromise = null;
      },
    );
    this.closePromise = tracked;
    return tracked;
  }

  /**
   * 状態購読を登録する。
   *
   * @param handler - 最新の状態を受け取る処理。
   * @returns 購読解除。
   * @throws `RangeError` — 破棄済みの場合。
   */
  private addStateListener(handler: (state: UdpPluginState) => void): Unsubscribe {
    if (this.disposed) throw new RangeError("破棄済みのインスタンスである。");
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  /** 状態を変更したことを記録し、購読者へ最新の状態を届ける。読み取りでは進めない。 */
  private markChanged(): void {
    this.revision += 1;
    this.notifyStateChanged();
  }

  /** 状態購読者へ最新の状態を届ける。購読者の例外は隔離する。 */
  private notifyStateChanged(): void {
    if (this.disposed) return;
    const snapshot = this.getState();
    // ADR: 通知中の購読解除に備えて写しへ届ける。`Array.from` は反復子の
    // 振る舞いを変えず、既存の配送スナップショット方針に合わせる。
    for (const listener of Array.from(this.stateListeners)) {
      try {
        listener(snapshot);
      } catch {
        // 購読者の例外で通知を止めない。
      }
    }
  }
}

/**
 * 失敗原因の短い説明を作る。本文・バイト列は含めない。
 *
 * @param error - 失敗の原因。
 * @returns 表示用の短い説明。
 */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * UDP プラグイン定義を生成する。
 *
 * @param options - ソケット生成口の差替え（テスト注入専用）。省略時は既定 factory を使う。
 * @returns 単一の接続口（reliable 双方向）を持つプラグイン定義。
 */
export function createUdpPlugin(
  options?: UdpPluginOptions,
): PluginDefinition<UdpPluginState, UdpPluginOperations> {
  const socketFactory = options?.socketFactory ?? createNodeUdpSocket;
  return {
    pluginId: UDP_PLUGIN_ID,
    ports: [
      {
        portId: UDP_PORT_ID,
        accepts: [{ kind: "reliable", direction: "bidirectional" }],
      },
    ],
    create(): PluginInstance<UdpPluginState, UdpPluginOperations> {
      return new UdpInstance(socketFactory);
    },
  };
}

/**
 * 既定のソケット生成口を使う UDP プラグイン定義。
 *
 * インスタンスごとに独立した受信管理と統計を持つ。
 */
export const udpPlugin: PluginDefinition<UdpPluginState, UdpPluginOperations> = createUdpPlugin();
