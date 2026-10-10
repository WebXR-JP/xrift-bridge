/**
 * 認可済み1接続の mux 管理（B3 `Connection` のサーバ側包み）。
 *
 * 同一 WS 上の yamux Connection（role `"server"`）を所有し、inbound の
 * `create_session` を Session 登録して受信 `data` を業務へ渡す。
 * - `kind:"latest"`（client→server）の受信値を `latestMailbox` へ格納する。
 * - `kind:"reliable"`（client→server）の受信値をサーバ側の診断ハンドラへ渡す。
 *
 * 認可後の生存セッションはローカル識別子で公開する（一覧・取得・開始終了通知）。
 * 切替中・未認可の Session は公開しない。終了開始（`onClosing`）で一覧・取得から
 * 即時に外し、個別の終了通知は各 Session の `onEnd` で行う。FIN（`onRemoteEnd`）
 * では終了通知を出さない。
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
  type SessionEnd,
  type TimerScheduler,
  type WsMessageStreamOptions,
} from "bridge-protocol/transport";
import { handleDiagnosticPayload } from "./diagnostic-handler.ts";
import type { NodeWsSocket } from "./node-socket.ts";

/** 生存セッションのローカル識別子。プロセス内で単調に払い出し再利用しない。 */
export type LocalSessionId = string;

/** サーバ側が公開する生存セッション。 */
export type ServerSession = InboundSession<"server">;

/**
 * 生存セッションの公開情報。
 *
 * `sessionId` は wire の論理名であり、別接続・終了後の再作成で再利用され得る
 * ため、表示・関連付け情報としてのみ扱う。識別には `localSessionId` を使う。
 */
export type BridgeSessionInfo = {
  /** 再利用しないローカル識別子。取得キーに使う。 */
  readonly localSessionId: LocalSessionId;
  /** 属する接続の識別子。 */
  readonly connectionId: string;
  /** wire の論理名。取得キーには使わない。 */
  readonly sessionId: string;
} & (
  | { readonly kind: "reliable"; readonly direction: "bidirectional" }
  | { readonly kind: "latest"; readonly direction: "to_server" }
);

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

// ADR: ローカル識別子はモジュールスコープの単調増加 `bigint` から払い出す。
// 接続終了・同一プロセス内のサーバ再作成でリセットしない。ワールドから値を
// 受け取らず wire に載せない。
let nextLocalSessionSeq = 1n;

/** 生存セッションの内部記録。一覧・取得の公開単位である。 */
interface LiveSessionRecord {
  readonly info: BridgeSessionInfo;
  readonly session: ServerSession;
  /** 開始通知まで確定したか。未確定のまま終われば開始・終了とも出さない。 */
  published: boolean;
  /** 終了通知を出したか。一度だけ出す。 */
  endNotified: boolean;
  /** stale 差分の回収済み位置。同名後継と混ざらないようレコードで持つ。 */
  lastStaleSeen: number;
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
  /** 生存セッションの開始を通知する。登録確定後に呼ぶ。 */
  onSessionStarted(connection: AuthorizedConnection, info: BridgeSessionInfo): void;
  /** 生存セッションの終了を通知する。一度だけ呼ぶ。 */
  onSessionEnded(connection: AuthorizedConnection, info: BridgeSessionInfo, end: SessionEnd): void;
  /** 終端開始を通知する。一覧・取得からの除外は済んでいる。 */
  onClosing(connection: AuthorizedConnection, cause: Error): void;
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
  /** 終端開始の通知済みか。終了完了（`terminated`）とは別に管理する。 */
  private closingNotified = false;
  /** 生存セッションの内部表。公開は一覧・取得で行う。 */
  private readonly liveSessions = new Map<LocalSessionId, LiveSessionRecord>();

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
      onClosing: (cause) => {
        this.handleConnectionClosing(cause);
      },
      onClose: (cause) => {
        this.handleConnectionClosed(cause);
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

  /** 生存セッションの公開情報の写し。 */
  listSessions(): readonly BridgeSessionInfo[] {
    return [...this.liveSessions.values()]
      .filter((record) => record.published)
      .map((record) => record.info);
  }

  /**
   * 生存セッションをローカル識別子で取り出す。
   *
   * @param localSessionId - 公開情報のローカル識別子。
   * @returns 生存中のみ Session を返す。終了後は `undefined`。
   */
  getSession(localSessionId: LocalSessionId): ServerSession | undefined {
    const record = this.liveSessions.get(localSessionId);
    if (record === undefined || !record.published) return undefined;
    return record.session;
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
    const cause = new Error(reason);
    this.beginClosing(cause);
    try {
      this.connection.terminate(cause);
    } catch {
      // 終端の失敗は閉塞を止めない。
    }
    // `onClose` 通知が届かない経路でも終了完了まで進める（冪等である）。
    this.finishClosed(cause);
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
    this.beginClosing(cause);
    try {
      this.connection.terminate(cause);
    } catch {
      // 終端の失敗は無視する。
    }
    // `onClose` 通知が届かない経路でも終了完了まで進める（冪等である）。
    this.finishClosed(cause);
  }

  /** inbound Session を業務へ配線し、生存として公開する。 */
  private attachSession(session: InboundSession<"server">): void {
    // ① 識別子を採番し内部登録する。
    const localSessionId: LocalSessionId = `session-${nextLocalSessionSeq++}`;
    const info: BridgeSessionInfo = {
      localSessionId,
      connectionId: this.connectionId,
      sessionId: session.sessionId,
      ...(session.kind === "latest"
        ? { kind: "latest", direction: "to_server" }
        : { kind: "reliable", direction: "bidirectional" }),
    } satisfies BridgeSessionInfo;
    const record: LiveSessionRecord = {
      info,
      session,
      published: false,
      endNotified: false,
      lastStaleSeen: session.staleDroppedCount,
    };
    this.liveSessions.set(localSessionId, record);
    // ② 終端の解除処理・latest 記録を設置する。
    // `kind` で絞る：`"latest"` は受信側（`LatestReceiverSession<"server">`、
    // 方向 `to_server`）、それ以外は `ReliableSession<"server">` である。
    if (session.kind === "latest") {
      session.onMessage((payload) => {
        // ADR: stale は Session が黙って捨てるため、配送時に差分で補正する。
        // 直後に stale が来ても次回配送・終了時に回収する。
        this.reconcileStale(record);
        this.host.storeLatest(session.sessionId, payload);
        this.reconcileStale(record);
      });
    } else {
      session.onMessage((payload) => {
        handleDiagnosticPayload(session, payload, {
          recordEcho: () => this.host.recordDiagnosticEcho(),
          recordPing: () => this.host.recordDiagnosticPing(),
        });
      });
    }
    // FIN（`onRemoteEnd`）では終了通知を出さず、全体終了（`onEnd`）で出す。
    session.onEnd((end) => {
      this.handleSessionEnd(record, end);
    });
    // ③ 生存を再確認する。登録中に終わっていた Session は公開しない。
    // 終端済みの `onEnd` は登録時に同期で即時通知されるため、ここでは
    // 未確定のまま除外すれば開始・終了とも出さない。
    if (!session.isAlive || this.closingNotified) {
      if (this.liveSessions.get(localSessionId) === record) {
        this.liveSessions.delete(localSessionId);
      }
      return;
    }
    record.published = true;
    // ④ 開始を通知する。
    this.host.onSessionStarted(this, info);
  }

  /** 全体終了を同一レコードで処理し、終了通知を一度だけ出す。 */
  private handleSessionEnd(record: LiveSessionRecord, end: SessionEnd): void {
    this.reconcileStale(record);
    if (this.liveSessions.get(record.info.localSessionId) === record) {
      this.liveSessions.delete(record.info.localSessionId);
    }
    if (!record.published || record.endNotified) return;
    record.endNotified = true;
    this.host.onSessionEnded(this, record.info, end);
  }

  /** Session の stale 計数を差分で回収する。 */
  private reconcileStale(record: LiveSessionRecord): void {
    // ADR: stale は Session が黙って捨てるため、配送・終了の時点で差分を回収する。
    // 論理名キーではなくレコードで持つため、同名後継の計数を旧終了処理が汚さない。
    const current = record.session.staleDroppedCount;
    if (current > record.lastStaleSeen) {
      const delta = current - record.lastStaleSeen;
      record.lastStaleSeen = current;
      try {
        this.host.recordLatestDropped(delta);
      } catch {
        // 計数の失敗は業務を止めない。
      }
    }
  }

  /**
   * 終端開始を確定する。冪等である。
   *
   * 一覧・取得から全 Session を即時に外し、終了開始を通知する。個別の終了通知は
   * 各レコードの `onEnd`（捕捉済みレコード）で行う。
   */
  private beginClosing(cause: Error): void {
    if (this.closingNotified) return;
    this.closingNotified = true;
    this.liveSessions.clear();
    // ADR: 委ね先の失敗で終端を止めない。`Connection` 側の `onClosing` 通知は
    // 隔離済みだが、直接の切断経路でも同じ保証にする。
    try {
      this.host.onClosing(this, cause);
    } catch {
      // 通知の失敗は終端を止めない。
    }
  }

  /** 終端完了を WS 切断・管理除外へつなぐ（一度だけ）。 */
  private finishClosed(cause: Error): void {
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

  /** Connection 終端開始の観測。Session 終端より先に一覧・取得を失効させる。 */
  private handleConnectionClosing(cause: Error): void {
    this.beginClosing(cause);
  }

  /** Connection 終端の観測（相手 GoAway・mux 異常・keepalive 失敗を含む）。 */
  private handleConnectionClosed(cause: Error): void {
    this.beginClosing(cause);
    this.finishClosed(cause);
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
