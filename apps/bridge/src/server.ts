/**
 * PC上で動く中継（WebSocket サーバ）。
 *
 * `127.0.0.1` に明示 bind し、`0.0.0.0`/`::` には bind しない。昇格前の検証、
 * 受付モード中の比較コード方式による認可（開始待ち→承認待ち→切替→認可）、
 * 認可後の同一 WS 上での yamux Connection と Session（`data` 一本化）を担う。
 * 上位層（AI 連携・RPC・プラグイン）は扱わない。
 *
 * 認可前は text（`pairing_start`・`pairing_pending`・`auth_ok`・`error`）だけを
 * 扱い、認可後は binary の mux だけを扱う。受信入口は一つにし、状態
 * （認可前 text／切替中／mux／closing）で分ける。承認時に `auth_ok` を text で
 * 送り、その完了（`ws.send` callback）で mux を開始する。
 *
 * 比較コードは両画面への表示と照合にだけ使い、構造化ログ・URL・永続保存・
 * 診断 JSON には出さない。承認操作はローカル管理境界だけに置き、
 * ワールド向け WebSocket には公開しない。
 *
 * @packageDocumentation
 */
import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseBridgeMessage,
  stringifyBridgeMessage,
  type BridgeToClientMessage,
  type SessionId,
} from "bridge-protocol";
import type { TimerScheduler } from "bridge-protocol/transport";
import { resolveLimits, type BridgeLimits } from "./config.ts";
import { AuthorizedConnection } from "./authorized-connection.ts";
import { NodeWsSocket } from "./node-socket.ts";
import { defaultLogger, logEvent, type BridgeLogger } from "./log.ts";
import { systemClock, type Clock } from "./clock.ts";
import { AcceptanceController, PairingRateLimiter, PairingStore } from "./pairing.ts";
import {
  BRIDGE_PATH,
  LOOPBACK_HOST,
  isLoopbackAddress,
  verifyUpgrade,
  parseAllowedOrigin,
} from "./verify.ts";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/** サーバ生成時の設定。 */
export interface BridgeOptions {
  /**
   * 待ち受けポート。競合時は探索せず起動失敗にする。
   *
   * 試験用途で `0` を指定すると空きポートを自動選択する。
   */
  readonly port: number;
  /**
   * 待ち受けホスト。`127.0.0.1` のみ受け付ける。
   *
   * @defaultValue `"127.0.0.1"`（省略時に起動処理が適用）。
   */
  readonly host?: string;
  /** 許可 `Origin` の一覧。完全一致で判定する。空は不可。 */
  readonly allowedOrigins: readonly string[];
  /** 流れ制御・制限の暫定値の上書き。 */
  readonly limits?: Partial<BridgeLimits>;
  /** 構造化ログの出力先。 */
  readonly logger?: BridgeLogger;
  /**
   * 時刻の取得口。期限判定は単調時計、表示は壁時計を使う。
   *
   * 省略時は既定時計を使う。`now` との併用時はこの `clock` を優先する。
   */
  readonly clock?: Clock;
  /**
   * 壁時計（ミリ秒）の差し替え。`clock` 省略時の試験用。
   *
   * 単調時計は既定のまま使うため、期限の前後関係を動かす試験には
   * `clock` を使うこと。
   */
  readonly now?: () => number;
  /**
   * 比較コードの生成関数の差し替え。試験用の差し替え口であり、
   * 製品の API や CLI に固定コード機能は設けない。
   */
  readonly generateCode?: () => string;
  /**
   * keepalive 等のタイマー実装。省略時は環境のタイマーを使う。
   *
   * 試験で時間を手で進める場合に差し替える。
   */
  readonly scheduler?: TimerScheduler;
}

/** 計測の土台になる動作カウンタ。 */
export interface BridgeStats {
  readonly connectionsAccepted: number;
  readonly upgradeRejected: number;
  /** 比較コードの照合による認可成功数。 */
  readonly pairingSuccess: number;
  /** 認可前の終端拒否・承認失敗の数。 */
  readonly pairingFailure: number;
  readonly latestStored: number;
  readonly latestDropped: number;
  readonly diagnosticEcho: number;
  readonly diagnosticPing: number;
  /** 拒否・失敗の理由別集計。upgrade 拒否とペアリング失敗の符号を数える。 */
  readonly rejectionsByReason: Readonly<Record<string, number>>;
}

/** 接続の認可段階。切替中は `auth_ok` 送出から mux 開始までの間である。 */
export type ConnectionPhase =
  | "awaiting_start"
  | "pending"
  | "switching"
  | "authorized"
  | "closing"
  | "closed";

/** 接続単位の公開情報。比較コードとは無関係。 */
export interface ConnectionInfo {
  /** 接続受付時に払い出す識別子。未認証接続にも付与し、再利用しない。 */
  readonly connectionId: string;
  /** 接続時の `Origin`。 */
  readonly origin: string;
  /** 認証済みか。 */
  readonly authorized: boolean;
  /** 認可段階。`closing` は物理切断まで枠を保持する。 */
  readonly phase: ConnectionPhase;
}

/** 受付の公開状態。終了時刻は表示用、残時間は単調時計で算出する。 */
export interface AcceptanceInfo {
  /** 受付が開いていれば `open`、閉じていれば `closed`。 */
  readonly state: "open" | "closed";
  /** 受付終了時刻（壁時計ミリ秒・表示用）。閉じていれば `null`。 */
  readonly endsAt: number | null;
  /** 受付の残時間（ミリ秒）。閉じていれば `0`。 */
  readonly remainingMs: number;
}

/**
 * 保留中のペアリング要求の公開内容。
 *
 * 比較コードを含む。呼び出し側はログ・URL・永続保存に出さず、両画面への
 * 表示と照合にだけ使うこと。
 */
export interface PendingPairingInfo {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: string;
  /** 要求元の接続識別子。 */
  readonly connectionId: string;
  /** 要求元の `Origin`。 */
  readonly origin: string;
  /** ASCII 数字 6 文字の比較コード。文字列のまま扱い数値化しない。 */
  readonly code: string;
  /** 発行時刻（壁時計ミリ秒・表示用）。 */
  readonly issuedAt: number;
  /** 承認期限（壁時計ミリ秒・表示用）。 */
  readonly expiresAt: number;
  /** 承認までの残時間（ミリ秒）。 */
  readonly remainingMs: number;
}

/** 承認結果。失敗理由を区別して監査できる。 */
export type ApprovalResult =
  | {
      readonly status: "APPROVED";
      /** 承認した要求の接続識別子。 */
      readonly connectionId: string;
      /** 承認した要求の `Origin`。 */
      readonly origin: string;
    }
  | {
      readonly status:
        | "NOT_PENDING"
        | "INVALID_CODE"
        | "CODE_MISMATCH"
        | "ACCEPTANCE_CLOSED"
        | "PAIRING_EXPIRED"
        | "CONNECTION_GONE"
        | "CONNECTION_CHECK_ERROR";
    };

/** 拒否結果。 */
export type RejectionResult = { readonly status: "REJECTED" } | { readonly status: "NOT_PENDING" };

/** 管理境界の通知。保留の増減と受付の開閉を知らせる。 */
export type ManagementEvent =
  | {
      readonly kind: "pending-created";
      readonly requestId: string;
      readonly connectionId: string;
      readonly origin: string;
    }
  | { readonly kind: "pending-ended"; readonly requestId: string; readonly reason: string }
  | { readonly kind: "acceptance-changed"; readonly state: "open" | "closed" };

/** 管理境界の購読者。例外を投げないこと。 */
export type ManagementListener = (event: ManagementEvent) => void;

/** 購読解除関数。 */
export type Unsubscribe = () => void;

/** 起動中のブリッジ。 */
export interface BridgeServer {
  /** 正規の接続先（例: `ws://127.0.0.1:3100/v1`）。 */
  readonly endpoint: string;
  /** 実際の待ち受けポート。 */
  readonly port: number;
  /**
   * ペアリング受付を開く。開いている間の再操作は期限を更新しない。
   *
   * @returns 開いた後（または既に開いていた場合）の状態。
   */
  openAcceptance(): AcceptanceInfo;
  /**
   * ペアリング受付を閉じる。開始待ち・承認待ちを終了し、認可済みは維持する。
   */
  closeAcceptance(): void;
  /** 現在の受付状態。 */
  getAcceptance(): AcceptanceInfo;
  /** 生存中の保留一覧。期限切れ・失効世代は除く。 */
  listPending(): readonly PendingPairingInfo[];
  /**
   * 保留を承認する。要求 ID と比較コードの両方を照合し、その要求だけ認可する。
   *
   * WebSocket 経路からは呼べない境界に置くこと。承認成功は相手への
   * `auth_ok` 到達を保証しない。
   *
   * @param requestId - 承認する要求の識別子。
   * @param code - 照合する比較コード（文字列のまま、先頭ゼロ保持）。
   * @returns 承認結果。
   */
  approvePairing(requestId: string, code: string): ApprovalResult;
  /**
   * 保留を取り下げる。対象の接続を終了する。
   *
   * @param requestId - 取り下げる要求の識別子。
   * @returns 拒否結果。
   */
  rejectPairing(requestId: string): RejectionResult;
  /**
   * 管理境界の通知を受け取る。
   *
   * @param listener - 保留の増減・受付の開閉時に呼ぶ処理。例外を投げないこと。
   * @returns 登録解除関数。
   */
  onManagementEvent(listener: ManagementListener): Unsubscribe;
  /** 現在の接続数。閉塞中も物理切断まで数える。 */
  getConnectionCount(): number;
  /** 接続一覧。接続ID・Origin・認証状態のみ含み、比較コードは含めない。 */
  listConnections(): readonly ConnectionInfo[];
  /**
   * 指定接続だけを切断する。
   *
   * 切断後は当該接続の業務メッセージを受理せず、認可状態を破棄する。
   * 待ち受けと他接続は維持する。close は `1008`・固定 reason
   * `operator disconnect` とし、応答しない相手は有限時間で強制終了する。
   * 排出待ちはせず即時に閉じる。未決着送信の拒否は transport（B2/B3）に委ねる。
   *
   * @param connectionId - `listConnections` で得た接続ID。
   * @throws `RangeError` — 不明な接続IDの場合。全接続切断へは fallback しない。
   */
  disconnectConnection(connectionId: string): void;
  /** 直近に受信した latest 値。未受信なら `undefined`。 */
  getLatest(sessionId: SessionId): unknown;
  /** 動作カウンタの写し。 */
  getStats(): BridgeStats;
  /** 全接続を閉じて待ち受けを止める。 */
  close(): Promise<void>;
}

interface ConnectionState {
  readonly id: string;
  readonly socket: WebSocket;
  readonly origin: string;
  phase: ConnectionPhase;
  /** `closing` に入る直前に認可済みだったか。枠会計用。 */
  closingWasAuthorized: boolean;
  pendingRequestId: string | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  forceTimer: ReturnType<typeof setTimeout> | null;
  operatorDisconnected: boolean;
  /**
   * 切替中に届いた正規 binary の保持（受信順）。mux 開始後に順序どおり戻す。
   * 切替中以外では空である。
   */
  pendingBinary: Uint8Array[];
  /** 認可後の mux 包み。`authorized` と有無は一致する。 */
  authorizedConnection: AuthorizedConnection | null;
  /** mux 用の binary 適合。`switching`・`authorized` で使う。 */
  rawSocket: NodeWsSocket | null;
}

/** 運用切断の固定 reason。 */
export const OPERATOR_DISCONNECT_REASON = "operator disconnect";

/**
 * ブリッジを起動する。
 *
 * 受付は閉じた状態で起動する。ワールド側の接続は受付を開いている間だけ
 * 受け付け、比較コードの照合による承認を経て認可する。
 *
 * @param options - 待ち受け・許可 Origin・制限値の設定。
 * @returns 起動したサーバ。
 * @throws `RangeError` — ホスト・ポート・許可 Origin・制限値が不正な場合。
 * @throws `Error` — ポート競合などで待ち受けに失敗した場合。
 */
export async function createBridgeServer(options: BridgeOptions): Promise<BridgeServer> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    // loopback 以外への bind を設定段階で拒否する。
    throw new RangeError("待ち受けホストは `127.0.0.1` のみ受け付ける。");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new RangeError("ポートは 0〜65535 の整数であること。");
  }
  if (options.allowedOrigins.length === 0) {
    throw new RangeError("許可 Origin は1件以上指定すること。");
  }
  const allowedOrigins = new Set(options.allowedOrigins.map(parseAllowedOrigin));
  const limits = resolveLimits(options.limits);
  const logger: BridgeLogger = options.logger ?? defaultLogger;
  const clock: Clock =
    options.clock ??
    (options.now === undefined
      ? systemClock
      : { now: options.now, monotonic: () => systemClock.monotonic() });
  const scheduler: TimerScheduler | undefined = options.scheduler;
  const acceptance = new AcceptanceController({ limits, clock });
  const rateLimiter = new PairingRateLimiter({ limits, clock });
  // ADR: `latestMailbox` は接続をまたぐサーバ全体の記録であり、切断で消さない。
  // 論理名（SessionId）キーで最新値を保持する。
  const latestMailbox = new Map<SessionId, unknown>();
  const connections = new Set<ConnectionState>();
  const managementListeners = new Set<ManagementListener>();
  // ADR: 接続IDはプロセス内で単調に払い出し再利用しない。認証前にも付与し、
  // 比較コードやワールドIDとは無関係の管理用識別子であり、認可後は wire の
  // `connectionId` としても使う（Connection 単位認可）。
  let nextConnectionSeq = 1;
  // upgrade 許可から接続登録までの同時 upgrade で上限を超えないための予約数。
  let pendingUpgrades = 0;
  // 予約ごとの回収タイマー。許可後に `connection` が来ない handshake 失敗でも
  // 有限時間で予約を回収し、上限枠の恒久浸食を防ぐ。通常は `connection` 到達で
  // 取り消す。待ち値は新設せず既存の `pairingStartTimeoutMs` で回収する
  // （予約区間は通常ミリ秒で終わり、健全な handshake を打ち切らない範囲）。
  const pendingUpgradeTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * 予約を1件取り、未回収時の回収タイマーを仕掛ける（verifyClient 許可時）。
   *
   * 予約の取得自体は従来どおり同期的であり、同時 upgrade の上限保証は変えない。
   */
  function reserveUpgradeSlot(): void {
    pendingUpgrades += 1;
    const timer = setTimeout(() => {
      // `connection` 到達済みなら既に取り消されており、何もしない。
      if (!pendingUpgradeTimers.delete(timer)) return;
      pendingUpgrades = Math.max(0, pendingUpgrades - 1);
    }, limits.pairingStartTimeoutMs);
    timer.unref?.();
    pendingUpgradeTimers.add(timer);
  }

  /**
   * 予約を1件消費し、対応する回収タイマーを止める（`connection` 到達時）。
   *
   * 予約と到達は1対1に対応し、順序のずれがあっても件数だけを合わせる。
   */
  function consumeUpgradeReservation(): void {
    const oldest = pendingUpgradeTimers.values().next();
    if (!oldest.done) {
      clearTimeout(oldest.value);
      pendingUpgradeTimers.delete(oldest.value);
    }
    pendingUpgrades = Math.max(0, pendingUpgrades - 1);
  }
  const stats: {
    connectionsAccepted: number;
    upgradeRejected: number;
    pairingSuccess: number;
    pairingFailure: number;
    latestStored: number;
    latestDropped: number;
    diagnosticEcho: number;
    diagnosticPing: number;
    rejectionsByReason: Record<string, number>;
  } = {
    connectionsAccepted: 0,
    upgradeRejected: 0,
    pairingSuccess: 0,
    pairingFailure: 0,
    latestStored: 0,
    latestDropped: 0,
    diagnosticEcho: 0,
    diagnosticPing: 0,
    rejectionsByReason: {},
  };

  function countRejection(reason: string): void {
    stats.rejectionsByReason[reason] = (stats.rejectionsByReason[reason] ?? 0) + 1;
  }

  function emitManagement(event: ManagementEvent): void {
    for (const listener of [...managementListeners]) {
      try {
        listener(event);
      } catch {
        // 購読者の例外でサーバを壊さない。
      }
    }
  }

  // isConnectionAlive は PairingStore の承認と同期的に直列化するため、
  // ここでは例外を投げず真偽だけを返す（途中で await しない）。
  const pairing = new PairingStore({
    limits,
    clock,
    acceptance,
    isConnectionAlive: (connectionId: string) => {
      for (const state of connections) {
        if (state.id === connectionId) {
          return state.phase === "pending" && state.socket.readyState !== WebSocket.CLOSED;
        }
      }
      return false;
    },
    ...(options.generateCode === undefined ? {} : { generateCode: options.generateCode }),
  });

  /** 未認可として枠を押さえる接続数（閉塞中の未認可を含む）。予約は含まない。 */
  function unauthorizedActiveCount(): number {
    let count = 0;
    for (const state of connections) {
      if (state.phase === "awaiting_start" || state.phase === "pending") {
        count += 1;
      } else if (state.phase === "closing" && !state.closingWasAuthorized) {
        count += 1;
      }
    }
    return count;
  }

  let authority = `${LOOPBACK_HOST}:${options.port}`;

  // `path` は指定しない。ws 任せの不一致応答にせず、verifyClient 側の検証で
  // 一律に診断ログ・計数に載せる。
  const wss = new WebSocketServer({
    host,
    port: options.port,
    maxPayload: limits.maxWebSocketMessageBytes,
    verifyClient: (info, done) => {
      // 1. 接続前検証（loopback・endpoint 一致・Origin 完全一致）。
      const verdict = verifyUpgrade(
        {
          remoteAddress: info.req.socket.remoteAddress,
          host: info.req.headers.host ?? undefined,
          url: info.req.url,
          origin: info.req.headers.origin,
        },
        authority,
        allowedOrigins,
      );
      if (!verdict.ok) {
        stats.upgradeRejected += 1;
        countRejection(verdict.reason);
        logger(logEvent("upgrade_rejected", { reason: verdict.reason }));
        done(false, 403, verdict.reason);
        return;
      }
      const origin = info.req.headers.origin;
      const originText = typeof origin === "string" ? origin : "";
      // 2. 受付状態・受付期限の確認。閉なら拒否（保留・通知しない）。
      if (!acceptance.isOpen()) {
        stats.upgradeRejected += 1;
        countRejection("ACCEPTANCE_CLOSED");
        logger(logEvent("upgrade_rejected", { reason: "acceptance_closed" }));
        done(false, 403, "acceptance closed");
        return;
      }
      // 3. Origin 別・全体のレート判定（受付中に届いた upgrade 試行を計数）。
      // 許可した試行は後段の容量拒否でも履歴に残る。超過自体は追加しない。
      const rate = rateLimiter.checkAndRecord(originText);
      if (!rate.allowed) {
        stats.upgradeRejected += 1;
        countRejection(rate.reason);
        logger(logEvent("upgrade_rejected", { reason: rate.reason }));
        done(false, 429, rate.reason);
        return;
      }
      // 4. 全接続数・未認可接続数の枠確保（予約を含む）。
      if (connections.size + pendingUpgrades >= limits.maxConnections) {
        stats.upgradeRejected += 1;
        countRejection("TOO_MANY_CONNECTIONS");
        logger(logEvent("upgrade_rejected", { reason: "too_many_connections" }));
        done(false, 503, "too many connections");
        return;
      }
      if (unauthorizedActiveCount() + pendingUpgrades >= limits.maxUnauthorizedConnections) {
        stats.upgradeRejected += 1;
        countRejection("TOO_MANY_UNAUTHORIZED");
        logger(logEvent("upgrade_rejected", { reason: "too_many_unauthorized" }));
        done(false, 503, "too many unauthorized connections");
        return;
      }
      // 5. upgrade 許可。接続登録までの間に上限を超えないよう予約を持つ。
      reserveUpgradeSlot();
      done(true);
    },
  });

  // 受付クローズの drain（サーバの責務）。開始待ち・承認待ちを終了し、
  // 切替中・認可済みは対象外にする。承認と閉は同期的に直列化する。
  acceptance.onClose(() => {
    for (const state of [...connections]) {
      if (state.phase === "awaiting_start") {
        terminateConnection(state, "ACCEPTANCE_CLOSED", "受付が終了した。", undefined);
      } else if (state.phase === "pending") {
        terminateConnection(
          state,
          "ACCEPTANCE_CLOSED",
          "受付が終了した。",
          state.pendingRequestId ?? undefined,
        );
      }
    }
    emitManagement({ kind: "acceptance-changed", state: "closed" });
  });

  // ws の `path` 指定は不一致を黙って通す場合があるため、念のため接続時にも
  // 接続元と `Origin` を再確認する。多層防御であり正本の検証は verifyClient 側である。
  wss.on("connection", (socket: WebSocket, req) => {
    consumeUpgradeReservation();
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : "";
    if (!isLoopbackAddress(req.socket.remoteAddress) || !allowedOrigins.has(origin)) {
      try {
        socket.close(1008, "policy violation");
      } catch {
        // 閉塞時の例外は無視し破棄を優先する。
      }
      return;
    }
    const state: ConnectionState = {
      id: `conn-${nextConnectionSeq++}`,
      socket,
      origin,
      phase: "awaiting_start",
      closingWasAuthorized: false,
      pendingRequestId: null,
      startTimer: null,
      expiryTimer: null,
      forceTimer: null,
      operatorDisconnected: false,
      pendingBinary: [],
      authorizedConnection: null,
      rawSocket: null,
    };
    connections.add(state);
    stats.connectionsAccepted += 1;
    logger(logEvent("connection_accepted", { connectionId: state.id, origin }));

    // awaiting_start の期限。
    state.startTimer = setTimeout(() => {
      state.startTimer = null;
      if (state.phase === "awaiting_start") {
        terminateConnection(
          state,
          "PAIRING_START_TIMEOUT",
          "開始メッセージが時間内に届かない。",
          undefined,
        );
      }
    }, limits.pairingStartTimeoutMs);
    state.startTimer.unref?.();

    // ADR: 受信入口は一つにし、`isBinary` で text/binary を分ける。
    // `typeof data` では判別しない（text も Buffer で届く）。
    socket.on("message", (data: RawData, isBinary: boolean) => {
      handleSocketMessage(state, data, isBinary);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      const wasAuthorized = state.phase === "authorized" || state.phase === "switching";
      // 切替中の保持は破棄し、認可は失効する。
      if (state.authorizedConnection !== null) {
        const conn = state.authorizedConnection;
        state.authorizedConnection = null;
        try {
          conn.terminate(new Error("ws closed"));
        } catch {
          // 終端の失敗は無視する。
        }
      }
      state.pendingBinary.length = 0;
      cleanupConnection(state, "disconnected");
      logger(
        logEvent("connection_closed", {
          code,
          reason: reason.toString("utf-8"),
          authorized: wasAuthorized,
        }),
      );
    });
    socket.on("error", () => {
      logger(logEvent("connection_error", {}));
    });
  });

  /** text 受信値を文字列へ復元する（認可前専用）。 */
  function rawToText(data: RawData): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
    return Buffer.from(data as ArrayBuffer).toString("utf-8");
  }

  /** binary 受信値を複写した `Uint8Array` へ変換する。 */
  function rawToBytes(data: RawData): Uint8Array {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (Buffer.isBuffer(data)) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
    const view = data as ArrayBuffer;
    return new Uint8Array(view.slice(0));
  }

  function closeSocket(state: ConnectionState, code: number, reason: string): void {
    try {
      state.socket.close(code, reason);
    } catch {
      // 閉塞時の例外は無視する。
    }
  }

  /** 有限時間で応答しない相手を強制終了する予約を仕掛ける。 */
  function armForceClose(state: ConnectionState): void {
    if (state.forceTimer !== null) {
      clearTimeout(state.forceTimer);
    }
    state.forceTimer = setTimeout(() => {
      state.forceTimer = null;
      // CLOSED 到達済みは何もしない。応答せず CLOSING/OPEN に留まる相手を切り捨てる。
      if (state.socket.readyState === WebSocket.CLOSED) return;
      try {
        state.socket.terminate();
      } catch {
        // 閉塞時の例外は無視する。
      }
    }, limits.connectionCloseGraceMs);
    state.forceTimer.unref?.();
  }

  /** 認可前の明示エラーを text で送る。送出失敗は無視する。 */
  function sendPreAuthError(
    state: ConnectionState,
    code: string,
    message: string,
    requestId: string | undefined,
  ): void {
    const text = stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
    } satisfies BridgeToClientMessage);
    try {
      state.socket.send(text);
    } catch {
      // 閉塞中の送信失敗は無視する。
    }
  }

  /**
   * 終端エラー付きで接続を閉塞状態へ移す。冪等であり、配送失敗でも巻き戻さない。
   *
   * 認可前は `error` を text で送ってから `1008` で閉じる。切替中・認可後の
   * binary 相では text を送らず `1008` で閉じる（binary 列を汚さない）。
   * 物理切断まで枠を保持する。
   */
  function terminateConnection(
    state: ConnectionState,
    code: string,
    message: string,
    requestId: string | undefined,
  ): void {
    if (state.phase === "closing" || state.phase === "closed") return;
    const wasAuthorized = state.phase === "authorized" || state.phase === "switching";
    state.closingWasAuthorized = wasAuthorized;
    const hadPending = state.phase === "pending" ? state.pendingRequestId : null;
    state.phase = "closing";
    if (state.startTimer !== null) {
      clearTimeout(state.startTimer);
      state.startTimer = null;
    }
    if (state.expiryTimer !== null) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    state.pendingBinary.length = 0;
    if (state.authorizedConnection !== null) {
      const conn = state.authorizedConnection;
      state.authorizedConnection = null;
      try {
        conn.terminate(new Error(code));
      } catch {
        // 終端の失敗は無視する。
      }
    }
    state.rawSocket = null;
    if (!wasAuthorized) {
      stats.pairingFailure += 1;
      countRejection(code);
      logger(logEvent("pairing_failure", { reason: code }));
    }
    // 保留の論理的終了。失効世代の掃除で既に消えていても冪等に扱う。
    if (hadPending !== null) {
      pairing.remove(hadPending);
      emitManagement({ kind: "pending-ended", requestId: hadPending, reason: code });
      state.pendingRequestId = null;
    }
    if (!wasAuthorized) {
      sendPreAuthError(state, code, message, requestId);
    }
    closeSocket(state, 1008, wasAuthorized ? code : code);
    armForceClose(state);
  }

  /**
   * 認可後の送信失敗・mux 異常などで閉塞へ移す（枠は物理切断まで保持）。
   *
   * 受信処理を止め、応答しない相手は有限時間で強制終了する。
   */
  function terminateWithClose(state: ConnectionState, code: number, reason: string): void {
    if (state.phase === "closing" || state.phase === "closed") return;
    state.closingWasAuthorized = state.phase === "authorized" || state.phase === "switching";
    state.phase = "closing";
    if (state.startTimer !== null) {
      clearTimeout(state.startTimer);
      state.startTimer = null;
    }
    if (state.expiryTimer !== null) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    state.pendingBinary.length = 0;
    if (state.authorizedConnection !== null) {
      const conn = state.authorizedConnection;
      state.authorizedConnection = null;
      try {
        conn.terminate(new Error(reason));
      } catch {
        // 終端の失敗は無視する。
      }
    }
    state.rawSocket = null;
    closeSocket(state, code, reason);
    armForceClose(state);
  }

  function clearTimers(state: ConnectionState): void {
    if (state.startTimer !== null) {
      clearTimeout(state.startTimer);
      state.startTimer = null;
    }
    if (state.expiryTimer !== null) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    if (state.forceTimer !== null) {
      clearTimeout(state.forceTimer);
      state.forceTimer = null;
    }
  }

  function cleanupConnection(state: ConnectionState, reason: string): void {
    clearTimers(state);
    // 切断で保留は失効する（承認後の再利用・復活をさせない）。
    if (state.pendingRequestId !== null) {
      const requestId = state.pendingRequestId;
      state.pendingRequestId = null;
      pairing.remove(requestId);
      emitManagement({ kind: "pending-ended", requestId, reason });
    }
    state.pendingBinary.length = 0;
    state.authorizedConnection = null;
    state.rawSocket = null;
    state.phase = "closed";
    connections.delete(state);
  }

  /**
   * 運用指示で指定接続だけを切断する。
   *
   * 当該接続の業務受理を止め、認可状態を破棄して `1008` で閉じる。
   * 待ち受けと他接続は維持する。排出待ちはせず即時に閉じ、
   * 応答しない相手は有限時間で強制終了する。
   */
  function operatorDisconnect(state: ConnectionState): void {
    if (state.phase === "closing" || state.phase === "closed" || state.operatorDisconnected) return;
    state.operatorDisconnected = true;
    state.closingWasAuthorized = state.phase === "authorized" || state.phase === "switching";
    const hadPending = state.phase === "pending" ? state.pendingRequestId : null;
    state.phase = "closing";
    if (state.startTimer !== null) {
      clearTimeout(state.startTimer);
      state.startTimer = null;
    }
    if (state.expiryTimer !== null) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    if (hadPending !== null) {
      pairing.remove(hadPending);
      emitManagement({
        kind: "pending-ended",
        requestId: hadPending,
        reason: "operator disconnect",
      });
      state.pendingRequestId = null;
    }
    state.pendingBinary.length = 0;
    if (state.authorizedConnection !== null) {
      const conn = state.authorizedConnection;
      state.authorizedConnection = null;
      state.rawSocket = null;
      try {
        conn.disconnect(OPERATOR_DISCONNECT_REASON);
      } catch {
        // 切断の失敗は無視する。
      }
      logger(logEvent("operator_disconnect", { connectionId: state.id }));
      return;
    }
    state.rawSocket = null;
    logger(logEvent("operator_disconnect", { connectionId: state.id }));
    closeSocket(state, 1008, OPERATOR_DISCONNECT_REASON);
    armForceClose(state);
  }

  /**
   * 単一の受信入口。`isBinary` で text/binary を分け、状態で処理を変える。
   *
   * - 認可前（`awaiting_start`・`pending`）は text のみ受理し、binary は境界違反で終了する。
   * - 切替中は binary を保持し、text は境界違反で終了する。
   * - mux 中（`authorized`）は binary のみ mux へ流し、text は境界違反で終了する。
   */
  function handleSocketMessage(state: ConnectionState, data: RawData, isBinary: boolean): void {
    // ADR: 受信上限は `ws` の `maxPayload`（WS メッセージのバイト数、
    // 分割フレーム合算）に委ね、超過時は close 1009 で通知する。
    // 到達不能な自前の長さ判定は置かない。
    // 閉塞中は受信処理をしない。物理切断まで枠を保持する。
    if (state.phase === "closing" || state.phase === "closed") return;
    // 運用切断の指示後は当該接続の業務メッセージを受理しない。
    if (state.operatorDisconnected) return;
    if (state.phase === "switching") {
      if (isBinary) {
        // ADR: 切替中に届く正規 binary を失わない。mux 開始後に順序どおり戻す。
        state.pendingBinary.push(rawToBytes(data));
        return;
      }
      // 切替中の text（重複 `auth_ok` を含む）は境界違反として終了する。
      terminateWithClose(state, 1008, "PROTOCOL_VIOLATION");
      return;
    }
    if (state.phase === "authorized") {
      if (!isBinary) {
        // mux 移行後の text は境界違反として終了する（binary 列を汚さない）。
        terminateWithClose(state, 1008, "PROTOCOL_VIOLATION");
        return;
      }
      const raw = state.rawSocket;
      if (raw === null) {
        terminateWithClose(state, 1011, "mux missing");
        return;
      }
      raw.receiveBytes(rawToBytes(data));
      return;
    }
    // 認可前は text のみ受理する。
    if (isBinary) {
      // ADR: 認可前の binary は推測判別せず境界違反として終了する。
      terminateConnection(state, "UNEXPECTED_BINARY", "認可前は text のみ受け付ける。", undefined);
      return;
    }
    const text = rawToText(data);
    let parsed: ReturnType<typeof parseBridgeMessage>;
    try {
      parsed = parseBridgeMessage(text);
    } catch (error) {
      const detail = error instanceof ProtocolError ? error.code : "INVALID_MESSAGE";
      // 認証前は終端エラーとし、入力再試行を許さない。
      terminateConnection(state, detail, "受信メッセージが不正である。", undefined);
      return;
    }
    handlePairingMessage(state, parsed);
  }

  /**
   * 認証前の受信を処理する。受理するのは `pairing_start` のみである。
   *
   * 2回目の開始は終了し、業務メッセージは未認可として終了する。
   * JSON 不正・版不一致・逆方向メッセージも終端エラーとする。
   */
  function handlePairingMessage(
    state: ConnectionState,
    parsed: ReturnType<typeof parseBridgeMessage>,
  ): void {
    if (parsed.type !== "pairing_start") {
      switch (parsed.type) {
        case "pairing_pending":
        case "auth_ok":
        case "error":
          // 逆方向の型は認証前も受け付けず、1回で終了する。
          terminateConnection(
            state,
            "UNEXPECTED_DIRECTION",
            "その方向のメッセージは受け付けない。",
            undefined,
          );
          return;
        case "create_session":
        case "data":
          terminateConnection(
            state,
            "NOT_AUTHORIZED",
            "認可前に業務メッセージは送れない。",
            undefined,
          );
          return;
        default:
          terminateConnection(state, "UNKNOWN_TYPE", "未知のメッセージ種別である。", undefined);
          return;
      }
    }
    // 6. `pairing_start` 受信時に保留枠・期限を確認してコード発行する。
    if (state.phase !== "awaiting_start") {
      // 2回目の開始はコード再生成・再通知・期限延長をしない。
      terminateConnection(
        state,
        "DUPLICATE_PAIRING_START",
        "開始メッセージは接続につき1回である。",
        undefined,
      );
      return;
    }
    const result = pairing.create(state.id, state.origin);
    if (result.status === "CREATED") {
      state.phase = "pending";
      state.pendingRequestId = result.requestId;
      if (state.startTimer !== null) {
        clearTimeout(state.startTimer);
        state.startTimer = null;
      }
      // ADR: 単調時計は小数を返す場合があり、残時間も小数になる。
      // wire 形式は正の整数を要求するため、切り上げて正規化する。
      // 切り捨てでは 1ms 未満の残時間が 0 になり検証を満たさない。
      const expiresInMs = Math.max(1, Math.ceil(result.expiresInMs));
      // 保留の失効は PairingStore 側で成立する。サーバは配送・切断を担う。
      state.expiryTimer = setTimeout(() => {
        state.expiryTimer = null;
        if (state.phase === "pending" && state.pendingRequestId === result.requestId) {
          terminateConnection(
            state,
            "PAIRING_EXPIRED",
            "ペアリング要求の期限が過ぎた。",
            result.requestId,
          );
        }
      }, expiresInMs);
      state.expiryTimer.unref?.();
      // 比較コードは直接送り、ログには出さない。
      try {
        state.socket.send(
          stringifyBridgeMessage({
            v: PROTOCOL_VERSION,
            type: "pairing_pending",
            requestId: result.requestId,
            code: result.code,
            expiresAt: result.expiresAt,
            expiresInMs,
          }),
        );
      } catch {
        terminateWithClose(state, 1011, "send failure");
        return;
      }
      logger(logEvent("pairing_pending", { connectionId: state.id, origin: state.origin }));
      emitManagement({
        kind: "pending-created",
        requestId: result.requestId,
        connectionId: state.id,
        origin: state.origin,
      });
      return;
    }
    if (result.status === "ALREADY_PENDING") {
      terminateConnection(
        state,
        "DUPLICATE_PAIRING_START",
        "開始メッセージは接続につき1回である。",
        undefined,
      );
      return;
    }
    const message =
      result.status === "ACCEPTANCE_CLOSED"
        ? "受付が閉じている。"
        : result.status === "PENDING_FULL"
          ? "承認待ちが満杯である。"
          : "比較コードを生成できない。";
    terminateConnection(state, result.status, message, undefined);
  }

  /**
   * 承認成功時に `auth_ok` を text で送り、完了で mux を開始する。
   *
   * `ws.send` callback の成功で binary 出力を解放し、`Connection` を作る。
   * 送信失敗・mux 初期化失敗・途中切断は Connection 終端とする。
   */
  function beginSwitch(state: ConnectionState, requestId: string): void {
    state.phase = "switching";
    state.pendingBinary.length = 0;
    const text = stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "auth_ok",
      requestId,
      connectionId: state.id,
    } satisfies BridgeToClientMessage);
    try {
      state.socket.send(text, (error?: Error) => {
        if (state.phase !== "switching") return;
        if (state.socket.readyState !== WebSocket.OPEN) {
          // 途中切断は Connection 終端とする。
          terminateWithClose(state, 1011, "switch aborted");
          return;
        }
        if (error !== undefined && error !== null) {
          terminateWithClose(state, 1011, "send failure");
          return;
        }
        startMux(state);
      });
    } catch {
      terminateWithClose(state, 1011, "send failure");
    }
  }

  /**
   * mux を開始する。失敗時は Connection 終端とする。
   *
   * `NodeWsSocket`＋`WsMessageStream`＋`AuthorizedConnection`（role `"server"`、
   * keepalive 組み込み）を作り、切替中の保持 binary を順序どおり戻す。
   */
  function startMux(state: ConnectionState): void {
    let raw: NodeWsSocket;
    let conn: AuthorizedConnection;
    try {
      raw = new NodeWsSocket(state.socket);
      conn = new AuthorizedConnection({
        connectionId: state.id,
        socket: state.socket,
        rawSocket: raw,
        closeGraceMs: limits.connectionCloseGraceMs,
        ...(scheduler === undefined ? {} : { scheduler }),
        host: {
          storeLatest: (sessionId, payload) => {
            stats.latestStored += 1;
            latestMailbox.set(sessionId, payload);
          },
          recordLatestDropped: (delta) => {
            stats.latestDropped += delta;
          },
          recordDiagnosticEcho: () => {
            stats.diagnosticEcho += 1;
          },
          recordDiagnosticPing: () => {
            stats.diagnosticPing += 1;
          },
          onClosed: (connection, cause) => {
            // 管理一覧からの除外。切断で認可は失効する。
            if (state.authorizedConnection === connection) {
              state.authorizedConnection = null;
              state.rawSocket = null;
            }
            if (state.phase === "authorized") {
              state.phase = "closing";
              state.closingWasAuthorized = true;
              if (state.socket.readyState === WebSocket.OPEN) {
                try {
                  state.socket.close(1008, cause.message.slice(0, 123));
                } catch {
                  // 閉塞時の例外は無視する。
                }
              }
              armForceClose(state);
            }
            logger(logEvent("authorized_closed", { connectionId: state.id }));
          },
        },
      });
    } catch {
      terminateWithClose(state, 1011, "mux failure");
      return;
    }
    state.rawSocket = raw;
    state.authorizedConnection = conn;
    state.phase = "authorized";
    logger(logEvent("pairing_approved", { connectionId: state.id }));
    // 切替中の保持を順序どおり戻す。
    const held = state.pendingBinary.splice(0, state.pendingBinary.length);
    for (const bytes of held) {
      if (state.phase !== "authorized") return;
      raw.receiveBytes(bytes);
    }
  }

  function findById(connectionId: string): ConnectionState | undefined {
    for (const state of connections) {
      if (state.id === connectionId) return state;
    }
    return undefined;
  }

  function findByPendingRequestId(requestId: string): ConnectionState | undefined {
    for (const state of connections) {
      if (state.phase === "pending" && state.pendingRequestId === requestId) return state;
    }
    return undefined;
  }

  function toAcceptanceInfo(): AcceptanceInfo {
    const status = acceptance.get();
    return { state: status.state, endsAt: status.endsAt, remainingMs: status.remainingMs };
  }

  await new Promise<void>((resolve, reject) => {
    wss.on("listening", () => {
      // 実際に bind した authority を確定させ、Host 検証に使う。
      const address = wss.address();
      if (address !== null && typeof address !== "string") {
        authority = `${address.address}:${address.port}`;
      }
      resolve();
    });
    wss.on("error", (error: Error) => {
      reject(error);
    });
  });

  const address = wss.address();
  const actualPort = address !== null && typeof address !== "string" ? address.port : options.port;
  logger(
    logEvent("listening", {
      host,
      port: actualPort,
      path: BRIDGE_PATH,
      origins: allowedOrigins.size,
    }),
  );

  return {
    endpoint: `ws://${LOOPBACK_HOST}:${actualPort}${BRIDGE_PATH}`,
    port: actualPort,
    openAcceptance: (): AcceptanceInfo => {
      const status = acceptance.open();
      logger(logEvent("acceptance_opened", { endsAt: status.endsAt }));
      emitManagement({ kind: "acceptance-changed", state: status.state });
      return { state: status.state, endsAt: status.endsAt, remainingMs: status.remainingMs };
    },
    closeAcceptance: (): void => {
      acceptance.close();
      // 論理的終了と drain は `onClose` 購読で同期的に成立する。
      // 既に閉じていた場合の通知は送らない。
    },
    getAcceptance: (): AcceptanceInfo => toAcceptanceInfo(),
    listPending: (): readonly PendingPairingInfo[] =>
      pairing.list().map((entry) => ({
        requestId: entry.requestId,
        connectionId: entry.connectionId,
        origin: entry.origin,
        code: entry.code,
        issuedAt: entry.issuedAt,
        expiresAt: entry.expiresAt,
        remainingMs: entry.remainingMs,
      })),
    approvePairing: (requestId: string, code: string): ApprovalResult => {
      // 承認と閉は同期的に直列化する。承認成功なら切替開始まで確定する。
      const result = pairing.approve(requestId, code);
      if (result.status === "APPROVED") {
        const state = findById(result.connectionId);
        if (
          state === undefined ||
          state.phase !== "pending" ||
          state.pendingRequestId !== requestId
        ) {
          // 承認と切断が交差した。保留は既に消えている。
          stats.pairingFailure += 1;
          countRejection("CONNECTION_GONE");
          return { status: "CONNECTION_GONE" };
        }
        state.pendingRequestId = null;
        if (state.expiryTimer !== null) {
          clearTimeout(state.expiryTimer);
          state.expiryTimer = null;
        }
        stats.pairingSuccess += 1;
        emitManagement({ kind: "pending-ended", requestId, reason: "approved" });
        // ADR: `auth_ok` は text で送り、完了で mux を開始する。`window` は載せない。
        // 推測判別・0.2 フォールバックは作らない。
        beginSwitch(state, requestId);
        return { status: "APPROVED", connectionId: result.connectionId, origin: result.origin };
      }
      if (result.status === "INVALID_CODE" || result.status === "CODE_MISMATCH") {
        // 保留は残る。人間が正しいコードで再試行できる。
        stats.pairingFailure += 1;
        countRejection(result.status);
        return result;
      }
      if (result.status === "NOT_PENDING") {
        stats.pairingFailure += 1;
        countRejection("NOT_PENDING");
        return result;
      }
      // PAIRING_EXPIRED・CONNECTION_GONE・CONNECTION_CHECK_ERROR・
      // ACCEPTANCE_CLOSED: 対象の保留は終わっている。残存する承認待ちを閉じる。
      stats.pairingFailure += 1;
      countRejection(result.status);
      const orphan = findByPendingRequestId(requestId);
      if (orphan !== undefined) {
        const message =
          result.status === "PAIRING_EXPIRED"
            ? "ペアリング要求の期限が過ぎた。"
            : result.status === "ACCEPTANCE_CLOSED"
              ? "受付が終了した。"
              : "接続が失われた。";
        terminateConnection(orphan, result.status, message, requestId);
      }
      return result;
    },
    rejectPairing: (requestId: string): RejectionResult => {
      const result = pairing.reject(requestId);
      if (result.status === "REJECTED") {
        const state = findByPendingRequestId(requestId);
        if (state !== undefined) {
          terminateConnection(state, "PAIRING_REJECTED", "ペアリング要求を取り下げた。", requestId);
        } else {
          emitManagement({ kind: "pending-ended", requestId, reason: "rejected" });
        }
      }
      return result;
    },
    onManagementEvent: (listener: ManagementListener): Unsubscribe => {
      managementListeners.add(listener);
      return () => {
        managementListeners.delete(listener);
      };
    },
    getConnectionCount: () => connections.size,
    listConnections: (): readonly ConnectionInfo[] =>
      [...connections].map((state) => ({
        connectionId: state.id,
        origin: state.origin,
        authorized:
          (state.phase === "authorized" || state.phase === "switching") &&
          !state.operatorDisconnected,
        phase: state.phase === "closed" ? "closed" : state.phase,
      })),
    disconnectConnection: (connectionId: string): void => {
      for (const state of connections) {
        if (state.id === connectionId) {
          operatorDisconnect(state);
          return;
        }
      }
      // ADR: 不明IDで全切断へ fallback しない。呼び出し側へ明示する。
      throw new RangeError(`不明な接続IDである: ${connectionId}`);
    },
    getLatest: (sessionId: SessionId): unknown => latestMailbox.get(sessionId),
    getStats: (): BridgeStats => ({
      connectionsAccepted: stats.connectionsAccepted,
      upgradeRejected: stats.upgradeRejected,
      pairingSuccess: stats.pairingSuccess,
      pairingFailure: stats.pairingFailure,
      latestStored: stats.latestStored,
      latestDropped: stats.latestDropped,
      diagnosticEcho: stats.diagnosticEcho,
      diagnosticPing: stats.diagnosticPing,
      rejectionsByReason: { ...stats.rejectionsByReason },
    }),
    close: (): Promise<void> => {
      for (const timer of pendingUpgradeTimers) {
        clearTimeout(timer);
      }
      pendingUpgradeTimers.clear();
      pendingUpgrades = 0;
      for (const state of connections) {
        clearTimers(state);
        if (state.authorizedConnection !== null) {
          try {
            state.authorizedConnection.terminate(new Error("bridge shutdown"));
          } catch {
            // 終端の失敗は無視する。
          }
        }
        try {
          state.socket.close(1001, "bridge shutdown");
        } catch {
          // 閉塞時の例外は無視する。
        }
      }
      logger(logEvent("shutdown", {}));
      return new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    },
  };
}
