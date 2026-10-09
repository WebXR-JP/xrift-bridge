/**
 * 認可後の受信セッションの会計・採番・業務処理。
 *
 * `auth_ok` で確定した接続単位の状態を持つ。認可ごとに作り直すことで、
 * ストリーム連番は接続ごとに 0 始まりになる。直近 latest 受信箱だけは
 * 接続をまたぐサーバ全体の記録のため、実体はサーバ側が所有し、
 * セッションは受け取った操作経由で書き込む。
 *
 * 配送（キュー・フラッシュ・ソケット送出）・接続ライフサイクル
 * （段階・切断・タイマー）・ペアリング・統計の実体は持たない。
 * 送出だけを {@link AuthorizedSessionHost} に委ね、
 * 接続状態の判定は呼び出し側（サーバ）が行う。
 *
 * クライアント側の送信権会計（送信可能残数の消費）と役割が逆であり、
 * 受信容量の予約として扱うため、会計エンジンは共有しない。
 *
 * @packageDocumentation
 */
import {
  PROTOCOL_VERSION,
  parseBridgeMessage,
  stringifyBridgeMessage,
  type SessionId,
  type StreamId,
} from "bridge-protocol";
import type { BridgeLimits } from "./config.ts";

/** セッション生成時に確定する設定。認可時に確定し、認可後は変えない。 */
export type AuthorizedSessionLimits = Pick<
  BridgeLimits,
  "maxReliableQueueMessages" | "maxStreamsPerConnection"
>;

/**
 * 認可後セッションがサーバ側へ委ねる小さな操作。
 *
 * いずれも一方向（セッション→サーバ）であり、`ConnectionState` 全体は渡さない。
 * 実際の送出・切断・記録の実体はサーバ側に置く。
 */
export interface AuthorizedSessionHost {
  /** 認可中かを返す。追加付与の可否判定に使う。 */
  isAuthorized(): boolean;
  /** 応答をキューへ積む。満杯なら `false`。 */
  enqueueResponse(text: string): boolean;
  /** 明示エラーを送る。 */
  sendError(code: string, message: string, requestId?: string, direct?: boolean): void;
  /** 認可前と同様の終端エラー付きで閉塞へ移す。 */
  terminate(code: string, message: string, requestId: string | undefined): void;
  /** 認可後の送信失敗・容量超過などで閉塞へ移す。 */
  terminateWithClose(code: number, reason: string): void;
  /** 追加付与を累積件数で通知する。送出の実体はサーバ側。 */
  notifyCredit(limit: number): void;
  /** echo 業務を1件数える。 */
  recordEcho(): void;
  /** command 業務を1件数える。 */
  recordCommand(): void;
  /** 落とした古い latest を1件数える。 */
  recordLatestDropped(): void;
  /** latest 受信箱へ書き込む。`latestStored` の計数もサーバ側で行う。 */
  storeLatest(streamId: StreamId, seq: number, payload: unknown): void;
}

/**
 * 認可後の受信セッション。クレジット会計・ストリーム採番・業務分岐の所有者。
 *
 * 接続状態・ソケット・ペアリング・受信箱の実体は持たない。
 */
export class AuthorizedSession {
  /** ブリッジが払い出した接続セッション識別子。認可時に確定する。 */
  readonly sessionId: SessionId;
  // クレジット会計（接続単位・全 reliable ストリーム共通）。
  // C（件数容量）= limits.maxReliableQueueMessages に対し、
  // 常に (grantedTotal − consumedTotal) + heldCount <= C を保つ。
  // grantedTotal: 累積付与件数、consumedTotal: 消費済み受信件数、
  // heldCount: 受信済みで容量未解放の件数（未送信・送信中の応答を含む）。
  private grantedTotal: number;
  private consumedTotal = 0;
  private heldCount = 0;
  private advertisedLimit: number;
  private readonly expectedSeq = new Map<StreamId, number>();
  private readonly latestSeq = new Map<StreamId, number>();

  /**
   * @param sessionId - 認可で確定した接続セッション識別子。
   * @param initialWindow - 初期付与。会計初期化であり認可後受信の前提。
   * @param limits - 生成時に確定する設定。
   * @param host - 送出・切断・記録の委ね先。接続状態の判定は呼び出し側が行う。
   */
  constructor(
    sessionId: SessionId,
    initialWindow: number,
    private readonly limits: AuthorizedSessionLimits,
    private readonly host: AuthorizedSessionHost,
  ) {
    this.sessionId = sessionId;
    this.grantedTotal = initialWindow;
    this.advertisedLimit = initialWindow;
  }

  /** 追加付与可能量。C − U − (G − R)。 */
  private grantableCredit(): number {
    return (
      this.limits.maxReliableQueueMessages -
      this.heldCount -
      (this.grantedTotal - this.consumedTotal)
    );
  }

  /**
   * 解放で生じた余裕を追加付与する。
   *
   * 付与は累積件数の通知で行い、残数の上書きはしない。同じ `limit` の再通知は
   * 権利を増やさない。送信callback完了はクライアントのアプリ処理完了を保証
   * せず、ここで保証するのはブリッジ内の受付・応答保持容量のみである。
   */
  private advertiseCredit(): void {
    if (!this.host.isAuthorized()) return;
    const extra = this.grantableCredit();
    if (extra <= 0) return;
    this.grantedTotal += extra;
    this.advertisedLimit = this.grantedTotal;
    this.host.notifyCredit(this.advertisedLimit);
  }

  /** 予約していた容量を解放し、生じた余裕を追加付与する。 */
  releaseHold(): void {
    this.heldCount -= 1;
    this.advertiseCredit();
  }

  /**
   * 消費済みの予約を取り消す。追加付与はしない。
   *
   * 応答キュー満杯で切断する場合に使う。解放後の追加付与は行わず、
   * 枠の二重計上を避ける。
   */
  private cancelHold(): void {
    this.heldCount -= 1;
  }

  /** ストリーム数上限を確認する。 */
  private checkStream(streamId: StreamId): boolean {
    if (this.expectedSeq.has(streamId)) return true;
    if (this.expectedSeq.size >= this.limits.maxStreamsPerConnection) return false;
    this.expectedSeq.set(streamId, 0);
    return true;
  }

  /**
   * 認可後の受信を処理する。
   *
   * セッション照合・クレジット消費・echo/command/data の分岐を担う。
   * 実際の送出・切断・記録はホストへ委ねる。
   *
   * @param parsed - 検証済みの受信メッセージ。
   */
  handleAuthorizedMessage(parsed: ReturnType<typeof parseBridgeMessage>): void {
    switch (parsed.type) {
      case "pairing_start":
        // 認可後の開始は受け付けず終了する（開始は接続につき1回）。
        this.host.terminate(
          "DUPLICATE_PAIRING_START",
          "開始メッセージは接続につき1回である。",
          undefined,
        );
        return;
      case "pairing_pending":
      case "auth_ok":
      case "echo_response":
      case "command_response":
      case "credit":
      case "error":
        // 逆方向の型は受け付けない。
        this.host.sendError("UNEXPECTED_DIRECTION", "その方向のメッセージは受け付けない。");
        return;
      case "echo":
      case "command_request":
      case "data":
        break;
      default:
        this.host.sendError("UNKNOWN_TYPE", "未知のメッセージ種別である。");
        return;
    }
    if (parsed.sessionId !== this.sessionId) {
      this.host.sendError("SESSION_MISMATCH", "セッション識別子が一致しない。", undefined);
      return;
    }
    const requestId = parsed.type === "data" ? undefined : parsed.requestId;
    // クレジットは接続単位・全 reliable ストリーム共通で、受け付けた reliable に
    // 対し1件消費する。latest・認証・制御フレームは消費しない。
    const consumesCredit = parsed.kind === "reliable";
    if (consumesCredit) {
      if (this.consumedTotal >= this.grantedTotal) {
        // 付与超過の reliable は業務処理前に明示拒否して切断する。
        this.host.sendError(
          "CREDIT_EXHAUSTED",
          "クレジットの付与を超えた reliable である。",
          requestId,
          true,
        );
        this.host.terminateWithClose(1011, "credit exhausted");
        return;
      }
      this.consumedTotal += 1;
      this.heldCount += 1;
    }
    if (!this.checkStream(parsed.streamId)) {
      // 消費済みの予約は解放し、枠を永久に失わせない。
      if (consumesCredit) this.releaseHold();
      this.host.sendError("STREAM_LIMIT", "ストリーム数が上限を超えた。", requestId);
      return;
    }
    if (parsed.kind === "reliable") {
      const expected = this.expectedSeq.get(parsed.streamId) ?? 0;
      if (parsed.seq !== expected) {
        // 消費済みの予約は解放し、枠を永久に失わせない。
        this.releaseHold();
        this.host.sendError("UNEXPECTED_SEQ", "ストリーム内連番が期待値と一致しない。", requestId);
        return;
      }
      this.expectedSeq.set(parsed.streamId, expected + 1);
    } else {
      const last = this.latestSeq.get(parsed.streamId) ?? -1;
      if (parsed.seq < last) {
        this.host.recordLatestDropped();
        return;
      }
      this.latestSeq.set(parsed.streamId, parsed.seq);
    }
    if (parsed.type === "echo") {
      this.host.recordEcho();
      const text = stringifyBridgeMessage({
        v: PROTOCOL_VERSION,
        type: "echo_response",
        sessionId: this.sessionId,
        streamId: parsed.streamId,
        kind: "reliable",
        seq: parsed.seq,
        requestId: parsed.requestId,
        payload: parsed.payload,
      });
      if (!this.host.enqueueResponse(text)) {
        // 消費済みの予約を解放したうえで切断し、枠を永久に失わせない。
        this.cancelHold();
        this.host.sendError("QUEUE_FULL", "応答キューが満杯である。", parsed.requestId, true);
        this.host.terminateWithClose(1011, "queue full");
      }
      return;
    }
    if (parsed.type === "command_request") {
      this.host.recordCommand();
      const known = parsed.command === "ping";
      const text = stringifyBridgeMessage(
        known
          ? {
              v: PROTOCOL_VERSION,
              type: "command_response",
              sessionId: this.sessionId,
              requestId: parsed.requestId,
              ok: true,
              result: "pong",
            }
          : {
              v: PROTOCOL_VERSION,
              type: "command_response",
              sessionId: this.sessionId,
              requestId: parsed.requestId,
              ok: false,
              error: {
                code: "UNKNOWN_COMMAND",
                message: `未知のコマンドである: ${parsed.command}`,
              },
            },
      );
      if (!this.host.enqueueResponse(text)) {
        // 消費済みの予約を解放したうえで切断し、枠を永久に失わせない。
        this.cancelHold();
        this.host.sendError("QUEUE_FULL", "応答キューが満杯である。", parsed.requestId, true);
        this.host.terminateWithClose(1011, "queue full");
      }
      return;
    }
    this.host.storeLatest(parsed.streamId, parsed.seq, parsed.payload);
    // ADR: `data(kind: reliable)` が latest 受信箱へ入る扱いは別項目として残し、
    // ここでは直さない。応答を保持しない reliable は予約を即時解放し、
    // 枠を失わせない（解放で生じた余裕は追加付与する）。
    if (consumesCredit) this.releaseHold();
  }
}
