/**
 * 認可済み1接続の mux 管理（B3 `Connection` のサーバ側包み）。
 *
 * 同一 WS 上の yamux Connection（role `"server"`）を所有し、inbound の
 * `create_session` を Session 登録して受信 `data` を業務へ渡す。
 * - `kind:"latest"`（client→server）の受信値を `latestMailbox` へ格納する。
 * - `kind:"reliable"`（client→server）の受信値をサーバ側の診断ハンドラへ渡す。
 *
 * 終了（FIN/RST/GoAway/WS close）は認可失効・待機破棄・管理一覧からの除外に
 * つなぐ。keepalive は B3 の組み込みを使い、`connectionCloseGraceMs` は
 * Node の強制終了（`terminate()`）として終了後に一度だけ行う。
 *
 * 配送の未決着送信の拒否は transport（B2/B3）に委ね、ここで待機を作らない。
 *
 * @packageDocumentation
 */
import { WebSocket } from "ws";
import {
  Connection,
  WsMessageStream,
  type InboundSession,
  type TimerScheduler,
  type WsMessageStreamOptions,
} from "bridge-protocol/transport";
import { handleDiagnosticPayload } from "./diagnostic-handler.ts";
import type { NodeWsSocket } from "./node-socket.ts";

/** libp2p `Logger` の無操作実装を組み立てる。 */
function createNoopLogger(): WsMessageStreamOptions["log"] {
  const callable = (..._args: unknown[]): void => {};
  const log = callable as unknown as WsMessageStreamOptions["log"];
  (log as unknown as { error: (..._args: unknown[]) => void }).error = (
    ..._args: unknown[]
  ): void => {};
  (log as unknown as { trace: (..._args: unknown[]) => void }).trace = (
    ..._args: unknown[]
  ): void => {};
  (log as unknown as { enabled: boolean }).enabled = false;
  (log as unknown as { newScope: () => WsMessageStreamOptions["log"] }).newScope = () => log;
  return log;
}

/** 認可接続がサーバ側へ委ねる操作。 */
export interface AuthorizedConnectionHost {
  /** latest 受信箱へ書き込む。計数はサーバ側で行う。 */
  storeLatest(sessionId: string, payload: unknown): void;
  /** 捨てた古い latest を件数で数える。 */
  recordLatestDropped(delta: number): void;
  /** 診断 echo を1件数える。 */
  recordDiagnosticEcho(): void;
  /** 診断 ping を1件数える。 */
  recordDiagnosticPing(): void;
  /** 終端を通知する。一度だけ呼ぶ。 */
  onClosed(connection: AuthorizedConnection, cause: Error): void;
}

/** 認可接続の生成条件。 */
export interface AuthorizedConnectionOptions {
  /** 紐付ける接続の識別子（`auth_ok.connectionId` と一致）。 */
  readonly connectionId: string;
  /** 終了後の強制終了に使う生ソケット。 */
  readonly socket: WebSocket;
  /** mux 開始後の binary 適合（受信口は呼び出し側が流す）。 */
  readonly rawSocket: NodeWsSocket;
  /** 強制終了までの猶予（ミリ秒）。 */
  readonly closeGraceMs: number;
  /** keepalive 等のタイマー実装。省略時は環境のタイマーを使う。 */
  readonly scheduler?: TimerScheduler;
  /** 記録・通知の委ね先。 */
  readonly host: AuthorizedConnectionHost;
}

/**
 * 認可済み1接続。B3 `Connection`（role `"server"`）を包む。
 *
 * 生成時に `WsMessageStream`（`inbound`）と `Connection` を作り、
 * 以降の送受信・終了は Session・Connection に委ねる。`terminate()` で
 * GoAway＋全 Session 終端を行い、WS を閉じる。輸送（`WsMessageStream`）は
 * 閉じない（`Connection` が面倒を見る）。
 */
export class AuthorizedConnection {
  /** 紐付ける接続の識別子。 */
  readonly connectionId: string;

  private readonly socket: WebSocket;
  private readonly stream: WsMessageStream;
  private readonly connection: Connection<"server">;
  private readonly host: AuthorizedConnectionHost;
  private readonly closeGraceMs: number;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private terminated = false;
  /** 生存 Session の追跡（統計の欠番補正用）。終了で外す。 */
  private readonly liveSessions = new Map<string, InboundSession<"server">>();
  private readonly lastStaleSeen = new Map<string, number>();

  /**
   * @param options - 接続識別子・ソケット・適合・猶予・委ね先。
   * @throws `Error` — 輸送・Connection の生成に失敗した場合。
   */
  constructor(options: AuthorizedConnectionOptions) {
    this.connectionId = options.connectionId;
    this.socket = options.socket;
    this.host = options.host;
    this.closeGraceMs = options.closeGraceMs;
    this.stream = new WsMessageStream(options.rawSocket, {
      direction: "inbound",
      log: createNoopLogger(),
    });
    this.connection = new Connection<"server">({
      transport: this.stream,
      role: "server",
      connectionId: options.connectionId,
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      onSession: (session) => {
        this.attachSession(session);
      },
      onClose: (cause) => {
        this.onConnectionClosed(cause);
      },
    });
  }

  /** 終端済みか。 */
  get closed(): boolean {
    return this.terminated;
  }

  /** 登録中の Session 数。 */
  get sessionCount(): number {
    return this.connection.sessionCount;
  }

  /**
   * 運用切断・境界違反で終端する。冪等である。
   *
   * GoAway＋全 Session 終端を行い、WS を `1008`・固定 reason で閉じる。
   * 応答しない相手は猶予後に一度だけ強制終了する。
   *
   * @param reason - WS close の reason（固定文）。
   */
  disconnect(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    try {
      this.connection.terminate(new Error(reason));
    } catch {
      // 終端の失敗は閉塞を止めない。
    }
    try {
      this.socket.close(1008, reason);
    } catch {
      // 閉塞時の例外は無視する。
    }
    this.armForceTerminate();
    this.host.onClosed(this, new Error(reason));
  }

  /**
   * WS close などで外から終端する。冪等である。
   *
   * Connection を終端し、WS が開いていれば閉じる。強制終了も一度だけ行う。
   *
   * @param cause - 終端原因。
   */
  terminate(cause: Error): void {
    if (this.terminated) return;
    this.terminated = true;
    try {
      this.connection.terminate(cause);
    } catch {
      // 終端の失敗は無視する。
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(1008, cause.message.slice(0, 123));
      } catch {
        // 閉塞時の例外は無視する。
      }
    }
    this.armForceTerminate();
    this.host.onClosed(this, cause);
  }

  /** inbound Session を業務へ配線する。 */
  private attachSession(session: InboundSession<"server">): void {
    this.liveSessions.set(session.sessionId, session);
    this.lastStaleSeen.set(session.sessionId, session.staleDroppedCount);
    // `kind` で絞る：`"latest"` は受信側（`LatestReceiverSession<"server">`、
    // 方向 `to_server`）、それ以外は `ReliableSession<"server">` である。
    if (session.kind === "latest") {
      session.onMessage((payload) => {
        // ADR: stale は Session が黙って捨てるため、配送時に差分で補正する。
        // 直後に stale が来ても次回配送・終了時に回収する。
        this.reconcileStale(session);
        this.host.storeLatest(session.sessionId, payload);
        this.reconcileStale(session);
      });
    } else {
      session.onMessage((payload) => {
        handleDiagnosticPayload(session, payload, {
          recordEcho: () => this.host.recordDiagnosticEcho(),
          recordPing: () => this.host.recordDiagnosticPing(),
        });
      });
    }
    session.onEnd(() => {
      this.reconcileStale(session);
      if (this.liveSessions.get(session.sessionId) === session) {
        this.liveSessions.delete(session.sessionId);
      }
    });
  }

  /** Session の stale 計数を差分で回収する。 */
  private reconcileStale(session: InboundSession<"server">): void {
    // ADR: stale は Session が黙って捨てるため、配送・終了の時点で差分を回収する。
    const last = this.lastStaleSeen.get(session.sessionId) ?? 0;
    const current = session.staleDroppedCount;
    if (current > last) {
      this.lastStaleSeen.set(session.sessionId, current);
      try {
        this.host.recordLatestDropped(current - last);
      } catch {
        // 計数の失敗は業務を止めない。
      }
    }
  }

  /** Connection 終端を WS 切断・管理除外へつなぐ（一度だけ）。 */
  private onConnectionClosed(cause: Error): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(1008, cause.message.slice(0, 123));
      } catch {
        // 閉塞時の例外は無視する。
      }
    }
    this.armForceTerminate();
    this.host.onClosed(this, cause);
  }

  /** 猶予後に一度だけ強制終了する。 */
  private armForceTerminate(): void {
    if (this.forceTimer !== null) return;
    this.forceTimer = setTimeout(() => {
      this.forceTimer = null;
      if (this.socket.readyState === WebSocket.CLOSED) return;
      try {
        this.socket.terminate();
      } catch {
        // 閉塞時の例外は無視する。
      }
    }, this.closeGraceMs);
    this.forceTimer.unref?.();
  }
}
