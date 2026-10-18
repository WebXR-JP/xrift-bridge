/**
 * ブリッジ接続の手順。React・R3F・DOM に依存しない。
 *
 * 接続は `connect` を呼んだ時だけ行い、自動再接続・自動再送はしない。
 * 接続開始は `world-client` の `createConnectionRequest` が返す2つの約束で
 * 行い、比較コード（`pairingInfo`）は表示のみに使い、認可成立は
 * `sessionProvider` の解決で判定する。認可後は `getAuthorizedProvider()` が
 * 返す管理口から、使う側がセッションを開く。
 *
 * 取消は `cancel`、能動切断は `disconnect` で行う。切断で認可は失効し、
 * 再接続には新規の接続開始が必要である。
 *
 * @packageDocumentation
 */
import {
  WorldClientError,
  createConnectionRequest as defaultCreateConnectionRequest,
  parseBridgeEndpoint,
  type PairingInfo,
  type SessionProvider,
} from "world-client";
import type {
  BridgeConnectionOptions,
  BridgeErrorView,
  BridgeListener,
  BridgePhase,
  BridgeSnapshot,
  CreateConnectionRequestFn,
  PairingView,
} from "./types.ts";

/**
 * 接続とその購読・セッション管理口を所有する手順。`dispose` で終える。
 *
 * 生成しても接続は始めない。状態は写し（`getSnapshot()`）越しにだけ見せ、
 * `world-client` の内部状態や WebSocket は公開しない。
 */
export class BridgeConnection {
  private readonly endpoint: string;
  private readonly createRequest: CreateConnectionRequestFn;
  private readonly listeners = new Set<BridgeListener>();
  private phase: BridgePhase = "idle";
  private pairing: PairingView | null = null;
  private error: BridgeErrorView | null = null;
  private aborter: AbortController | null = null;
  private provider: SessionProvider | null = null;
  private providerUnsub: (() => void) | null = null;
  private closedByUser = false;
  private disposed = false;

  /**
   * 手順を生成する。接続は `connect` まで行わない。
   *
   * @param options - 接続先と、接続開始の差し替え口。
   * @throws `RangeError` — `endpoint` が正規の loopback 接続先でない場合。
   */
  constructor(options: BridgeConnectionOptions) {
    // ADR: 接続先の検証は生成時に行い、以降は正規形だけを保持する。
    // 不正な接続先で接続操作まで進んでから失敗させない。
    this.endpoint = parseBridgeEndpoint(options.endpoint);
    this.createRequest = options.createRequest ?? defaultCreateConnectionRequest;
  }

  /** 現在の接続状態の写しを返す。 */
  getSnapshot(): BridgeSnapshot {
    return {
      phase: this.phase,
      endpoint: this.endpoint,
      pairing: this.pairing === null ? null : { ...this.pairing },
      error: this.error,
    };
  }

  /**
   * 認可済みのセッション管理口を返す。所有権は移転しないため、呼び出し側で
   * `close` しないこと。テキスト専用セッションの生成に使う。
   *
   * @returns 認可中で生存している場合の管理口。それ以外は `null`。
   */
  getAuthorizedProvider(): SessionProvider | null {
    if (this.disposed || this.phase !== "authorized") return null;
    const provider = this.provider;
    if (provider === null || !provider.isAlive) return null;
    return provider;
  }

  /**
   * 写しを購読する。
   *
   * @param listener - 写しを受け取る購読者。
   * @returns 購読の解除関数。
   */
  subscribe(listener: BridgeListener): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 接続を開始し、比較コードの発行と人間の承認成立を待つ。承認の完了は
   * 写しの `phase` が `authorized` になることで分かる。
   *
   * 比較コード受信待ちに時限は設けず、取消は `cancel`、通信失敗はソケットの
   * 終端通知で扱う。失敗は写しの `error` に載せる。
   *
   * @throws `WorldClientError` — 進行中・認可済み・破棄済みの場合。
   */
  connect(): void {
    this.assertActive();
    if (this.phase === "connecting" || this.phase === "awaiting_approval") {
      throw new WorldClientError("SESSION_BUSY", "接続処理が進行中である。");
    }
    if (this.phase === "authorized") {
      throw new WorldClientError("ALREADY_CONNECTED", "既に認証済みである。");
    }
    this.teardown();
    this.phase = "connecting";
    this.pairing = null;
    this.error = null;
    this.closedByUser = false;
    this.emit();
    const aborter = new AbortController();
    this.aborter = aborter;
    // ADR: `origin` は渡さない。ブラウザではブラウザが付与する `Origin` を使う。
    const request = this.createRequest({ endpoint: this.endpoint, signal: aborter.signal });
    // ADR: 2つの約束はどちらも拒否され得る。片方だけを待つと未処理の拒否が
    // 残るため、両方に決着時の処理を付ける。
    void request.pairingInfo.then(
      (info) => {
        this.handlePairingInfo(info);
      },
      (error: unknown) => {
        this.handleFailure(error);
      },
    );
    void request.sessionProvider.then(
      (provider) => {
        this.handleProvider(provider);
      },
      (error: unknown) => {
        this.handleFailure(error);
      },
    );
  }

  /**
   * 待機中の接続試行を取り消す。承認待ちの表示は消える。
   *
   * @throws `WorldClientError` — 待機中でない・破棄済みの場合。
   */
  cancel(): void {
    this.assertActive();
    if (this.phase !== "connecting" && this.phase !== "awaiting_approval") {
      throw new WorldClientError("NOT_CONNECTING", "取り消せる接続試行がない。");
    }
    this.closedByUser = true;
    try {
      this.aborter?.abort();
    } catch {
      // 中断合図の失敗は決着通知に任せる。
    }
    this.aborter = null;
    this.phase = "ended";
    this.pairing = null;
    this.emit();
  }

  /**
   * 接続を閉じる。待機中の接続試行は取り消し、認可済みなら管理口を閉じる。
   */
  disconnect(): void {
    this.assertActive();
    this.closedByUser = true;
    try {
      this.aborter?.abort();
    } catch {
      // 中断合図の失敗は終端通知に任せる。
    }
    const provider = this.provider;
    if (provider !== null) {
      // ADR: 管理口の終端通知（`onClosed`）が写しの更新まで担う。ここで
      // 直接 `ended` にせず、通知経路を一本に保つ。
      try {
        provider.close();
      } catch {
        // 閉塞の失敗は終端通知に任せる。
      }
      return;
    }
    if (this.phase === "idle") return;
    this.phase = "ended";
    this.pairing = null;
    this.emit();
  }

  /**
   * 接続・購読を終える。再マウント時は新規生成すること。
   *
   * 以降の操作は拒否し、購読者へは通知しない。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closedByUser = true;
    this.listeners.clear();
    const provider = this.provider;
    this.provider = null;
    if (provider !== null) {
      try {
        provider.close();
      } catch {
        // 破棄時の閉塞失敗は無視する。
      }
    }
    this.teardown();
    this.phase = "ended";
    this.pairing = null;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new WorldClientError("DISPOSED", "破棄済みの接続手順は操作できない。");
    }
  }

  private handlePairingInfo(info: PairingInfo): void {
    if (this.disposed) return;
    if (this.phase !== "connecting") return;
    // ADR: 購読が遅れた UI でも `getSnapshot()` で表示できるよう、状態を先に
    // 反映してから通知する。
    this.pairing = { requestId: info.requestId, code: info.code };
    this.phase = "awaiting_approval";
    this.emit();
  }

  private handleProvider(provider: SessionProvider): void {
    if (this.disposed || (this.phase !== "connecting" && this.phase !== "awaiting_approval")) {
      // ADR: 取消・破棄の後に解決した管理口は残さない。閉じてから戻る。
      try {
        provider.close();
      } catch {
        // 破棄後の閉塞失敗は無視する。
      }
      return;
    }
    this.provider = provider;
    this.providerUnsub = provider.onClosed((cause) => {
      this.handleProviderClosed(cause);
    });
    this.aborter = null;
    this.phase = "authorized";
    this.pairing = null;
    this.emit();
  }

  private handleFailure(error: unknown): void {
    if (this.disposed) return;
    if (this.phase !== "connecting" && this.phase !== "awaiting_approval") return;
    this.teardown();
    this.phase = "ended";
    this.pairing = null;
    this.error = toErrorView(error);
    this.emit();
  }

  private handleProviderClosed(cause: Error): void {
    if (this.disposed) return;
    this.teardown();
    this.phase = "ended";
    this.pairing = null;
    // ADR: 能動切断では失敗を上書きしない。非自発の切断だけを表示に残す。
    if (!this.closedByUser) {
      this.error = toErrorView(cause);
    }
    this.emit();
  }

  private teardown(): void {
    this.aborter = null;
    if (this.providerUnsub !== null) {
      try {
        this.providerUnsub();
      } catch {
        // 購読解除の失敗は無視する。
      }
      this.providerUnsub = null;
    }
    this.provider = null;
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // 購読者の例外で接続状態を壊さないため握りつぶす。
      }
    }
  }
}

/**
 * 失敗を表示用の形にそろえる。
 *
 * @param error - 捕捉した失敗。
 * @returns 表示用の内容。
 */
function toErrorView(error: unknown): BridgeErrorView {
  if (error instanceof WorldClientError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "UNKNOWN", message };
}
