/**
 * app-core 単体試験用の偽サーバー管理境界と偽 Session。
 *
 * 実サーバーの公開振る舞い（開始通知→一覧・取得→終了通知の順序、
 * 終了後の取得不可、購読者の例外隔離）だけを模し、輸送は行わない。
 *
 * @packageDocumentation
 */
import type {
  BridgeSessionInfo,
  LocalSessionId,
  ManagementEvent,
  ManagementListener,
  ServerSession,
} from "bridge-server";
import type { SessionEnd } from "bridge-protocol/transport";

/** 購読解除関数。 */
export type FakeUnsubscribe = () => void;

/**
 * 偽の reliable Session（サーバー側・双方向）。
 *
 * 受信の配送・送信の記録・中断の記録を持ち、基盤の振る舞いを確かめる。
 */
export class 偽ReliableSession {
  readonly kind = "reliable" as const;
  readonly direction = "bidirectional" as const;
  readonly side = "server" as const;
  isAlive = true;
  receivedCount = 0;
  readonly staleDroppedCount = 0;
  readonly missingSeqCount = 0;
  readonly lastRecvSeq = -1;
  writeEnded = false;
  peerEnded = false;
  /** `sendReliable` で受けた値の記録。 */
  readonly sent: unknown[] = [];
  /** `abort` で受けた原因の記録。 */
  readonly aborted: Error[] = [];
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();

  /** @param sessionId - 論理名。 */
  constructor(readonly sessionId: string) {}

  /** 受信 payload を購読する。 */
  onMessage(handler: (payload: unknown) => void): FakeUnsubscribe {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /** 全体終端を購読する。 */
  onEnd(handler: (end: SessionEnd) => void): FakeUnsubscribe {
    this.endHandlers.add(handler);
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  /** 相手 FIN を購読する。 */
  onRemoteEnd(handler: () => void): FakeUnsubscribe {
    this.remoteEndHandlers.add(handler);
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  /** 確実送信の記録。終了済みなら拒否する。 */
  sendReliable(value: unknown): Promise<void> {
    if (!this.isAlive) return Promise.reject(new Error("偽セッションは終了済みである。"));
    this.sent.push(value);
    return Promise.resolve();
  }

  /** 送信終了の記録。 */
  closeWrite(): Promise<void> {
    if (!this.isAlive) return Promise.reject(new Error("偽セッションは終了済みである。"));
    this.writeEnded = true;
    return Promise.resolve();
  }

  /** 即時中断し、終端購読者へ通知する。 */
  abort(error?: Error): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    const cause = error ?? new Error("偽セッションの中断");
    this.aborted.push(cause);
    this.notifyEnd({ kind: "aborted", error: cause });
  }

  /**
   * 受信データを届ける。
   *
   * @param payload - 届ける JSON 値。
   */
  emitMessage(payload: unknown): void {
    if (!this.isAlive) return;
    this.receivedCount += 1;
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(payload);
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
  }

  /**
   * 外部要因の終端を通知する。
   *
   * @param end - 終端内容。
   */
  notifyEnd(end: SessionEnd): void {
    this.isAlive = false;
    for (const handler of [...this.endHandlers]) {
      try {
        handler(end);
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
  }
}

/**
 * 偽の latest 受信 Session（サーバー側・受信のみ）。
 *
 * 送信口は持たない。
 */
export class 偽LatestSession {
  readonly kind = "latest" as const;
  readonly direction = "to_server" as const;
  readonly side = "server" as const;
  isAlive = true;
  receivedCount = 0;
  readonly staleDroppedCount = 0;
  readonly missingSeqCount = 0;
  readonly lastRecvSeq = -1;
  writeEnded = false;
  peerEnded = false;
  /** `abort` で受けた原因の記録。 */
  readonly aborted: Error[] = [];
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();

  /** @param sessionId - 論理名。 */
  constructor(readonly sessionId: string) {}

  /** 受信 payload を購読する。 */
  onMessage(handler: (payload: unknown) => void): FakeUnsubscribe {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /** 全体終端を購読する。 */
  onEnd(handler: (end: SessionEnd) => void): FakeUnsubscribe {
    this.endHandlers.add(handler);
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  /** 相手 FIN を購読する。 */
  onRemoteEnd(handler: () => void): FakeUnsubscribe {
    this.remoteEndHandlers.add(handler);
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  /** 送信終了の記録。 */
  closeWrite(): Promise<void> {
    if (!this.isAlive) return Promise.reject(new Error("偽セッションは終了済みである。"));
    this.writeEnded = true;
    return Promise.resolve();
  }

  /** 即時中断し、終端購読者へ通知する。 */
  abort(error?: Error): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    const cause = error ?? new Error("偽セッションの中断");
    this.aborted.push(cause);
    this.notifyEnd({ kind: "aborted", error: cause });
  }

  /**
   * 受信データを届ける。
   *
   * @param payload - 届ける JSON 値。
   */
  emitMessage(payload: unknown): void {
    if (!this.isAlive) return;
    this.receivedCount += 1;
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(payload);
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
  }

  /**
   * 外部要因の終端を通知する。
   *
   * @param end - 終端内容。
   */
  notifyEnd(end: SessionEnd): void {
    this.isAlive = false;
    for (const handler of [...this.endHandlers]) {
      try {
        handler(end);
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
  }
}

/** 偽サーバーが扱う Session。 */
export type 偽Session = 偽ReliableSession | 偽LatestSession;

/**
 * 偽のサーバー管理境界。
 *
 * 生存表・購読者集合を持ち、開始は登録確定後に通知し、終了は一覧から
 * 外してから一度だけ通知する。
 */
export class 偽サーバー {
  private nextSeq = 1;
  private readonly sessions = new Map<
    LocalSessionId,
    { readonly info: BridgeSessionInfo; readonly session: 偽Session }
  >();
  private readonly listeners = new Set<ManagementListener>();

  /** 生存セッションの一覧の写し。 */
  listSessions(): readonly BridgeSessionInfo[] {
    return [...this.sessions.values()].map((record) => record.info);
  }

  /**
   * 生存セッションをローカル識別子で取り出す。
   *
   * @param localSessionId - 公開情報のローカル識別子。
   * @returns 生存中のみ Session を返す。終了後は `undefined`。
   */
  getSession(localSessionId: LocalSessionId): ServerSession | undefined {
    return this.sessions.get(localSessionId)?.session;
  }

  /**
   * 管理通知を受け取る。
   *
   * @param listener - 開始・終了時に呼ぶ処理。例外を投げないこと。
   * @returns 登録解除関数。
   */
  onManagementEvent(listener: ManagementListener): FakeUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * reliable セッションを開始する。
   *
   * @param sessionId - 論理名。
   * @returns 公開情報と偽 Session の組。
   */
  開始Reliable(sessionId: string): {
    readonly info: BridgeSessionInfo;
    readonly session: 偽ReliableSession;
  } {
    const localSessionId: LocalSessionId = `local-${this.nextSeq++}`;
    const session = new 偽ReliableSession(sessionId);
    const info: BridgeSessionInfo = {
      localSessionId,
      connectionId: "conn-1",
      sessionId,
      kind: "reliable",
      direction: "bidirectional",
    };
    this.sessions.set(localSessionId, { info, session });
    this.emit({ kind: "session-started", session: info });
    return { info, session };
  }

  /**
   * latest セッションを開始する。
   *
   * @param sessionId - 論理名。
   * @returns 公開情報と偽 Session の組。
   */
  開始Latest(sessionId: string): {
    readonly info: BridgeSessionInfo;
    readonly session: 偽LatestSession;
  } {
    const localSessionId: LocalSessionId = `local-${this.nextSeq++}`;
    const session = new 偽LatestSession(sessionId);
    const info: BridgeSessionInfo = {
      localSessionId,
      connectionId: "conn-1",
      sessionId,
      kind: "latest",
      direction: "to_server",
    };
    this.sessions.set(localSessionId, { info, session });
    this.emit({ kind: "session-started", session: info });
    return { info, session };
  }

  /**
   * 偽 Session に受信データを届ける。
   *
   * @param localSessionId - 届け先のローカル識別子。
   * @param payload - 届ける JSON 値。
   */
  受信(localSessionId: LocalSessionId, payload: unknown): void {
    const record = this.sessions.get(localSessionId);
    if (record === undefined) throw new Error("偽サーバーに存在しないセッションである。");
    record.session.emitMessage(payload);
  }

  /**
   * セッションを終了させる。一覧から外してから一度だけ通知する。
   *
   * @param localSessionId - 終了させるセッションのローカル識別子。
   * @param end - 終端内容。省略時は正常終了とする。
   */
  終了(localSessionId: LocalSessionId, end: SessionEnd = { kind: "closed" }): void {
    const record = this.sessions.get(localSessionId);
    if (record === undefined) throw new Error("偽サーバーに存在しないセッションである。");
    this.sessions.delete(localSessionId);
    record.session.notifyEnd(end);
    this.emit({ kind: "session-ended", session: record.info, end });
  }

  /**
   * 管理通知を配送する。購読者の例外は隔離する。
   *
   * @param event - 配送する通知。
   */
  private emit(event: ManagementEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 購読者の例外でサーバーを壊さない。
      }
    }
  }
}
