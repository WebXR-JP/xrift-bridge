/**
 * PC上で動く中継（WebSocket サーバ）。
 *
 * `127.0.0.1` に明示 bind し、`0.0.0.0`/`::` には bind しない。昇格前の検証、
 * 受付モード中の比較コード方式による認可（開始待ち→承認待ち→認可）、認可後の
 * echo 応答、流れ制御の枠組み（有限キュー、クレジット、latest 受信箱、
 * 制御優先の配送順、最大長、切断時破棄）を担う。
 * 上位層（AI 連携・RPC・プラグイン）は扱わない。
 *
 * 比較コードは両画面への表示と照合にだけ使い、構造化ログ・URL・永続保存・
 * 診断 JSON には出さない。承認操作はローカル管理境界だけに置き、
 * ワールド向け WebSocket には公開しない。
 *
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseBridgeMessage,
  stringifyBridgeMessage,
  type BridgeToClientMessage,
  type StreamId,
} from "bridge-protocol";
import { resolveLimits, type BridgeLimits } from "./config.ts";
import { AuthorizedSession, type AuthorizedSessionHost } from "./authorized-session.ts";
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
  /**
   * 送信処理の差し替え点。未指定なら WebSocket へ直接送る。
   *
   * 応答の保持容量は完了通知で解放するため、差し替え実装も完了・失敗の
   * いずれかで必ず一度だけ `done` を呼ぶこと。
   */
  readonly transport?: BridgeTransport;
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
}

/** 計測の土台になる動作カウンタ。 */
export interface BridgeStats {
  readonly connectionsAccepted: number;
  readonly upgradeRejected: number;
  /** 比較コードの照合による認可成功数。 */
  readonly pairingSuccess: number;
  /** 認可前の終端拒否・承認失敗の数。 */
  readonly pairingFailure: number;
  readonly echoCount: number;
  readonly commandCount: number;
  readonly latestStored: number;
  readonly latestDropped: number;
  readonly queueFull: number;
  /** 拒否・失敗の理由別集計。upgrade 拒否とペアリング失敗の符号を数える。 */
  readonly rejectionsByReason: Readonly<Record<string, number>>;
}

/** 接続の認可段階。認可を独立 bool にせず段階で表す。 */
export type ConnectionPhase = "awaiting_start" | "pending" | "authorized" | "closing" | "closed";

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
   * 切断後は当該接続の業務メッセージを受理せず、認可・キュー・未完了状態を
   * 破棄する。待ち受けと他接続は維持する。close は `1008`・固定 reason
   * `operator disconnect` とし、応答しない相手は有限時間で強制終了する。
   *
   * @param connectionId - `listConnections` で得た接続ID。
   * @throws `RangeError` — 不明な接続IDの場合。全接続切断へは fallback しない。
   */
  disconnectConnection(connectionId: string): void;
  /** 直近に受信した latest 値。未受信なら `undefined`。 */
  getLatest(streamId: StreamId): unknown;
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
  sessionId: string | null;
  pendingRequestId: string | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  forceTimer: ReturnType<typeof setTimeout> | null;
  operatorDisconnected: boolean;
  /**
   * 認可後の受信セッション。`authorized` と有無は一致する。
   * 会計・採番・業務分岐の所有者はセッションであり、送出・切断の実体はサーバ側に置く。
   */
  session: AuthorizedSession | null;
  controlQueue: string[];
  responseQueue: Array<{ readonly text: string; readonly bytes: number }>;
  queuedBytes: number;
  flushScheduled: boolean;
}

/**
 * ブリッジ→クライアント方向の送信を担う境界。
 *
 * 既定では WebSocket へ直接送り、書出し完了（または失敗）を `done` で返す。
 * 内部試験では完了通知の保留・解放を操作するために差し替える。
 */
export interface BridgeTransport {
  /**
   * フレームを送る。
   *
   * @param socket - 送信先の接続ソケット。
   * @param text - wire 形式のメッセージ。
   * @param done - 書出し完了時は `null`、失敗時は理由で一度だけ呼ぶ。
   */
  send(socket: WebSocket, text: string, done: (error: Error | null) => void): void;
}

/** 既定の送信処理。WebSocket へ直接送る。 */
const defaultTransport: BridgeTransport = {
  send: (socket, text, done) => {
    socket.send(text, (error?: Error) => {
      done(error ?? null);
    });
  },
};

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
  const transport = options.transport ?? defaultTransport;
  const logger: BridgeLogger = options.logger ?? defaultLogger;
  const clock: Clock =
    options.clock ??
    (options.now === undefined
      ? systemClock
      : { now: options.now, monotonic: () => systemClock.monotonic() });
  const acceptance = new AcceptanceController({ limits, clock });
  const rateLimiter = new PairingRateLimiter({ limits, clock });
  const latestMailbox = new Map<StreamId, { seq: number; payload: unknown }>();
  const connections = new Set<ConnectionState>();
  const managementListeners = new Set<ManagementListener>();
  // ADR: 接続IDはプロセス内で単調に払い出し再利用しない。認証前にも付与し、
  // 比較コードやワールドIDとは無関係の管理用識別子として扱う。
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
    echoCount: number;
    commandCount: number;
    latestStored: number;
    latestDropped: number;
    queueFull: number;
    rejectionsByReason: Record<string, number>;
  } = {
    connectionsAccepted: 0,
    upgradeRejected: 0,
    pairingSuccess: 0,
    pairingFailure: 0,
    echoCount: 0,
    commandCount: 0,
    latestStored: 0,
    latestDropped: 0,
    queueFull: 0,
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
    maxPayload: limits.maxMessageBytes,
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
  // 認可済みは対象外にする。承認と閉は同期的に直列化する。
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
      sessionId: null,
      pendingRequestId: null,
      startTimer: null,
      expiryTimer: null,
      forceTimer: null,
      operatorDisconnected: false,
      session: null,
      controlQueue: [],
      responseQueue: [],
      queuedBytes: 0,
      flushScheduled: false,
    };
    connections.add(state);
    stats.connectionsAccepted += 1;
    logger(logEvent("connection_accepted", { connectionId: state.id, origin }));

    // awaiting_start の期限。ペアリング制御はクレジットを消費せず、
    // 認可前の credit はゼロのままである。
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

    socket.on("message", (data: RawData) => {
      handleMessage(state, rawToText(data));
    });
    socket.on("close", (code: number, reason: Buffer) => {
      const wasAuthorized = state.phase === "authorized";
      cleanupConnection(state, "disconnected");
      // 切断で認可は失効する。待ち行列と未完了は破棄済みである。
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

  function rawToText(data: RawData): string | null {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
    return Buffer.from(data).toString("utf-8");
  }

  function enqueueControl(state: ConnectionState, message: BridgeToClientMessage): void {
    state.controlQueue.push(stringifyBridgeMessage(message));
    scheduleFlush(state);
  }

  function enqueueResponse(state: ConnectionState, text: string): boolean {
    // ADR: 容量は UTF-8 バイトで計上する。`text.length`（UTF-16 単位）では
    // 多バイト文字の超過を見逃すため `Buffer.byteLength` で統一する。
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      state.responseQueue.length >= limits.maxReliableQueueMessages ||
      state.queuedBytes + bytes > limits.maxReliableQueueBytes
    ) {
      stats.queueFull += 1;
      logger(logEvent("queue_full", {}));
      return false;
    }
    state.responseQueue.push({ text, bytes });
    state.queuedBytes += bytes;
    scheduleFlush(state);
    return true;
  }

  function scheduleFlush(state: ConnectionState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      flush(state);
    });
  }

  function flush(state: ConnectionState): void {
    if (state.socket.readyState !== WebSocket.OPEN) {
      state.controlQueue.length = 0;
      state.responseQueue.length = 0;
      state.queuedBytes = 0;
      return;
    }
    // 制御を優先し、応答は FIFO で流す（B1 の最小配送順）。
    let next = state.controlQueue.shift();
    let responseBytes = 0;
    let isResponse = false;
    if (next === undefined) {
      const entry = state.responseQueue.shift();
      if (entry !== undefined) {
        next = entry.text;
        responseBytes = entry.bytes;
        isResponse = true;
      }
    }
    if (next === undefined) {
      return;
    }
    // ADR: 送信キューからの取出しでは容量を解放しない。未送信応答と送信中応答を
    // 容量に含め、書出し完了の通知で枠と保持バイトを解放する。通知と送信の交差は
    // 累積付与で安全にするため、完了前の追加付与は解放時の advertise に任せ、
    // ここでは送らない。
    let settled = false;
    try {
      transport.send(state.socket, next, (error) => {
        // 差し替え境界の多重通知では二重解放しない。
        if (settled) return;
        settled = true;
        if (error !== null) {
          // 送信失敗は切断として扱い、残りは破棄する。
          state.controlQueue.length = 0;
          state.responseQueue.length = 0;
          state.queuedBytes = 0;
          terminateWithClose(state, 1011, "send failure");
          return;
        }
        if (isResponse) {
          state.queuedBytes = Math.max(0, state.queuedBytes - responseBytes);
          state.session?.releaseHold();
        }
      });
    } catch {
      // 送信失敗は切断として扱い、残りは破棄する。
      state.controlQueue.length = 0;
      state.responseQueue.length = 0;
      state.queuedBytes = 0;
      terminateWithClose(state, 1011, "send failure");
      return;
    }
    if (state.controlQueue.length > 0 || state.responseQueue.length > 0) {
      scheduleFlush(state);
      return;
    }
  }

  /**
   * 認可後セッションが使う小さな操作を束ねる。`ConnectionState` 全体は渡さない。
   *
   * 送出・切断・記録の実体はサーバ側に置き、セッションは状態と判定・会計だけを持つ。
   * `latestMailbox` は接続をまたぐサーバ全体の記録であり、所有は移さず
   * 書き込み操作だけを渡す。
   */
  function createAuthorizedHost(state: ConnectionState): AuthorizedSessionHost {
    return {
      isAuthorized: () => state.phase === "authorized",
      enqueueResponse: (text) => enqueueResponse(state, text),
      sendError: (code, message, requestId?, direct = false) =>
        sendError(state, code, message, requestId, direct),
      terminate: (code, message, requestId) => terminateConnection(state, code, message, requestId),
      terminateWithClose: (code, reason) => terminateWithClose(state, code, reason),
      notifyCredit: (limit) => {
        if (state.phase !== "authorized") return;
        try {
          state.socket.send(
            stringifyBridgeMessage({
              v: PROTOCOL_VERSION,
              type: "credit",
              sessionId: state.sessionId ?? "",
              limit,
            }),
          );
        } catch {
          terminateWithClose(state, 1011, "send failure");
        }
      },
      recordEcho: () => {
        stats.echoCount += 1;
      },
      recordCommand: () => {
        stats.commandCount += 1;
      },
      recordLatestDropped: () => {
        stats.latestDropped += 1;
      },
      storeLatest: (streamId, seq, payload: unknown) => {
        stats.latestStored += 1;
        latestMailbox.set(streamId, { seq, payload });
      },
    };
  }

  function sendError(
    state: ConnectionState,
    code: string,
    message: string,
    requestId?: string,
    direct = false,
  ): void {
    const text = stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      message,
      ...(state.sessionId === null ? {} : { sessionId: state.sessionId }),
      ...(requestId === undefined ? {} : { requestId }),
    } satisfies BridgeToClientMessage);
    if (direct) {
      try {
        state.socket.send(text);
      } catch {
        // 閉塞中の送信失敗は無視する。
      }
      return;
    }
    enqueueControl(state, {
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      message,
      ...(state.sessionId === null ? {} : { sessionId: state.sessionId }),
      ...(requestId === undefined ? {} : { requestId }),
    });
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

  /**
   * 終端エラー付きで接続を閉塞状態へ移す。冪等であり、配送失敗でも巻き戻さない。
   *
   * 認可前は sessionId を含めず、ペアリングエラーには `PairingRequestId`、
   * 業務エラーには受信した業務 `requestId` をそのまま載せる。
   * 物理切断まで枠を保持する。
   */
  function terminateConnection(
    state: ConnectionState,
    code: string,
    message: string,
    requestId: string | undefined,
  ): void {
    if (state.phase === "closing" || state.phase === "closed") return;
    const wasAuthorized = state.phase === "authorized";
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
    state.controlQueue.length = 0;
    state.responseQueue.length = 0;
    state.queuedBytes = 0;
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
    sendError(state, code, message, requestId, true);
    closeSocket(state, 1008, code);
    armForceClose(state);
  }

  /**
   * 認可後の送信失敗・容量超過などで閉塞へ移す（枠は物理切断まで保持）。
   *
   * 受信処理を止め、応答しない相手は有限時間で強制終了する。
   */
  function terminateWithClose(state: ConnectionState, code: number, reason: string): void {
    if (state.phase === "closing" || state.phase === "closed") return;
    state.closingWasAuthorized = state.phase === "authorized";
    state.phase = "closing";
    if (state.startTimer !== null) {
      clearTimeout(state.startTimer);
      state.startTimer = null;
    }
    if (state.expiryTimer !== null) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
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
    state.controlQueue.length = 0;
    state.responseQueue.length = 0;
    state.queuedBytes = 0;
    state.phase = "closed";
    state.sessionId = null;
    state.session = null;
    connections.delete(state);
  }

  /**
   * 運用指示で指定接続だけを切断する。
   *
   * 当該接続の業務受理を止め、認可・キュー・未完了状態を破棄して `1008` で
   * 閉じる。待ち受けと他接続は維持する。応答しない相手は有限時間で強制終了する。
   */
  function operatorDisconnect(state: ConnectionState): void {
    if (state.phase === "closing" || state.phase === "closed" || state.operatorDisconnected) return;
    state.operatorDisconnected = true;
    state.closingWasAuthorized = state.phase === "authorized";
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
    state.controlQueue.length = 0;
    state.responseQueue.length = 0;
    state.queuedBytes = 0;
    state.sessionId = null;
    // 認可ごとのセッションを捨てることで会計・採番も作り直しになる。
    state.session = null;
    logger(logEvent("operator_disconnect", { connectionId: state.id }));
    closeSocket(state, 1008, OPERATOR_DISCONNECT_REASON);
    armForceClose(state);
  }

  function handleMessage(state: ConnectionState, text: string | null): void {
    if (text === null) return;
    // ADR: 受信上限は `ws` の `maxPayload`（UTF-8 の JSON テキストのバイト数、
    // 分割フレーム合算）に委ね、超過時は close 1009 で通知する。JSON の
    // `MESSAGE_TOO_LARGE` や非空 reason は保証しない。到達不能な自前の長さ
    // 判定は置かない。
    // 閉塞中は受信処理をしない。物理切断まで枠を保持する。
    if (state.phase === "closing" || state.phase === "closed") return;
    // 運用切断の指示後は当該接続の業務メッセージを受理しない。
    if (state.operatorDisconnected) return;
    let parsed: ReturnType<typeof parseBridgeMessage>;
    try {
      parsed = parseBridgeMessage(text);
    } catch (error) {
      const detail = error instanceof ProtocolError ? error.code : "INVALID_MESSAGE";
      if (state.phase === "authorized") {
        sendError(state, detail, "受信メッセージが不正である。");
      } else {
        // 認証前は終端エラーとし、入力再試行を許さない。
        terminateConnection(state, detail, "受信メッセージが不正である。", undefined);
      }
      return;
    }
    if (state.phase === "authorized") {
      // 認可判定は接続状態の所有者（サーバ）が行い、本体はセッションに委ねる。
      // `authorized` とセッションの有無は一致する。不一致は到達しない。
      const session = state.session;
      if (session === null) {
        sendError(state, "SESSION_MISMATCH", "セッション識別子が一致しない。", undefined);
        return;
      }
      session.handleAuthorizedMessage(parsed);
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
        case "echo_response":
        case "command_response":
        case "credit":
        case "error":
          // 逆方向の型は認証前も受け付けず、1回で終了する。
          terminateConnection(
            state,
            "UNEXPECTED_DIRECTION",
            "その方向のメッセージは受け付けない。",
            undefined,
          );
          return;
        case "echo":
        case "command_request":
          terminateConnection(
            state,
            "NOT_AUTHORIZED",
            "認可前に業務メッセージは送れない。",
            parsed.requestId,
          );
          return;
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
      // 比較コードは制御キューへ積み、ログには出さない。
      enqueueControl(state, {
        v: PROTOCOL_VERSION,
        type: "pairing_pending",
        requestId: result.requestId,
        code: result.code,
        expiresAt: result.expiresAt,
        expiresInMs,
      });
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
      // 承認と閉は同期的に直列化する。承認成功なら通知前に認可状態まで確定する。
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
        // 認可成立時のみ session を発行し、初期 credit 会計を設定する。
        // 会計・採番の実体は認可ごとの新規セッションが持つ。送出・切断の実体はサーバ側のままである。
        state.phase = "authorized";
        state.sessionId = randomUUID();
        state.session = new AuthorizedSession(
          state.sessionId,
          limits.initialCreditWindow,
          limits,
          createAuthorizedHost(state),
        );
        state.pendingRequestId = null;
        if (state.expiryTimer !== null) {
          clearTimeout(state.expiryTimer);
          state.expiryTimer = null;
        }
        stats.pairingSuccess += 1;
        logger(logEvent("pairing_approved", { connectionId: state.id }));
        emitManagement({ kind: "pending-ended", requestId, reason: "approved" });
        enqueueControl(state, {
          v: PROTOCOL_VERSION,
          type: "auth_ok",
          requestId,
          sessionId: state.sessionId,
          window: limits.initialCreditWindow,
        });
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
        authorized: state.phase === "authorized" && !state.operatorDisconnected,
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
    getLatest: (streamId: StreamId): unknown => latestMailbox.get(streamId)?.payload,
    getStats: (): BridgeStats => ({
      connectionsAccepted: stats.connectionsAccepted,
      upgradeRejected: stats.upgradeRejected,
      pairingSuccess: stats.pairingSuccess,
      pairingFailure: stats.pairingFailure,
      echoCount: stats.echoCount,
      commandCount: stats.commandCount,
      latestStored: stats.latestStored,
      latestDropped: stats.latestDropped,
      queueFull: stats.queueFull,
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
