/**
 * 認可後に使う Session と Session 管理口。
 *
 * 公開 Session は client 固定の capability 合併（reliable 双方向・latest 送信・
 * latest 受信）であり、`kind`・`direction` で判別して使う。送受信・終了の本体は
 * transport（`Connection` が返す engine）が担い、ここでは同一 engine に同一
 * ファサードを返す適合と、購読前の inbound 通知の保持だけを行う。業務
 * request/response 相関・自動再送・要求待機タイマーは持たず、上位層の責務とする。
 *
 * @packageDocumentation
 */
import type { ConnectionId, SessionDirection, SessionKind } from "bridge-protocol";
import type {
  Connection,
  CreateSessionRequest,
  InboundSession as TransportInboundSession,
  LatestCreateSessionRequest,
  LatestReceiverSession as TransportLatestReceiverSession,
  LatestSenderSession as TransportLatestSenderSession,
  OutboundSession as TransportOutboundSession,
  RawSocket,
  ReliableCreateSessionRequest,
  ReliableSession as TransportReliableSession,
  Session as TransportSession,
  SessionEnd,
} from "bridge-protocol/transport";
import { WorldClientError } from "./errors.ts";

export type { SessionEnd };
export type { SessionKind, SessionDirection, ConnectionId };
export type {
  CreateSessionRequest,
  LatestCreateSessionRequest,
  ReliableCreateSessionRequest,
} from "bridge-protocol/transport";

/**
 * client 側の公開 Session（`kind`・`direction` で判別する合併）。
 *
 * `kind` が `"reliable"` なら双方向送受信、`"latest"` なら `direction` で送信側
 * （`to_server`）・受信側（`to_client`）が決まる。使える API は枝ごとに型で
 * 制限する。実行時の誤用は engine の検査で拒否する（従来の `SessionError`）。
 */
export type Session = TransportSession<"client">;

/**
 * client 側の双方向 reliable Session。
 *
 * `sendReliable` と `onMessage` を持つ。
 */
export type ReliableSession = TransportReliableSession<"client">;

/**
 * client 側の latest 送信 Session。
 *
 * `sendLatest` だけを持ち、`onMessage` は持たない。
 */
export type LatestSenderSession = TransportLatestSenderSession<"client">;

/**
 * client 側の latest 受信 Session。
 *
 * `onMessage` だけを持ち、`sendLatest` は持たない。
 */
export type LatestReceiverSession = TransportLatestReceiverSession<"client">;

/**
 * client 側が受け取れる Session（reliable または latest 受信側）。
 *
 * `onSession` 通知の型である。
 */
export type InboundSession = TransportInboundSession<"client">;

/**
 * client 側が開ける Session（reliable または latest 送信側）。
 *
 * 動的な合法要求に対する `tryCreateSession` の戻り型である。
 */
export type OutboundSession = TransportOutboundSession<"client">;

/**
 * `tryCreateSession` に渡す Session の生成条件。
 *
 * 合法な組合せの合併（reliable 双方向・client の latest 送信）の別名である。
 */
export type CreateSessionOptions = CreateSessionRequest<"client">;

/**
 * 認証完了後に受け取れる、セッション管理口。
 *
 * `tryCreateSession` で Session を開き、相手起点の Session は `onSession`
 * で受ける。終了時は全 Session を終端し、未決着の送信は transport が
 * 一度だけ拒否する（二重決着しない）。
 */
export interface SessionProvider {
  /** 紐付ける接続の識別子（`auth_ok.connectionId` と一致）。 */
  readonly connectionId: ConnectionId;
  /** 終端していなければ真。 */
  readonly isAlive: boolean;
  /**
   * reliable Session を開く。
   *
   * @param options - 論理名・種別（`"reliable"`）・方向（`"bidirectional"`）。
   * @returns 開いた Session で解ける約束。解決はローカル処理の完了であり、
   * 相手の業務受付成功ではない。
   */
  tryCreateSession(options: ReliableCreateSessionRequest): Promise<ReliableSession>;
  /**
   * latest 送信 Session を開く。
   *
   * @param options - 論理名・種別（`"latest"`）・方向（`"to_server"`）。
   * @returns 開いた Session で解ける約束。解決はローカル処理の完了であり、
   * 相手の業務受付成功ではない。
   */
  tryCreateSession(options: LatestCreateSessionRequest<"client">): Promise<LatestSenderSession>;
  /**
   * Session を開く（動的な合法要求用）。
   *
   * @param options - 論理名・種別・方向。
   * @returns 開いた Session で解ける約束。解決はローカル処理の完了であり、
   * 相手の業務受付成功ではない。
   */
  tryCreateSession(options: CreateSessionOptions): Promise<OutboundSession>;
  /**
   * 相手起点の Session を購読する。購読前の到着分は順序どおり渡す。
   *
   * @param handler - inbound Session を受け取る処理。
   * @returns 購読解除。
   */
  onSession(handler: (session: InboundSession) => void): () => void;
  /**
   * 管理口全体の終端を購読する。一度だけ通知する。
   *
   * @param handler - 終端原因を受け取る処理。
   * @returns 購読解除。
   */
  onClosed(handler: (cause: Error) => void): () => void;
  /** 全 Session を閉じる。内部的に WebSocket 接続も終了する。 */
  close(): void;
}

/**
 * engine 実行時の全体像。公開狭窄型の合併に、型には現れない送信・購読口を
 * 加えたものであり、adapter 内の委譲だけに使う。
 */
type EngineWide = TransportSession<"client"> & {
  sendReliable(value: unknown): Promise<void>;
  sendLatest(value: unknown): void;
  onMessage(handler: (payload: unknown) => void): () => void;
};

/**
 * transport の engine への適合（内部の wide 委譲）。
 *
 * 送受信・終了は engine に委ね、終了判定だけを `isAlive` に読み替える。
 * 公開の狭窄型には現れない送信・購読口も実行時には持ち、誤用は engine の
 * 検査に委ねる（従来の `SessionError` での拒否を保つ）。公開型への切替えは
 * `ClientSessionProvider` の生成関数側で行う。
 */
class ClientSessionFacade {
  private readonly inner: EngineWide;

  /**
   * @param inner - 適合させる transport の Session（client 側）。
   */
  constructor(inner: TransportSession<"client">) {
    // ADR: `Connection` は engine そのものを狭窄型で返すため、型に無い送信・
    // 購読口も実行時には残り、誤用は従来の `SessionError` で拒否する。この
    // 委譲を保つため、engine の全体像への見なしはこの一句に限定する。以降の
    // 委譲では `as` を置かず、getter は委譲のため生成時の値写しはしない。
    this.inner = inner as unknown as EngineWide;
  }

  /** この Session の論理名。 */
  get sessionId(): string {
    return this.inner.sessionId;
  }

  /** 配送種別。 */
  get kind(): SessionKind {
    return this.inner.kind;
  }

  /** 許す送信方向。 */
  get direction(): SessionDirection {
    return this.inner.direction;
  }

  /** この側（常に `"client"`）。 */
  get side(): "client" {
    return this.inner.side;
  }

  /** 全体終端していなければ真。 */
  get isAlive(): boolean {
    return this.inner.isAlive;
  }

  /** 受け渡し済みの受信件数。 */
  get receivedCount(): number {
    return this.inner.receivedCount;
  }

  /** latest で古い・同値のため捨てた受信件数。 */
  get staleDroppedCount(): number {
    return this.inner.staleDroppedCount;
  }

  /** latest で飛び越えた連番の合計。 */
  get missingSeqCount(): number {
    return this.inner.missingSeqCount;
  }

  /** latest の受信連番の最大値。未受信は -1 である。 */
  get lastRecvSeq(): number {
    return this.inner.lastRecvSeq;
  }

  /** 自側の送信終了（`closeWrite` 受付）済みか。 */
  get writeEnded(): boolean {
    return this.inner.writeEnded;
  }

  /** 相手 FIN の処理（EOF 通知）済みか。 */
  get peerEnded(): boolean {
    return this.inner.peerEnded;
  }

  /** engine への委譲。種別不一致は engine が拒否する。 */
  sendReliable(value: unknown): Promise<void> {
    return this.inner.sendReliable(value);
  }

  /** engine への委譲。種別不一致は engine が拒否する。 */
  sendLatest(value: unknown): void {
    this.inner.sendLatest(value);
  }

  /** engine への委譲。 */
  onMessage(handler: (payload: unknown) => void): () => void {
    return this.inner.onMessage(handler);
  }

  /** engine への委譲。 */
  onRemoteEnd(handler: () => void): () => void {
    return this.inner.onRemoteEnd(handler);
  }

  /** engine への委譲。 */
  onEnd(handler: (end: SessionEnd) => void): () => void {
    return this.inner.onEnd(handler);
  }

  /** engine への委譲。 */
  closeWrite(): Promise<void> {
    return this.inner.closeWrite();
  }

  /** engine への委譲。 */
  abort(error?: Error): void {
    this.inner.abort(error);
  }
}

/**
 * transport の `Connection`（role `"client"`）への管理口適合。
 *
 * `Connection` の生成時に決まる `onSession`・`onClose` を受け、公開の
 * 購読へ振り分ける。`close()` では GoAway 終端に加えて輸送（ソケット）を
 * 閉じる。transport は輸送を閉じないため、ここで閉じる。
 */
export class ClientSessionProvider implements SessionProvider {
  /** 紐付ける接続の識別子。 */
  readonly connectionId: ConnectionId;

  private readonly connection: Connection<"client">;
  private readonly rawSocket: RawSocket;
  private readonly wrapped = new WeakMap<TransportSession<"client">, ClientSessionFacade>();
  private readonly backlog: InboundSession[] = [];
  private readonly sessionHandlers = new Set<(session: InboundSession) => void>();
  private readonly closedHandlers = new Set<(cause: Error) => void>();
  private closed = false;
  private closeCause: Error | undefined;

  /**
   * @param connection - 適合させる transport の Connection（role `"client"`）。
   * @param rawSocket - mux 用のソケット適合。`close()` で閉じる。
   */
  constructor(connection: Connection<"client">, rawSocket: RawSocket) {
    this.connection = connection;
    this.connectionId = connection.connectionId;
    this.rawSocket = rawSocket;
  }

  /** 終端していなければ真。 */
  get isAlive(): boolean {
    return !this.closed;
  }

  /** {@inheritDoc SessionProvider.tryCreateSession} */
  async tryCreateSession(options: ReliableCreateSessionRequest): Promise<ReliableSession>;
  /** {@inheritDoc SessionProvider.tryCreateSession} */
  async tryCreateSession(
    options: LatestCreateSessionRequest<"client">,
  ): Promise<LatestSenderSession>;
  /** {@inheritDoc SessionProvider.tryCreateSession} */
  async tryCreateSession(options: CreateSessionOptions): Promise<OutboundSession>;
  async tryCreateSession(options: CreateSessionOptions): Promise<OutboundSession> {
    if (this.closed) {
      throw new WorldClientError("CONNECTION_CLOSED", "終端した接続では Session を開けない。");
    }
    const inner = await this.connection.createSession(options);
    return this.wrap(inner);
  }

  /** {@inheritDoc SessionProvider.onSession} */
  onSession(handler: (session: InboundSession) => void): () => void {
    this.sessionHandlers.add(handler);
    // ADR: 購読前の到着分を失わないため、登録時に順序どおり渡す。
    if (this.backlog.length > 0) {
      const staged = this.backlog.splice(0, this.backlog.length);
      for (const session of staged) {
        try {
          handler(session);
        } catch {
          // 購読者の例外は隔離する。
        }
      }
    }
    return () => {
      this.sessionHandlers.delete(handler);
    };
  }

  /** {@inheritDoc SessionProvider.onClosed} */
  onClosed(handler: (cause: Error) => void): () => void {
    this.closedHandlers.add(handler);
    if (this.closed) {
      try {
        handler(this.closeCause ?? new Error("接続が終了した。"));
      } catch {
        // 購読者の例外は隔離する。
      }
    }
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  /** {@inheritDoc SessionProvider.close} */
  close(): void {
    this.handleClosed(new WorldClientError("CONNECTION_CLOSED", "利用者が接続を閉じた。"));
    try {
      this.rawSocket.closeSocket();
    } catch {
      // 閉塞時の例外は無視する。
    }
  }

  /**
   * 相手起点の Session を受け取る。`Connection` の `onSession` から呼ぶ。
   *
   * @param inner - 成立した transport の Session。
   */
  handleInbound(inner: TransportInboundSession<"client">): void {
    if (this.closed) return;
    const session = this.wrap(inner);
    if (this.sessionHandlers.size === 0) {
      this.backlog.push(session);
      return;
    }
    for (const handler of [...this.sessionHandlers]) {
      try {
        handler(session);
      } catch {
        // 購読者の例外は隔離する。
      }
    }
  }

  /**
   * 管理口全体を終端する。`Connection` の `onClose`・調停役の境界違反経路・
   * `close()` から呼ぶ。一度だけ実行する。
   *
   * 未決着の送信約束の拒否自体は transport（`Connection.terminate` 経由の
   * Session 終端）が行い、ここでは通知だけを行う（二重決着しない）。
   * 調停役の終了処理ではソケット切断を続けて行うこと。
   *
   * @param cause - 終端原因。
   */
  handleClosed(cause: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCause = cause;
    try {
      this.connection.terminate(cause);
    } catch {
      // 終端の失敗は通知を止めない。
    }
    for (const handler of [...this.closedHandlers]) {
      try {
        handler(cause);
      } catch {
        // 購読者の例外は隔離する。
      }
    }
  }

  /** transport の Session を outbound 側の公開枝として包む。 */
  private wrap(inner: TransportOutboundSession<"client">): OutboundSession;
  /** transport の Session を inbound 側の公開枝として包む。 */
  private wrap(inner: TransportInboundSession<"client">): InboundSession;
  /** transport の Session を公開枝として包む。 */
  private wrap(inner: TransportSession<"client">): Session;
  private wrap(inner: TransportSession<"client">): Session {
    let facade = this.wrapped.get(inner);
    if (facade === undefined) {
      facade = new ClientSessionFacade(inner);
      this.wrapped.set(inner, facade);
    }
    // ADR: ファサードは実行時に全 capability を engine へ委譲する同一物であり、
    // 公開型は inner の `kind`・`direction` で決まる枝として返す。同一 inner
    // には常に同一物を返し、getter は委譲のため生成時の値写しはしない。
    if (inner.kind === "reliable") return facade as ReliableSession;
    if (inner.direction === "to_server") return facade as LatestSenderSession;
    return facade as LatestReceiverSession;
  }
}
