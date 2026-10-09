/**
 * PC上で動く中継（WebSocket サーバ）。
 *
 * `127.0.0.1` に明示 bind し、`0.0.0.0`/`::` には bind しない。昇格前の検証、
 * CLI ペアリングによる認証、認証後の echo 応答、流れ制御の枠組み（有限キュー、
 * クレジット、latest 受信箱、制御優先の配送順、最大長、切断時破棄）を担う。
 * 上位層（AI 連携・RPC・プラグイン）は扱わない。
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
import { defaultLogger, logEvent, type BridgeLogger } from "./log.ts";
import { PairingStore, type IssuedPairing } from "./pairing.ts";
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
  /** 現在時刻（ミリ秒）。試験で差し替えできる。 */
  readonly now?: () => number;
}

/** 計測の土台になる動作カウンタ。 */
export interface BridgeStats {
  readonly connectionsAccepted: number;
  readonly upgradeRejected: number;
  readonly authSuccess: number;
  readonly authFailure: number;
  readonly echoCount: number;
  readonly commandCount: number;
  readonly latestStored: number;
  readonly latestDropped: number;
  readonly queueFull: number;
}

/** 接続単位の公開情報。秘密値とは無関係。 */
export interface ConnectionInfo {
  /** 接続受付時に払い出す識別子。未認証接続にも付与し、再利用しない。 */
  readonly connectionId: string;
  /** 接続時の `Origin`。 */
  readonly origin: string;
  /** 認証済みか。 */
  readonly authorized: boolean;
}

/** 起動中のブリッジ。 */
export interface BridgeServer {
  /** 正規の接続先（例: `ws://127.0.0.1:3100/v1`）。 */
  readonly endpoint: string;
  /** 実際の待ち受けポート。 */
  readonly port: number;
  /**
   * ペアリング秘密値を発行する。
   *
   * 秘密値は戻り値でのみ手渡しし、ログ・URL には出さない。
   */
  issuePairing(origin: string): IssuedPairing;
  /** 現在の接続数。 */
  getConnectionCount(): number;
  /** 接続一覧。接続ID・Origin・認証状態のみ含み、秘密値は含めない。 */
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
  authorized: boolean;
  sessionId: string | null;
  authAttempts: number;
  authTimer: ReturnType<typeof setTimeout> | null;
  forceTimer: ReturnType<typeof setTimeout> | null;
  operatorDisconnected: boolean;
  expectedSeq: Map<StreamId, number>;
  latestSeq: Map<StreamId, number>;
  controlQueue: string[];
  responseQueue: Array<{ readonly text: string; readonly bytes: number }>;
  queuedBytes: number;
  // クレジット会計（接続単位・全 reliable ストリーム共通）。
  // C（件数容量）= limits.maxReliableQueueMessages に対し、
  // 常に (grantedTotal − consumedTotal) + heldCount <= C を保つ。
  // grantedTotal: 累積付与件数、consumedTotal: 消費済み受信件数、
  // heldCount: 受信済みで容量未解放の件数（未送信・送信中の応答を含む）。
  grantedTotal: number;
  consumedTotal: number;
  heldCount: number;
  advertisedLimit: number;
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

/** 運用切断で応答しない相手を強制終了するまでの時間（ミリ秒）。 */
export const OPERATOR_DISCONNECT_GRACE_MS = 1_000;

/**
 * ブリッジを起動する。
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
  const pairing = new PairingStore(options.now);
  const latestMailbox = new Map<StreamId, { seq: number; payload: unknown }>();
  const connections = new Set<ConnectionState>();
  // ADR: 接続IDはプロセス内で単調に払い出し再利用しない。認証前にも付与し、
  // 秘密値やワールドIDとは無関係の管理用識別子として扱う。
  let nextConnectionSeq = 1;
  const stats: Record<keyof BridgeStats, number> = {
    connectionsAccepted: 0,
    upgradeRejected: 0,
    authSuccess: 0,
    authFailure: 0,
    echoCount: 0,
    commandCount: 0,
    latestStored: 0,
    latestDropped: 0,
    queueFull: 0,
  };

  let authority = `${LOOPBACK_HOST}:${options.port}`;

  // `path` は指定しない。ws 任せの不一致応答にせず、verifyClient 側の検証で
  // 一律 403・診断ログ・計数に載せる。
  const wss = new WebSocketServer({
    host,
    port: options.port,
    maxPayload: limits.maxMessageBytes,
    verifyClient: (info, done) => {
      if (connections.size >= limits.maxConnections) {
        stats.upgradeRejected += 1;
        logger(logEvent("upgrade_rejected", { reason: "too_many_connections" }));
        done(false, 503, "too many connections");
        return;
      }
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
        logger(logEvent("upgrade_rejected", { reason: verdict.reason }));
        done(false, 403, verdict.reason);
        return;
      }
      done(true);
    },
  });

  // ws の `path` 指定は不一致を黙って通す場合があるため、念のため接続時にも
  // 接続元と `Origin` を再確認する。多層防御であり正本の検証は verifyClient 側である。
  wss.on("connection", (socket: WebSocket, req) => {
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
      authorized: false,
      sessionId: null,
      authAttempts: 0,
      authTimer: null,
      forceTimer: null,
      operatorDisconnected: false,
      expectedSeq: new Map(),
      latestSeq: new Map(),
      controlQueue: [],
      responseQueue: [],
      queuedBytes: 0,
      grantedTotal: 0,
      consumedTotal: 0,
      heldCount: 0,
      advertisedLimit: 0,
      flushScheduled: false,
    };
    connections.add(state);
    stats.connectionsAccepted += 1;
    logger(logEvent("connection_accepted", { connectionId: state.id, origin }));

    state.authTimer = setTimeout(() => {
      state.authTimer = null;
      if (!state.authorized) {
        sendError(state, "AUTH_TIMEOUT", "認証が時間内に完了しない。", undefined, true);
        stats.authFailure += 1;
        logger(logEvent("auth_failure", { reason: "timeout" }));
        closeSocket(state, 1008, "auth timeout");
      }
    }, limits.authTimeoutMs);

    socket.on("message", (data: RawData) => {
      handleMessage(state, rawToText(data));
    });
    socket.on("close", (code: number, reason: Buffer) => {
      const wasAuthorized = state.authorized;
      cleanupConnection(state);
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
          closeSocket(state, 1011, "send failure");
          return;
        }
        if (isResponse) {
          state.queuedBytes = Math.max(0, state.queuedBytes - responseBytes);
          releaseHold(state);
        }
      });
    } catch {
      // 送信失敗は切断として扱い、残りは破棄する。
      state.controlQueue.length = 0;
      state.responseQueue.length = 0;
      state.queuedBytes = 0;
      closeSocket(state, 1011, "send failure");
      return;
    }
    if (state.controlQueue.length > 0 || state.responseQueue.length > 0) {
      scheduleFlush(state);
      return;
    }
  }

  /** 追加付与可能量。C − U − (G − R)。 */
  function grantableCredit(state: ConnectionState): number {
    return (
      limits.maxReliableQueueMessages - state.heldCount - (state.grantedTotal - state.consumedTotal)
    );
  }

  /**
   * 解放で生じた余裕を追加付与する。
   *
   * 付与は累積件数の通知で行い、残数の上書きはしない。同じ `limit` の再通知は
   * 権利を増やさない。送信callback完了はクライアントのアプリ処理完了を保証
   * せず、ここで保証するのはブリッジ内の受付・応答保持容量のみである。
   */
  function advertiseCredit(state: ConnectionState): void {
    if (!state.authorized) return;
    const extra = grantableCredit(state);
    if (extra <= 0) return;
    state.grantedTotal += extra;
    state.advertisedLimit = state.grantedTotal;
    try {
      state.socket.send(
        stringifyBridgeMessage({
          v: PROTOCOL_VERSION,
          type: "credit",
          sessionId: state.sessionId ?? "",
          limit: state.grantedTotal,
        }),
      );
    } catch {
      closeSocket(state, 1011, "send failure");
    }
  }

  /** 予約していた容量を解放し、生じた余裕を追加付与する。 */
  function releaseHold(state: ConnectionState): void {
    state.heldCount -= 1;
    advertiseCredit(state);
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

  function cleanupConnection(state: ConnectionState): void {
    if (state.authTimer !== null) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    if (state.forceTimer !== null) {
      clearTimeout(state.forceTimer);
      state.forceTimer = null;
    }
    state.controlQueue.length = 0;
    state.responseQueue.length = 0;
    state.queuedBytes = 0;
    state.authorized = false;
    state.sessionId = null;
    connections.delete(state);
  }

  /**
   * 運用指示で指定接続だけを切断する。
   *
   * 当該接続の業務受理を止め、認可・キュー・未完了状態を破棄して `1008` で
   * 閉じる。待ち受けと他接続は維持する。応答しない相手は有限時間で強制終了する。
   */
  function operatorDisconnect(state: ConnectionState): void {
    if (state.operatorDisconnected) return;
    state.operatorDisconnected = true;
    if (state.authTimer !== null) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    state.controlQueue.length = 0;
    state.responseQueue.length = 0;
    state.queuedBytes = 0;
    state.authorized = false;
    state.sessionId = null;
    state.expectedSeq.clear();
    state.latestSeq.clear();
    logger(logEvent("operator_disconnect", { connectionId: state.id }));
    closeSocket(state, 1008, OPERATOR_DISCONNECT_REASON);
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
    }, OPERATOR_DISCONNECT_GRACE_MS);
  }

  /** ストリーム数上限を確認する。 */
  function checkStream(state: ConnectionState, streamId: StreamId): boolean {
    if (state.expectedSeq.has(streamId)) return true;
    if (state.expectedSeq.size >= limits.maxStreamsPerConnection) return false;
    state.expectedSeq.set(streamId, 0);
    return true;
  }

  function handleMessage(state: ConnectionState, text: string | null): void {
    if (text === null) return;
    // ADR: 受信上限は `ws` の `maxPayload`（UTF-8 の JSON テキストのバイト数、
    // 分割フレーム合算）に委ね、超過時は close 1009 で通知する。JSON の
    // `MESSAGE_TOO_LARGE` や非空 reason は保証しない。到達不能な自前の長さ
    // 判定は置かない。
    // 運用切断の指示後は当該接続の業務メッセージを受理しない。
    if (state.operatorDisconnected) return;
    let parsed: ReturnType<typeof parseBridgeMessage>;
    try {
      parsed = parseBridgeMessage(text);
    } catch (error) {
      const detail = error instanceof ProtocolError ? error.code : "INVALID_MESSAGE";
      if (!state.authorized) {
        stats.authFailure += 1;
        state.authAttempts += 1;
        sendError(state, detail, "受信メッセージが不正である。", undefined, true);
        if (state.authAttempts >= limits.maxAuthAttempts) {
          closeSocket(state, 1008, "too many attempts");
        }
      } else {
        sendError(state, detail, "受信メッセージが不正である。");
      }
      return;
    }
    if (!state.authorized) {
      handleAuthMessage(state, parsed);
      return;
    }
    handleAuthorizedMessage(state, parsed);
  }

  function handleAuthMessage(
    state: ConnectionState,
    parsed: ReturnType<typeof parseBridgeMessage>,
  ): void {
    if (parsed.type !== "auth") {
      stats.authFailure += 1;
      state.authAttempts += 1;
      sendError(state, "NOT_AUTHENTICATED", "最初のメッセージで認証すること。", undefined, true);
      if (state.authAttempts >= limits.maxAuthAttempts) {
        closeSocket(state, 1008, "too many attempts");
      }
      return;
    }
    const result = pairing.consume(parsed.secret, state.origin);
    if (result.status !== "ok") {
      stats.authFailure += 1;
      state.authAttempts += 1;
      const reason =
        result.status === "expired"
          ? "秘密値の有効期限が過ぎた。"
          : result.status === "reused"
            ? "秘密値は一度だけ使用できる。"
            : result.status === "origin_mismatch"
              ? "発行時の Origin と一致しない。"
              : "未知の秘密値である。";
      sendError(state, "UNAUTHORIZED", reason, undefined, true);
      logger(logEvent("auth_failure", { reason: result.status }));
      if (state.authAttempts >= limits.maxAuthAttempts) {
        closeSocket(state, 1008, "too many attempts");
      }
      return;
    }
    state.authorized = true;
    state.sessionId = randomUUID();
    // 初期付与は累積件数として会計へ載せる。ここでは追加の credit 通知を送らず、
    // `auth_ok.window` が初期付与を担う。容量への top-up はしない。
    state.grantedTotal = limits.initialCreditWindow;
    state.advertisedLimit = limits.initialCreditWindow;
    if (state.authTimer !== null) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    stats.authSuccess += 1;
    logger(logEvent("auth_success", {}));
    enqueueControl(state, {
      v: PROTOCOL_VERSION,
      type: "auth_ok",
      sessionId: state.sessionId,
      window: limits.initialCreditWindow,
    });
  }

  function handleAuthorizedMessage(
    state: ConnectionState,
    parsed: ReturnType<typeof parseBridgeMessage>,
  ): void {
    switch (parsed.type) {
      case "auth":
      case "auth_ok":
      case "echo_response":
      case "command_response":
      case "credit":
      case "error":
        // 逆方向の型は受け付けない。
        sendError(state, "UNEXPECTED_DIRECTION", "その方向のメッセージは受け付けない。");
        return;
      case "echo":
      case "command_request":
      case "data":
        break;
      default:
        sendError(state, "UNKNOWN_TYPE", "未知のメッセージ種別である。");
        return;
    }
    if (parsed.sessionId !== state.sessionId) {
      sendError(state, "SESSION_MISMATCH", "セッション識別子が一致しない。", undefined);
      return;
    }
    const requestId = parsed.type === "data" ? undefined : parsed.requestId;
    // クレジットは接続単位・全 reliable ストリーム共通で、受け付けた reliable に
    // 対し1件消費する。latest・認証・制御フレームは消費しない。
    const consumesCredit = parsed.kind === "reliable";
    if (consumesCredit) {
      if (state.consumedTotal >= state.grantedTotal) {
        // 付与超過の reliable は業務処理前に明示拒否して切断する。
        sendError(
          state,
          "CREDIT_EXHAUSTED",
          "クレジットの付与を超えた reliable である。",
          requestId,
          true,
        );
        closeSocket(state, 1011, "credit exhausted");
        return;
      }
      state.consumedTotal += 1;
      state.heldCount += 1;
    }
    if (!checkStream(state, parsed.streamId)) {
      // 消費済みの予約は解放し、枠を永久に失わせない。
      if (consumesCredit) releaseHold(state);
      sendError(state, "STREAM_LIMIT", "ストリーム数が上限を超えた。", requestId);
      return;
    }
    if (parsed.kind === "reliable") {
      const expected = state.expectedSeq.get(parsed.streamId) ?? 0;
      if (parsed.seq !== expected) {
        // 消費済みの予約は解放し、枠を永久に失わせない。
        releaseHold(state);
        sendError(state, "UNEXPECTED_SEQ", "ストリーム内連番が期待値と一致しない。", requestId);
        return;
      }
      state.expectedSeq.set(parsed.streamId, expected + 1);
    } else {
      const last = state.latestSeq.get(parsed.streamId) ?? -1;
      if (parsed.seq < last) {
        stats.latestDropped += 1;
        return;
      }
      state.latestSeq.set(parsed.streamId, parsed.seq);
    }
    if (parsed.type === "echo") {
      stats.echoCount += 1;
      const text = stringifyBridgeMessage({
        v: PROTOCOL_VERSION,
        type: "echo_response",
        sessionId: state.sessionId ?? "",
        streamId: parsed.streamId,
        kind: "reliable",
        seq: parsed.seq,
        requestId: parsed.requestId,
        payload: parsed.payload,
      });
      if (!enqueueResponse(state, text)) {
        // 消費済みの予約を解放したうえで切断し、枠を永久に失わせない。
        state.heldCount -= 1;
        sendError(state, "QUEUE_FULL", "応答キューが満杯である。", parsed.requestId, true);
        closeSocket(state, 1011, "queue full");
      }
      return;
    }
    if (parsed.type === "command_request") {
      stats.commandCount += 1;
      const known = parsed.command === "ping";
      const text = stringifyBridgeMessage(
        known
          ? {
              v: PROTOCOL_VERSION,
              type: "command_response",
              sessionId: state.sessionId ?? "",
              requestId: parsed.requestId,
              ok: true,
              result: "pong",
            }
          : {
              v: PROTOCOL_VERSION,
              type: "command_response",
              sessionId: state.sessionId ?? "",
              requestId: parsed.requestId,
              ok: false,
              error: {
                code: "UNKNOWN_COMMAND",
                message: `未知のコマンドである: ${parsed.command}`,
              },
            },
      );
      if (!enqueueResponse(state, text)) {
        // 消費済みの予約を解放したうえで切断し、枠を永久に失わせない。
        state.heldCount -= 1;
        sendError(state, "QUEUE_FULL", "応答キューが満杯である。", parsed.requestId, true);
        closeSocket(state, 1011, "queue full");
      }
      return;
    }
    stats.latestStored += 1;
    latestMailbox.set(parsed.streamId, { seq: parsed.seq, payload: parsed.payload });
    // ADR: `data(kind: reliable)` が latest 受信箱へ入る扱いは別項目として残し、
    // ここでは直さない。応答を保持しない reliable は予約を即時解放し、
    // 枠を失わせない（解放で生じた余裕は追加付与する）。
    if (consumesCredit) releaseHold(state);
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
    issuePairing: (origin: string): IssuedPairing => {
      const normalized = parseAllowedOrigin(origin);
      if (!allowedOrigins.has(normalized)) {
        throw new RangeError("発行先は許可 Origin の一覧にあること。");
      }
      const issued = pairing.issue(normalized);
      logger(logEvent("pairing_issued", { origin: normalized, expiresAt: issued.expiresAt }));
      return issued;
    },
    getConnectionCount: () => connections.size,
    listConnections: (): readonly ConnectionInfo[] =>
      [...connections].map((state) => ({
        connectionId: state.id,
        origin: state.origin,
        authorized: state.authorized && !state.operatorDisconnected,
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
    getStats: (): BridgeStats => ({ ...stats }),
    close: (): Promise<void> => {
      for (const state of connections) {
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
