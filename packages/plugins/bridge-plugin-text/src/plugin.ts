/**
 * 固定テキスト表示プラグイン（直近一件の置換表示）。
 *
 * 接続口は一つで、`reliable`・`bidirectional` のみ受け付ける。
 * 相関識別子の採番、直近一件の送信管理、反映確認の照合、応答期限
 * （10秒）と結果不明の判定、統計を担う。同時実行は一件であり、
 * 重複送信はプラグイン本体が拒否する。
 *
 * 「反映確認」は表示用状態への反映であり、`sendReliable()` の成功や
 * 描画完了とは区別する。期限切れ・切断は結果不明とし、自動再送しない。
 * 遅延・重複確認は次の要求に対応させない。不正な応答は対象セッション
 * のみ中断し、不正入力は送信前に拒否する。本文をログに残さない。
 *
 * @packageDocumentation
 */
import {
  TEXT_RESPONSE_TIMEOUT_MS,
  TEXT_SHOW_OP,
  isAckForRequest,
  isTextShownAck,
  validateTextForSend,
  type TextShowRequest,
} from "./contract.ts";
import type {
  AssignedSession,
  PluginDefinition,
  PluginInstance,
  Unsubscribe,
} from "bridge-app-core/core";

/** テキストプラグインの識別子。 */
export const TEXT_PLUGIN_ID = "text";

/** テキストプラグインの接続口識別子。 */
export const TEXT_PORT_ID = "text";

/** 結果不明の理由。期限切れ・切断・破棄のいずれかである。 */
export type TextUnknownReason = "timeout" | "disconnected" | "disposed";

/**
 * 送信要求の決着。
 *
 * 反映確認または結果不明のいずれかであり、送信処理の失敗（拒否）とは
 * 区別する。送信前の拒否は `RangeError` の拒否で表す。
 */
export type TextSendResult =
  | { readonly status: "acknowledged"; readonly id: string }
  | { readonly status: "unknown"; readonly id: string; readonly reason: TextUnknownReason };

/**
 * テキスト送信の統計（インスタンス単位）。
 *
 * 送信試行・反映確認・結果不明の件数であり、輸送統計には混ぜない。
 */
export interface TextStats {
  /** 送信試行件数（本文検証後・送出前の確定時点）。 */
  readonly attempts: number;
  /** 反映確認件数。 */
  readonly acknowledged: number;
  /** 結果不明件数（期限切れ・切断・破棄）。 */
  readonly unknown: number;
}

/**
 * テキストプラグインの UI 非依存の状態。
 *
 * 送信可能状態・実行中・直近結果・統計・改訂番号を提供する。本文は含まない。
 * 改訂番号は単調増加し、状態変更時に進める。読取りでは進めない。
 */
export interface TextPluginState {
  /**
   * 単調増加の改訂番号。初期値は 0 であり、状態変更の確定ごとに進める。
   *
   * GUI アダプターは引き継ぐだけで進めず、子は新しい状態のみ採用する。
   */
  readonly revision: number;
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
 * テキストプラグイン固有の操作口。
 *
 * 汎用の任意 payload 送信口は作らず、テキスト送信と状態購読だけを提供する。
 * backend はこの口で状態を表示へ結線できる。
 */
export interface TextPluginOperations {
  /**
   * 本文を現在の割当てへ送信し、反映確認または結果不明で解ける約束を返す。
   *
   * @param text - 送信する本文。非空・上限以内・改行可。
   * @param localSessionId - 現在の割当て識別子。一致しない送信は拒否する。
   * @returns 反映確認または結果不明。送信前の拒否は `RangeError` で拒否する。
   */
  sendText(text: string, localSessionId: string): Promise<TextSendResult>;
  /**
   * 状態変化を購読する。
   *
   * @param handler - 最新の状態を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 破棄済みの場合。
   */
  onStateChanged(handler: (state: TextPluginState) => void): Unsubscribe;
}

/** テキストプラグイン生成時の設定。 */
export interface TextPluginOptions {
  /**
   * 反映確認の応答期限（ミリ秒）。
   *
   * @defaultValue `TEXT_RESPONSE_TIMEOUT_MS`（省略時に生成処理が適用）。
   */
  readonly responseTimeoutMs?: number;
}

/** 応答待ちの要求。 */
interface PendingRequest {
  /** 採番した相関識別子。 */
  readonly id: string;
  /** 決着を待つ約束の解ける口。 */
  readonly resolve: (result: TextSendResult) => void;
  /** 応答期限のタイマー。 */
  readonly timer: ReturnType<typeof setTimeout>;
}

/** テキストインスタンス（単一の reliable 接続口を受ける）。 */
class TextInstance implements PluginInstance<TextPluginState, TextPluginOperations> {
  private session: Extract<AssignedSession, { kind: "reliable" }> | null = null;
  private unsubs: Unsubscribe[] = [];
  private nextSeq = 1;
  private pending: PendingRequest | null = null;
  private lastResult: TextSendResult | null = null;
  private attempts = 0;
  private acknowledged = 0;
  private unknownCount = 0;
  // 改訂番号の所有者は本体であり、状態変更の確定ごとに進める。
  // 読取り（`getState`）では進めない。
  private revision = 0;
  private readonly stateListeners = new Set<(state: TextPluginState) => void>();
  private disposed = false;

  /** @param responseTimeoutMs - 反映確認の応答期限（ミリ秒）。正の有限値である。 */
  constructor(private readonly responseTimeoutMs: number) {}

  /** {@inheritDoc PluginInstance.attach} */
  attach(portId: string, session: AssignedSession): void {
    if (this.disposed) throw new RangeError("破棄済みのインスタンスである。");
    if (portId !== TEXT_PORT_ID) throw new RangeError(`不明な接続口である: ${portId}`);
    if (session.kind !== "reliable" || session.direction !== "bidirectional") {
      throw new RangeError("テキストの接続口に合わない操作口である。");
    }
    // ADR: 切替え時は未決着通信を混在させない。旧要求は新セッションへ
    // 持ち越さず、結果不明（切断）で確定する。
    const pendingId = this.pending?.id;
    this.detachSession();
    this.session = session;
    this.unsubs.push(
      session.onMessage((payload) => {
        this.handlePayload(payload);
      }),
      session.onEnd(() => {
        this.handleEnd();
      }),
      // ADR: 相手 FIN の後は反映確認が届かないため、切断相当の結果不明にする。
      session.onRemoteEnd(() => {
        this.handleEnd();
      }),
    );
    if (pendingId !== undefined) {
      this.settleUnknown(pendingId, "disconnected");
    } else {
      this.notifyStateChanged();
    }
  }

  /** {@inheritDoc PluginInstance.getState} */
  getState(): TextPluginState {
    const session = this.session;
    return {
      revision: this.revision,
      canSend: !this.disposed && session !== null && session.isAlive && this.pending === null,
      pendingId: this.pending?.id ?? null,
      lastResult: this.lastResult,
      stats: {
        attempts: this.attempts,
        acknowledged: this.acknowledged,
        unknown: this.unknownCount,
      },
    };
  }

  /** {@inheritDoc PluginInstance.getOperations} */
  getOperations(): TextPluginOperations {
    return {
      sendText: (text, localSessionId) => this.sendText(text, localSessionId),
      onStateChanged: (handler) => this.addStateListener(handler),
    };
  }

  /** {@inheritDoc PluginInstance.dispose} */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pendingId = this.pending?.id;
    this.detachSession();
    this.stateListeners.clear();
    if (pendingId !== undefined) {
      // ADR: 応答待ちは結果不明（破棄）で確定し、タイマーを終了させる。
      // 遅延確認が届いても決着は変わらない。
      this.settleUnknown(pendingId, "disposed");
    }
  }

  /**
   * 本文を送信する。
   *
   * @param text - 送信する本文。
   * @param localSessionId - 現在の割当て識別子。
   * @returns 反映確認または結果不明の約束。送信前の拒否は `RangeError` で拒否する。
   */
  private sendText(text: string, localSessionId: string): Promise<TextSendResult> {
    if (this.disposed) return Promise.reject(new RangeError("破棄済みのインスタンスである。"));
    const validated = validateTextForSend(text);
    if (!validated.ok) {
      return Promise.reject(new RangeError(`送信できない本文である（${validated.reason}）。`));
    }
    const target = this.session;
    if (target === null) return Promise.reject(new RangeError("割当て中のセッションがない。"));
    if (target.info.localSessionId !== localSessionId) {
      return Promise.reject(new RangeError("現在の割当てと識別子が一致しない。"));
    }
    if (!target.isAlive) return Promise.reject(new RangeError("セッションは終端している。"));
    if (this.pending !== null) {
      return Promise.reject(new RangeError("送信中の要求がある。同時実行は一件までである。"));
    }
    const id = `text-${this.nextSeq++}`;
    this.attempts += 1;
    const outcome = new Promise<TextSendResult>((resolve) => {
      const timer = setTimeout(() => {
        // ADR: 期限切れは結果不明とし、自動再送しない。遅延確認は識別子照合で無視される。
        this.settleUnknown(id, "timeout");
      }, this.responseTimeoutMs);
      this.pending = { id, resolve, timer };
    });
    this.notifyStateChanged();
    const request: TextShowRequest = { op: TEXT_SHOW_OP, id, text: validated.text };
    // ADR: 送出失敗は Session 終端として扱い、切断相当の結果不明にする。
    void target.sendReliable(request).catch(() => {
      this.settleUnknown(id, "disconnected");
    });
    return outcome;
  }

  /**
   * 状態購読を登録する。
   *
   * @param handler - 最新の状態を受け取る処理。
   * @returns 購読解除。
   * @throws `RangeError` — 破棄済みの場合。
   */
  private addStateListener(handler: (state: TextPluginState) => void): Unsubscribe {
    if (this.disposed) throw new RangeError("破棄済みのインスタンスである。");
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  /** 現在の購読を外し、操作口の参照を離す（応答待ちには触れない）。 */
  private detachSession(): void {
    for (const unsubscribe of this.unsubs.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は付け替えを止めない。
      }
    }
    this.session = null;
  }

  /**
   * 受信 payload を照合し、反映確認・無視・中断のいずれかに振り分ける。
   *
   * @param payload - 受信した JSON 値。
   */
  private handlePayload(payload: unknown): void {
    const target = this.session;
    if (target === null) return;
    const pending = this.pending;
    if (pending !== null && isAckForRequest(pending.id, payload)) {
      this.settleAcknowledged(pending.id);
      return;
    }
    if (isTextShownAck(payload)) {
      // ADR: 遅延・重複確認は次の要求に対応させない（無視する）。
      return;
    }
    // ADR: 不正な応答は対象セッションのみ中断し、他セッションと Connection は維持する。
    try {
      target.abort(new Error("テキスト応答の形状が不正である。"));
    } catch {
      // 中断の失敗は無視する。
    }
  }

  /** Session 終端で応答待ちを結果不明（切断）にする。 */
  private handleEnd(): void {
    const pendingId = this.pending?.id;
    if (pendingId !== undefined) {
      this.settleUnknown(pendingId, "disconnected");
    } else {
      this.notifyStateChanged();
    }
  }

  /**
   * 応答待ちを反映確認で確定する。
   *
   * @param id - 確定する要求の相関識別子。既に決着済みなら何もしない。
   */
  private settleAcknowledged(id: string): void {
    const pending = this.pending;
    if (pending === null || pending.id !== id) return;
    clearTimeout(pending.timer);
    this.pending = null;
    this.acknowledged += 1;
    const result: TextSendResult = { status: "acknowledged", id };
    this.lastResult = result;
    pending.resolve(result);
    this.notifyStateChanged();
  }

  /**
   * 応答待ちを結果不明で確定する。
   *
   * @param id - 確定する要求の相関識別子。既に決着済みなら何もしない。
   * @param reason - 結果不明の理由。
   */
  private settleUnknown(id: string, reason: TextUnknownReason): void {
    const pending = this.pending;
    if (pending === null || pending.id !== id) return;
    clearTimeout(pending.timer);
    this.pending = null;
    this.unknownCount += 1;
    const result: TextSendResult = { status: "unknown", id, reason };
    this.lastResult = result;
    pending.resolve(result);
    this.notifyStateChanged();
  }

  /** 状態購読者へ最新の状態を届ける。購読者の例外は隔離する。 */
  private notifyStateChanged(): void {
    // 改訂番号の所有者は本体であり、状態変更の確定時に進める。
    // 読取りでは進めない。
    this.revision += 1;
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
 * 固定テキストプラグイン定義を生成する。
 *
 * @param options - 応答期限の上書き。省略時は契約の既定（10秒）を使う。
 * @returns 単一の接続口（reliable 双方向）を持つプラグイン定義。
 * @throws `RangeError` — 応答期限が正の有限値ではない場合。
 */
export function createTextPlugin(
  options?: TextPluginOptions,
): PluginDefinition<TextPluginState, TextPluginOperations> {
  const responseTimeoutMs = options?.responseTimeoutMs ?? TEXT_RESPONSE_TIMEOUT_MS;
  if (!Number.isFinite(responseTimeoutMs) || responseTimeoutMs <= 0) {
    throw new RangeError("応答期限は正の有限値である必要がある。");
  }
  return {
    pluginId: TEXT_PLUGIN_ID,
    ports: [
      {
        portId: TEXT_PORT_ID,
        accepts: [{ kind: "reliable", direction: "bidirectional" }],
      },
    ],
    create(): PluginInstance<TextPluginState, TextPluginOperations> {
      return new TextInstance(responseTimeoutMs);
    },
  };
}

/**
 * 既定の応答期限（10秒）を使う固定テキストプラグイン定義。
 *
 * インスタンスごとに独立した送信管理と統計を持つ。
 */
export const textPlugin: PluginDefinition<TextPluginState, TextPluginOperations> =
  createTextPlugin();
