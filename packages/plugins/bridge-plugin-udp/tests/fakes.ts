/**
 * UDPプラグイン試験の偽資源。
 *
 * 偽サーバー管理境界と偽 Session は `bridge-plugin-text` の `tests/fakes.ts`
 * と同形の複写であり、基盤（`bridge-app-core`）駆動の割当て・失効を検証する
 * ために使う（3者同一の検査対象には含めない。この package 固有の複写である）。
 * 実サーバーの公開振る舞い（開始通知→一覧・取得→終了通知の順序、
 * 終了後の取得不可、購読者の例外隔離）だけを模し、輸送は行わない。
 *
 * 偽 UDP ソケット（`偽Udp受信ソケット`）と生成口（`偽ソケット生成口`）は
 * UDP 固有であり、bind・閉塞の成否と配送を試験側で駆動する。
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
import type { UdpReceiverSocket, UdpSocketAddress, UdpSocketFactory } from "../src/udp-socket.ts";

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

/** bind 要求の記録。 */
export interface FakeBindCall {
  readonly address: string;
  readonly port: number;
}

/**
 * 偽の受信専用 UDP ソケット。
 *
 * bind・閉塞の成否と配送を試験側で駆動する。`close()` は冪等であり、
 * 二重の閉塞でも同じ完了を返す（本物の冪等化の検証条件を模す）。
 */
export class 偽Udp受信ソケット implements UdpReceiverSocket {
  /** `bind` で受けた要求の記録。 */
  readonly bindCalls: FakeBindCall[] = [];
  /** 手動 bind の待機列。試験側が `bind成功`・`bind失敗` で確定する。 */
  readonly pendingBinds: {
    readonly address: string;
    readonly port: number;
    readonly resolve: (address: UdpSocketAddress) => void;
    readonly reject: (error: Error) => void;
  }[] = [];
  /** 手動閉塞の待機列。試験側が `閉塞完了` で確定する。 */
  readonly pendingCloses: { readonly resolve: () => void }[] = [];
  /** `close` を呼んだ回数。 */
  closeCalls = 0;
  /**
   * bind の自動振る舞い。`null` の間は `echoBind` に従う。
   * `Error` なら自動拒否、待受け先なら自動確定する。
   */
  autoBind: UdpSocketAddress | Error | null = null;
  /**
   * `true` の間は要求通りの待受け先で自動確定する。
   * `autoBind` の指定を優先し、どちらも無ければ手動（待機列に積む）。
   */
  echoBind = true;
  /** 閉塞の自動振る舞い。偽の場合は自動完了する。 */
  autoClose = true;
  private readonly messageHandlers = new Set<
    (data: Uint8Array, rinfo: { address: string; port: number }) => void
  >();
  private readonly errorHandlers = new Set<(error: unknown) => void>();

  /** {@inheritDoc UdpReceiverSocket.bind} */
  bind(address: string, port: number): Promise<UdpSocketAddress> {
    this.bindCalls.push({ address, port });
    const preset = this.autoBind;
    if (preset !== null) {
      if (preset instanceof Error) {
        return Promise.reject(preset);
      }
      return Promise.resolve(preset);
    }
    if (this.echoBind) {
      return Promise.resolve({
        address,
        port,
        family: address.includes(":") ? "IPv6" : "IPv4",
      });
    }
    return new Promise<UdpSocketAddress>((resolve, reject) => {
      this.pendingBinds.push({ address, port, resolve, reject });
    });
  }

  /** {@inheritDoc UdpReceiverSocket.onMessage} */
  onMessage(
    cb: (data: Uint8Array, rinfo: { address: string; port: number }) => void,
  ): FakeUnsubscribe {
    this.messageHandlers.add(cb);
    return () => {
      this.messageHandlers.delete(cb);
    };
  }

  /** {@inheritDoc UdpReceiverSocket.onError} */
  onError(cb: (error: unknown) => void): FakeUnsubscribe {
    this.errorHandlers.add(cb);
    return () => {
      this.errorHandlers.delete(cb);
    };
  }

  /** {@inheritDoc UdpReceiverSocket.close} */
  close(): Promise<void> {
    this.closeCalls += 1;
    if (!this.autoClose) {
      return new Promise<void>((resolve) => {
        this.pendingCloses.push({ resolve });
      });
    }
    return Promise.resolve();
  }

  /**
   * 待機中の手動 bind を成功させる。
   *
   * @param bound - 確定する待受け先。省略時は要求通り（IPv4/IPv6 判定付き）で確定する。
   */
  bind成功(bound?: UdpSocketAddress): void {
    const pending = this.pendingBinds.shift();
    if (pending === undefined) throw new Error("待機中の bind が無い。");
    pending.resolve(
      bound ?? {
        address: pending.address,
        port: pending.port,
        family: pending.address.includes(":") ? "IPv6" : "IPv4",
      },
    );
  }

  /**
   * 待機中の手動 bind を失敗させる。
   *
   * @param error - 失敗の原因。省略時は `EADDRINUSE` 相当とする。
   */
  bind失敗(error = new Error("EADDRINUSE: address already in use")): void {
    const pending = this.pendingBinds.shift();
    if (pending === undefined) throw new Error("待機中の bind が無い。");
    pending.reject(error);
  }

  /**
   * 待機中の手動閉塞をすべて完了させる。
   */
  閉塞完了(): void {
    for (const pending of this.pendingCloses.splice(0)) {
      pending.resolve();
    }
  }

  /**
   * 受信データグラムを届ける。
   *
   * @param data - 受信バイト列。
   * @param rinfo - 送信者。省略時は loopback の送信者とする。
   */
  受信(
    data: Uint8Array,
    rinfo: { address: string; port: number } = { address: "127.0.0.1", port: 40000 },
  ): void {
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(data, rinfo);
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
  }

  /**
   * ソケット異常を通知する。
   *
   * @param error - 異常の内容。
   */
  異常(error: unknown = new Error("偽ソケットの異常")): void {
    for (const handler of [...this.errorHandlers]) {
      try {
        handler(error);
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
  }
}

/**
 * 偽ソケットの生成口。
 *
 * 用意した偽ソケットを順に渡し、生成時の選択肢を記録する。用意が無ければ
 * 自動成功の偽ソケットを作る。
 */
export class 偽ソケット生成口 {
  /** 生成時に受けた選択肢の記録。 */
  readonly createdOptions: { readonly type: "udp4" | "udp6"; readonly ipv6Only?: boolean }[] = [];
  /** 渡した偽ソケットの記録。 */
  readonly handedOut: 偽Udp受信ソケット[] = [];

  /** @param supply - 順に渡す偽ソケット。用意が無ければ自動生成する。 */
  constructor(private readonly supply: 偽Udp受信ソケット[] = []) {}

  /**
   * 本体へ渡す factory を作る。
   *
   * @returns 偽ソケットを返す生成口。
   */
  factory(): UdpSocketFactory {
    return (options) => {
      this.createdOptions.push(options);
      const next = this.supply.shift() ?? new 偽Udp受信ソケット();
      this.handedOut.push(next);
      return next;
    };
  }
}
