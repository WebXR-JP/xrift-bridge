/**
 * 認可後に使う Session と Session 管理口。
 *
 * 送受信・終了の本体は transport（B2 の `Session`・B3 の `Connection`）が
 * 担い、ここでは公開名（`isAlive` 等）への整形と、購読前の inbound 通知の
 * 保持だけを行う。業務 request/response 相関・自動再送・要求待機タイマーは
 * 持たず、上位層の責務とする。
 *
 * @packageDocumentation
 */
import type { ConnectionId, SessionDirection, SessionKind } from "bridge-protocol";
import {
  Connection,
  type RawSocket,
  type Session as TransportSession,
  type SessionEnd,
} from "bridge-protocol/transport";
import { WorldClientError } from "./errors.ts";

export type { SessionEnd };
export type { SessionKind, SessionDirection, ConnectionId };

/** `tryCreateSession` に渡す Session の生成条件。 */
export interface CreateSessionOptions {
  /** 作成する Session の論理名。接続内で一意であること。 */
  readonly sessionId: string;
  /** 配送種別。`reliable` は双方向のみ、`latest` は一方向のみである。 */
  readonly kind: SessionKind;
  /** 許す送信方向。役割（client は送信側）との整合が必要である。 */
  readonly direction: SessionDirection;
}

/**
 * セッション1つあたりの送受信口。
 *
 * Session は一連のやりとりの単位であり、既定は双方向 yamux stream 1本で
 * ある。request/response 相関は持たず、上位層の責務とする。
 */
export interface Session {
  /** この Session の論理名。 */
  readonly sessionId: string;
  /** 配送種別。 */
  readonly kind: SessionKind;
  /** 許す送信方向。 */
  readonly direction: SessionDirection;
  /** 全体終端していなければ真。 */
  readonly isAlive: boolean;
  /**
   * 確実に届けたい値を送る。
   *
   * Session 内で直列化し下位 backpressure を待つ。
   *
   * @param value - 配送する JSON 値。
   * @returns 完了はローカル送信処理完了であり、相手の受信・業務完了ではない。
   */
  sendReliable(value: unknown): Promise<void>;
  /**
   * 最新の状態を送る（同期受付）。
   *
   * yamux 投入前に未投入値を置換する。戻りは配送完了を意味しない。
   * 値ごとの配送 Promise は作らない。
   *
   * @param value - 配送する JSON 値。
   */
  sendLatest(value: unknown): void;
  /**
   * 受信した payload を購読する。
   *
   * @param handler - payload を受け取る処理。
   * @returns 購読解除。
   */
  onMessage(handler: (payload: unknown) => void): () => void;
  /**
   * 相手 FIN（読み終わり）を購読する。
   *
   * @param handler - 相手 FIN の処理。
   * @returns 購読解除。
   */
  onRemoteEnd(handler: () => void): () => void;
  /**
   * Session 全体の終端を購読する。
   *
   * @param handler - 終端内容を受け取る処理。
   * @returns 購読解除。
   */
  onEnd(handler: (end: SessionEnd) => void): () => void;
  /**
   * 送信方向を正常終了する（FIN）。
   *
   * @returns FIN 送出の完了で解ける約束。
   */
  closeWrite(): Promise<void>;
  /** 即時中断する（RST）。他 Session は維持する。 */
  abort(): void;
}

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
   * Session を開く。
   *
   * @param options - 論理名・種別・方向。
   * @returns 開いた Session で解ける約束。解決はローカル処理の完了であり、
   * 相手の業務受付成功ではない。
   */
  tryCreateSession(options: CreateSessionOptions): Promise<Session>;
  /**
   * 相手起点の Session を購読する。購読前の到着分は順序どおり渡す。
   *
   * @param handler - inbound Session を受け取る処理。
   * @returns 購読解除。
   */
  onSession(handler: (session: Session) => void): () => void;
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
 * transport の `Session` への公開名適合。
 *
 * 送受信・終了は委ね、終了判定だけを `isAlive` に読み替える。
 */
export class ClientSession implements Session {
  private readonly inner: TransportSession;

  /**
   * @param inner - 適合させる transport の Session。
   */
  constructor(inner: TransportSession) {
    this.inner = inner;
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

  /** 全体終端していなければ真。 */
  get isAlive(): boolean {
    return !this.inner.closed;
  }

  /** {@inheritDoc Session.sendReliable} */
  sendReliable(value: unknown): Promise<void> {
    return this.inner.sendReliable(value);
  }

  /** {@inheritDoc Session.sendLatest} */
  sendLatest(value: unknown): void {
    this.inner.sendLatest(value);
  }

  /** {@inheritDoc Session.onMessage} */
  onMessage(handler: (payload: unknown) => void): () => void {
    return this.inner.onMessage(handler);
  }

  /** {@inheritDoc Session.onRemoteEnd} */
  onRemoteEnd(handler: () => void): () => void {
    return this.inner.onRemoteEnd(handler);
  }

  /** {@inheritDoc Session.onEnd} */
  onEnd(handler: (end: SessionEnd) => void): () => void {
    return this.inner.onEnd(handler);
  }

  /** {@inheritDoc Session.closeWrite} */
  closeWrite(): Promise<void> {
    return this.inner.closeWrite();
  }

  /** {@inheritDoc Session.abort} */
  abort(): void {
    this.inner.abort();
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

  private readonly connection: Connection;
  private readonly rawSocket: RawSocket;
  private readonly wrapped = new Map<TransportSession, ClientSession>();
  private readonly backlog: ClientSession[] = [];
  private readonly sessionHandlers = new Set<(session: Session) => void>();
  private readonly closedHandlers = new Set<(cause: Error) => void>();
  private closed = false;
  private closeCause: Error | undefined;

  /**
   * @param connection - 適合させる transport の Connection（role `"client"`）。
   * @param rawSocket - mux 用のソケット適合。`close()` で閉じる。
   */
  constructor(connection: Connection, rawSocket: RawSocket) {
    this.connection = connection;
    this.connectionId = connection.connectionId;
    this.rawSocket = rawSocket;
  }

  /** 終端していなければ真。 */
  get isAlive(): boolean {
    return !this.closed;
  }

  /** {@inheritDoc SessionProvider.tryCreateSession} */
  async tryCreateSession(options: CreateSessionOptions): Promise<Session> {
    if (this.closed) {
      throw new WorldClientError("CONNECTION_CLOSED", "終端した接続では Session を開けない。");
    }
    const inner = await this.connection.createSession({
      sessionId: options.sessionId,
      kind: options.kind,
      direction: options.direction,
    });
    return this.wrap(inner);
  }

  /** {@inheritDoc SessionProvider.onSession} */
  onSession(handler: (session: Session) => void): () => void {
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
  handleInbound(inner: TransportSession): void {
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

  /** transport の Session を1対1で包む。 */
  private wrap(inner: TransportSession): ClientSession {
    const known = this.wrapped.get(inner);
    if (known !== undefined) return known;
    const session = new ClientSession(inner);
    this.wrapped.set(inner, session);
    return session;
  }
}
