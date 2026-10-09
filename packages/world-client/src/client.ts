/**
 * ワールド内からブリッジへ接続するためのクライアント。
 *
 * 接続はワールド起点で開始し、ブリッジが発行する比較コードを人間が
 * ブリッジ側で承認した接続だけを認可する。切断後の再送・セッション復元・
 * 自動再実行は行わない（設計どおり）。再接続には再ペアリングが必要である。
 *
 * @packageDocumentation
 */
import {
  PROTOCOL_VERSION,
  parseBridgeMessage,
  stringifyBridgeMessage,
  type BridgeToClientMessage,
  type CommandResponseMessage,
  type PairingCode,
  type PairingRequestId,
  type RequestId,
  type SessionId,
  type StreamId,
} from "bridge-protocol";
import { AuthorizedSession, type LatestSentStore } from "./authorized-session.ts";
import { WorldClientError } from "./errors.ts";
import { PairingAttempt, assertConnectTimeoutMs } from "./pairing-attempt.ts";
import { parseBridgeEndpoint } from "./endpoint.ts";

export { WorldClientError };

/** クライアントの接続状態。 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "requesting_pairing"
  | "awaiting_approval"
  | "authorized"
  | "closed";

/** クライアントが配送する通知。 */
export type WorldClientEvent =
  | { readonly kind: "state"; readonly state: ConnectionState }
  | { readonly kind: "pairing"; readonly pairing: PairingInfo | null }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string };

/** イベント購読の解除関数。 */
export type Unsubscribe = () => void;

/** イベント購読者。 */
export type WorldClientListener = (event: WorldClientEvent) => void;

/** クライアント生成時の設定。 */
export interface WorldClientOptions {
  /**
   * ブリッジの接続先。`ws://127.0.0.1:<port>/v1` のみ受け付ける。
   */
  readonly endpoint: string;
  /**
   * 送信する `Origin`。
   *
   * Node 診断用途に限定する。ブラウザでは指定せず、ブラウザが付与する
   * `Origin` を使うこと。Node では未指定だと `Origin` が送出されないため、
   * ブリッジの接続前検証を通過できない。
   */
  readonly origin?: string;
  /**
   * 要求応答の待ち時間（ミリ秒）。有限の正数。
   *
   * @defaultValue `10000`（省略時に接続処理が適用）。
   */
  readonly requestTimeoutMs?: number;
  /**
   * クレジット枯渇時に保持する reliable 待機の上限件数。
   *
   * @defaultValue `128`（省略時に接続処理が適用）。
   */
  readonly maxPendingReliable?: number;
  /**
   * 送信メッセージ1件の上限（UTF-8 にシリアライズした JSON 全体のバイト数）。
   *
   * reliable 待機への追加と `latest` 送信の受付前に検査し、超過はローカルで
   * 明示エラーにする。待機枠・クレジット・連番を消費せず、切断しない。
   * 待機総バイトの上限ではなく、1件ごとの検査である。
   *
   * @defaultValue `65536`（省略時に接続処理が適用）。
   */
  readonly maxMessageBytes?: number;
}

/** `connect` 呼び出しごとの設定。 */
export interface ConnectOptions {
  /**
   * 接続開始から比較コード受信までの待ち時間（ミリ秒）。
   *
   * 有限の正の整数かつタイマー安全範囲（1以上2147483647以下）であること。
   * コード受信で解除し、人間の承認待ちを打ち切らない。
   *
   * @defaultValue 生成時の `requestTimeoutMs`（省略時に接続処理が適用）。
   */
  readonly timeoutMs?: number;
  /**
   * 接続試行を取り消す合図。取消時は `CONNECT_CANCELLED` で拒否しソケットを閉じる。
   */
  readonly signal?: AbortSignal;
}

/** ブリッジが発行した比較コードの表示用情報。 */
export interface PairingInfo {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** ASCII 数字 6 文字の比較コード。 */
  readonly code: PairingCode;
  /** 承認期限の絶対時刻。 */
  readonly expiresAt: number;
  /** 承認までの残り時間（ミリ秒）。 */
  readonly expiresInMs: number;
}

/** 認可成立の内容。比較コードの発行ではなく承認完了を表す。 */
export interface ConnectResult {
  /** 承認したペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** ブリッジが払い出した接続セッション識別子。 */
  readonly sessionId: SessionId;
}

/** echo 往復の結果。 */
export interface EchoResult {
  /** 送信時に採番したストリーム内連番。 */
  readonly seq: number;
  /** 要求/応答の対応付け識別子。 */
  readonly requestId: RequestId;
  /** 折り返された JSON 値。 */
  readonly payload: unknown;
}

/** ブリッジへ接続するためのクライアント。WebSocket は内部に隠す。 */
export interface WorldClient {
  /** 正規化した接続先。 */
  readonly endpoint: string;
  /** 対応するプロトコルのバージョン。 */
  readonly protocolVersion: string;
  /** 現在の接続状態の写し。 */
  getState(): ConnectionState;
  /** 表示中の比較コード。なければ `null`。 */
  getPairing(): PairingInfo | null;
  /** 通知を購読する。戻り値で解除できる。 */
  onEvent(listener: WorldClientListener): Unsubscribe;
  /**
   * 接続して比較コードの発行を受け、人間の承認成立で成功する。
   *
   * コード発行段階では未確定であり、認可成立時のみ成功する。
   *
   * @param options - 接続開始からコード受信までの待ち時間と取消合図。
   * @returns 認可成立時の要求識別子とセッション識別子。
   * @remarks `options.timeoutMs` が不正値（0・負・`NaN`・無限大・非整数・範囲外）の
   * 場合はソケット生成・状態変更の前に `RangeError` で拒否する。0を無期限扱いにしない。
   */
  connect(options?: ConnectOptions): Promise<ConnectResult>;
  /** reliable の echo を往復させる。送信メッセージが上限を超える場合は拒否する。 */
  sendEcho(
    streamId: StreamId,
    payload: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<EchoResult>;
  /** コマンドを送り `requestId` 対応の応答を待つ。送信メッセージが上限を超える場合は拒否する。 */
  sendCommand(
    streamId: StreamId,
    command: string,
    params?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<CommandResponseMessage>;
  /**
   * latest 値を送る。同一ストリームの直近送信値を置換して保持する。
   *
   * 応答は待たない。欠番を許容する。送信メッセージが上限を超える場合は拒否する。
   */
  sendLatest(streamId: StreamId, payload: unknown): number;
  /** 直近に送信した latest 値。未送信なら `undefined`。 */
  getLatestSent(streamId: StreamId): unknown;
  /** 接続を閉じる。待機中の要求は破棄して通知する。 */
  close(code?: number, reason?: string): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_RELIABLE = 128;
/** 送信メッセージ1件の既定上限（UTF-8バイト）。ブリッジの受信上限と同値の別設定である。 */
const DEFAULT_MAX_MESSAGE_BYTES = 65_536;

/**
 * ソケットを開く。`origin` 指定は Node 診断用途に限定する。
 *
 * @param endpoint - 正規化済みの接続先。
 * @param origin - 送信する `Origin`。未指定ならブラウザ既定に任せる。
 */
function openSocket(endpoint: string, origin: string | undefined): WebSocket {
  const factory: unknown = globalThis.WebSocket;
  if (typeof factory !== "function") {
    throw new WorldClientError("NO_WEBSOCKET", "WebSocket が利用できない環境である。");
  }
  if (origin === undefined) {
    return new WebSocket(endpoint);
  }
  // ADR: DOM 型の overload は (url, protocols) のみだが、Node 22 の実装は第2引数に
  // `{ headers }` を受け付ける。origin 指定は Node 診断用途に限定し、ブラウザでは
  // 指定しない運用にする。実機確認済み（Origin ヘッダが送出される）。
  return new WebSocket(endpoint, { headers: { origin } } as unknown as string[]);
}

/**
 * クライアントを生成する。
 *
 * @param options - 接続先の設定。
 * @returns 生成したクライアント。接続は `connect` まで行わない。
 * @throws `RangeError` — `endpoint` が正規の loopback 接続先でない場合。
 */
export function createWorldClient(options: WorldClientOptions): WorldClient {
  const endpoint = parseBridgeEndpoint(options.endpoint);
  const origin = options.origin;
  if (origin !== undefined && origin.length === 0) {
    throw new RangeError("origin を指定する場合は空にできない。");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError("requestTimeoutMs は正の有限数であること。");
  }
  const maxPendingReliable = options.maxPendingReliable ?? DEFAULT_MAX_PENDING_RELIABLE;
  if (!Number.isInteger(maxPendingReliable) || maxPendingReliable <= 0) {
    throw new RangeError("maxPendingReliable は正の整数であること。");
  }
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new RangeError("maxMessageBytes は正の整数であること。");
  }

  let state: ConnectionState = "disconnected";
  let socket: WebSocket | null = null;
  // 認可済みセッション。`auth_ok` で作り、`terminateAuthorized`・`handleClose` で捨てる。
  // `authorized` と有無は一致する。会計・採番・要求待機の所有者はセッションである。
  let session: AuthorizedSession | null = null;
  // 生存中の接続試行。未決着の試行と有無は一致する。認証状態（比較コード・
  // タイマー・取消・決着手段）の所有者は試行であり、状態の正本は `state` のままである。
  let liveAttempt: PairingAttempt | null = null;
  const listeners = new Set<WorldClientListener>();
  // 直近 latest 記録は接続をまたぐローカル記録のため、ここで所有して再接続で維持する。
  // 認可ごとのセッションへ参照を渡し、書き込みはセッション経由で行う。
  // 切断中（セッションなし）の読み取りはこの実体から行う。
  const latestSent: LatestSentStore = new Map();
  // 接続試行の同一性。`connect()` ごとに加算し、通知中の `close()`→再 `connect()` で
  // 試行が入れ替わったことを区別する。単なる状態確認では close→再connect を区別できず、
  // 旧試行の継続処理（stale な pairing 通知・旧タイマー発火）が新試行へ作用するため試行IDで区別する。
  let connectAttempt = 0;

  function emit(event: WorldClientEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 購読者の例外で内部状態を壊さないため握りつぶす。
      }
    }
  }

  function setState(next: ConnectionState): void {
    state = next;
    emit({ kind: "state", state: next });
  }

  /**
   * 現在の状態を読む。制御フロー解析の narrowing を関数境界で切り、
   * 通知後の再確認で他状態との比較を許す。
   */
  function currentState(): ConnectionState {
    return state;
  }

  /**
   * 接続試行を特定の符号で打ち切る。Promise 決着と内部状態を購読者通知より先に確定する。
   *
   * ADR: 通知中の `close()` 等による二重決着を防ぐため、試行の回収・決着・
   * ソケット切り離し・状態更新を先に行い、その後に通知を行う。
   * ソケットを切り離すため遅れて届く close は旧ソケットとして捨てる。
   *
   * @param error - `connect` の拒否理由。
   * @param emitError - 異常系の理由を `error` 通知でも配送するか。
   */
  function terminateConnect(error: WorldClientError, emitError: boolean): void {
    const attempt = liveAttempt;
    if (attempt === null) return;
    // 決着（Promise 拒否・タイマー解除・取消分離・比較コード破棄）を
    // ソケット切断・状態更新・通知より先に確定する。拒否の配送は
    // マイクロタスクのため、同期観測上の順序は変わらない。
    const hadPairing = attempt.fail(error);
    liveAttempt = null;
    const current = socket;
    socket = null;
    if (current !== null) {
      try {
        current.close(1000, "connect failure");
      } catch {
        // 閉塞時の例外は無視し下の拒否を優先する。
      }
    }
    // 接続試行の失敗時は認可前でありセッションを持たない。業務待機の破棄は
    // セッション所有側（`terminateAuthorized`・`handleClose`）が担う。
    state = "closed";
    emit({ kind: "state", state });
    if (hadPairing) {
      emit({ kind: "pairing", pairing: null });
    }
    if (emitError) {
      emit({ kind: "error", code: error.code, message: error.message });
    }
    emit({ kind: "closed", code: 1000, reason: "connect failure" });
  }

  /**
   * 認可済み接続を異常系で打ち切る。業務待機は結果不明として破棄する。
   *
   * @param error - 通知する異常の符号と説明。
   */
  function terminateAuthorized(error: WorldClientError): void {
    const current = socket;
    socket = null;
    if (current !== null) {
      try {
        current.close(1000, "protocol error");
      } catch {
        // 閉塞時の例外は無視し状態遷移を優先する。
      }
    }
    session?.failPending(
      new WorldClientError(
        "CONNECTION_CLOSED",
        "切断のため結果不明の要求を破棄した。処理済みかは確定しない。",
      ),
    );
    session = null;
    state = "closed";
    emit({ kind: "error", code: error.code, message: error.message });
    emit({ kind: "state", state });
    emit({ kind: "closed", code: 1000, reason: "protocol error" });
  }

  function handleClose(code: number, reason: string): void {
    // ADR: 終了済みの重複 close で closed 通知を重ねない。`close()` の再入や
    // 後処理の多重呼び出しで購読者の集計がずれないようにするため。
    if (state === "closed" && socket === null && liveAttempt === null) return;
    socket = null;
    // ADR: Promise 決着と内部状態を通知より先に確定する。通知中の `close()` が
    // 再入しても試行回収済みのため二重決着しない。未決着の試行は生存試行と
    // 有無が一致するため、保持の有無で判定する。
    const attempt = liveAttempt;
    liveAttempt = null;
    const hadPairing = (attempt?.getPairing() ?? null) !== null;
    if (attempt !== null) {
      attempt.fail(new WorldClientError("CONNECTION_CLOSED", "承認前に接続が閉じた。"));
    }
    state = "closed";
    // ADR: 切断時の未完了要求は結果不明として破棄し上位へ通知する。close code を
    // 通知に含め、処理済みか不明な要求を「未実行」とは断定しない。
    // セッションを捨てることで会計・採番・待機も作り直しになる。再接続時は
    // 認証応答から新規セッションを作る。直近 latest 記録だけは維持する。
    session?.failPending(
      new WorldClientError(
        "CONNECTION_CLOSED",
        `切断（code=${code}）のため結果不明の要求を破棄した。処理済みかは確定しない。`,
      ),
    );
    session = null;
    emit({ kind: "state", state });
    if (hadPairing) {
      emit({ kind: "pairing", pairing: null });
    }
    emit({ kind: "closed", code, reason });
  }

  function sendRaw(text: string): void {
    const current = socket;
    if (current === null || current.readyState !== WebSocket.OPEN) {
      throw new WorldClientError("NOT_CONNECTED", "送信できる接続がない。");
    }
    current.send(text);
  }

  function handleMessage(data: unknown): void {
    let message: BridgeToClientMessage;
    try {
      const parsed = parseBridgeMessage(data);
      if (
        parsed.type !== "pairing_pending" &&
        parsed.type !== "auth_ok" &&
        parsed.type !== "echo_response" &&
        parsed.type !== "command_response" &&
        parsed.type !== "credit" &&
        parsed.type !== "error"
      ) {
        throw new WorldClientError("UNEXPECTED_MESSAGE", "想定外の方向のメッセージである。");
      }
      message = parsed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      emit({ kind: "error", code: "INVALID_MESSAGE", message: detail });
      return;
    }
    if (message.type === "pairing_pending") {
      // ADR: コード通知は `requesting_pairing` の1回のみ受け付ける。重複・順序違いは
      // 取り違え防止のため終了扱いにし、黙って置換しない。段階の判定は状態の
      // 正本（調停役）が行い、試行は保持と watchdog 切替だけを行う。
      const attempt = liveAttempt;
      if (state !== "requesting_pairing" || attempt === null) {
        if (state === "authorized") {
          terminateAuthorized(
            new WorldClientError("UNEXPECTED_MESSAGE", "認可後の比較コード通知は扱わない。"),
          );
          return;
        }
        terminateConnect(
          new WorldClientError("UNEXPECTED_MESSAGE", "想定外の比較コード通知である。"),
          true,
        );
        return;
      }
      // ADR: 購読が遅れた UI も `getPairing()` で表示できるよう、保存を状態・通知より先に行う。
      const info = attempt.acceptPairingCode(message);
      const attemptAtReceipt = connectAttempt;
      setState("awaiting_approval");
      // ADR: 状態通知中に `close()` されると `handleClose()` が決着・状態・保存を
      // 先に確定する（コード受信段階は未決着のため `CONNECTION_CLOSED` で拒否）。
      // その後に stale な pairing（コード）を再通知しないよう、試行ID・状態・
      // 試行の保持を再確認してから通知する。単なる状態確認では
      // close→再connect を区別できないため試行IDを用いる。
      // narrowing 回避のため関数境界で読み直して比較する。
      const stateAfterNotify = currentState();
      if (
        attemptAtReceipt !== connectAttempt ||
        liveAttempt === null ||
        stateAfterNotify !== "awaiting_approval" ||
        attempt.getPairing() !== info
      ) {
        return;
      }
      emit({ kind: "pairing", pairing: info });
      return;
    }
    if (message.type === "auth_ok") {
      // ADR: 承認は `awaiting_approval` かつ要求 ID 一致の場合のみ適用する。
      // 異なる要求の認可を取り違えないため終了扱いにする。
      const attempt = liveAttempt;
      const code = attempt?.getPairing() ?? null;
      if (state !== "awaiting_approval" || attempt === null || code === null) {
        if (state === "authorized") {
          terminateAuthorized(
            new WorldClientError("UNEXPECTED_MESSAGE", "想定外の認証応答である。"),
          );
          return;
        }
        terminateConnect(
          new WorldClientError("UNEXPECTED_MESSAGE", "想定外の認証応答である。"),
          true,
        );
        return;
      }
      if (message.requestId !== code.requestId) {
        terminateConnect(
          new WorldClientError("UNEXPECTED_MESSAGE", "認証応答の要求が一致しない。"),
          true,
        );
        return;
      }
      // ADR: Promise 決着と内部状態を通知より先に確定する。通知中の `close()` が
      // 再入しても決着済みのため二重決着せず、認可成功を通知前に確定済みなら
      // 成功結果を拒否へ変更しない（`handleClose()` の二重決着防止で守られる）。
      const attemptAtApproval = connectAttempt;
      const approved = attempt.acceptAuthOk(message);
      const result: ConnectResult = {
        requestId: approved.requestId,
        sessionId: approved.sessionId,
      };
      // 認可成立時に試行を消費し、セッションを有効化する。初期 window は会計初期化であり、
      // 認可後送信の前提である。公開通知より先に確定する。
      liveAttempt = null;
      session = new AuthorizedSession(
        approved.sessionId,
        approved.window,
        { requestTimeoutMs, maxPendingReliable, maxMessageBytes },
        (text) => sendRaw(text),
        latestSent,
      );
      // 新規セッションのため待機はなく、流す対象はない。
      state = "authorized";
      attempt.succeed(result);
      // 通知中の `close()`→再 `connect()` で試行が入れ替わっていたら、旧試行の
      // 残り通知を新試行へ混ぜない。試行IDで区別し、状態でも再確認する。
      // narrowing 回避のため関数境界で読み直して比較する。
      const authorizedAfterResolve = currentState();
      if (attemptAtApproval !== connectAttempt || authorizedAfterResolve !== "authorized") {
        return;
      }
      emit({ kind: "state", state });
      const authorizedAfterStateNotify = currentState();
      if (attemptAtApproval !== connectAttempt || authorizedAfterStateNotify !== "authorized") {
        return;
      }
      emit({ kind: "pairing", pairing: null });
      return;
    }
    if (message.type === "error") {
      // ADR: ペアリング要求への失敗は接続試行の失敗として返す。業務待機への相関は
      // 認可後の応答経路と同じく要求 ID で行う。
      const attempt = liveAttempt;
      if (attempt !== null && (state === "requesting_pairing" || state === "awaiting_approval")) {
        const code = attempt.getPairing();
        if (
          code !== null &&
          message.requestId !== undefined &&
          message.requestId === code.requestId
        ) {
          terminateConnect(new WorldClientError(message.code, message.message), false);
          return;
        }
        // 認可前は業務待機を持たない（送信は認可後のみ受け付ける）ため、
        // 要求 ID が付いていても接続試行の失敗として扱う。
        if (
          message.requestId !== undefined &&
          session !== null &&
          session.rejectRequest(message.requestId, message.code, message.message)
        ) {
          return;
        }
        terminateConnect(new WorldClientError(message.code, message.message), false);
        return;
      }
      if (state !== "authorized") {
        terminateConnect(new WorldClientError(message.code, message.message), false);
        return;
      }
      if (
        message.requestId !== undefined &&
        session !== null &&
        session.rejectRequest(message.requestId, message.code, message.message)
      ) {
        return;
      }
      emit({ kind: "error", code: message.code, message: message.message });
      return;
    }
    if (state !== "authorized") {
      // ADR: 認可前の業務応答・credit は取り違え防止のため終了扱いにする。
      // 待機送信を受け付けないため到達自体が異常である。
      terminateConnect(
        new WorldClientError("UNEXPECTED_MESSAGE", "認証前の業務メッセージは扱わない。"),
        true,
      );
      return;
    }
    // `authorized` とセッションの有無は一致する。不一致は到達しない。
    const active = session;
    if (active === null) {
      return;
    }
    if (message.type === "credit") {
      active.handleCredit(message);
      return;
    }
    active.settleResponse(message);
  }

  const client: WorldClient = {
    endpoint,
    protocolVersion: PROTOCOL_VERSION,
    getState: () => state,
    getPairing: () => liveAttempt?.getPairing() ?? null,
    onEvent: (listener: WorldClientListener): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: (options?: ConnectOptions): Promise<ConnectResult> => {
      if (
        state === "connecting" ||
        state === "requesting_pairing" ||
        state === "awaiting_approval"
      ) {
        return Promise.reject(
          new WorldClientError("ALREADY_CONNECTING", "接続処理が進行中である。"),
        );
      }
      if (state === "authorized") {
        return Promise.reject(new WorldClientError("ALREADY_CONNECTED", "既に認証済みである。"));
      }
      const signal = options?.signal;
      if (signal !== undefined && signal.aborted) {
        return Promise.reject(
          new WorldClientError("CONNECT_CANCELLED", "接続試行が取り消された。"),
        );
      }
      const timeoutMs = options?.timeoutMs ?? requestTimeoutMs;
      // ADR: 不正な `timeoutMs` はソケット生成・状態変更の前に `RangeError` で拒否する。
      // 0を無期限扱いにせず、非整数・範囲外も受け付けない。判定は `requestTimeoutMs` と
      // 同じく `RangeError` とし、内部状態に触れる前に確定させる。
      try {
        assertConnectTimeoutMs(timeoutMs);
      } catch (error) {
        return Promise.reject(error);
      }
      let current: WebSocket;
      try {
        current = openSocket(endpoint, origin);
      } catch (error) {
        return Promise.reject(
          error instanceof WorldClientError
            ? error
            : new WorldClientError("SOCKET_ERROR", "ソケットを開けない。"),
        );
      }
      connectAttempt += 1;
      // ストリーム連番は接続単位で 0 始まりにする。サーバの `expectedSeq` は
      // 接続ごとに 0 始まりのため、旧接続の連番を引き継ぐと `UNEXPECTED_SEQ`
      // になる。連番は認可ごとの新規セッションが持つため、ここでの作り直しは
      // 不要である。`latestSent` は直近送信値のローカル記録（API の意味）
      // のため維持する。
      socket = current;
      // 試行内部の失敗（開始タイマー・承認 watchdog・取消）は調停役へ通知し、
      // 終了順序は調停役が行う。旧試行の遅延通知を新試行へ作用させないよう、
      // 生存試行の同一性とソケットの同一性で区別する。
      const attempt = new PairingAttempt({
        timeoutMs,
        requestTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
        callbacks: {
          onAttemptFailed: (failed, error) => {
            if (liveAttempt !== failed) return;
            if (socket !== current) return;
            terminateConnect(error, false);
          },
        },
      });
      liveAttempt = attempt;
      setState("connecting");
      current.addEventListener("open", () => {
        if (socket !== current) return;
        setState("requesting_pairing");
        try {
          current.send(stringifyBridgeMessage({ v: PROTOCOL_VERSION, type: "pairing_start" }));
        } catch {
          terminateConnect(
            new WorldClientError("SEND_FAILED", "開始メッセージを送れない。"),
            false,
          );
        }
      });
      current.addEventListener("message", (event: MessageEvent) => {
        if (socket !== current) return;
        handleMessage(event.data);
      });
      current.addEventListener("error", () => {
        emit({ kind: "error", code: "SOCKET_ERROR", message: "ソケット異常を検出した。" });
      });
      current.addEventListener("close", (event: CloseEvent) => {
        // ADR: open・message と同様にソケット同一性で旧ソケットの通知を捨てる。
        // close() は socket を外して自前で閉塞処理するため、遅れて届く旧 close を
        // 現行接続の状態に適用しない。状態条件を混ぜると再接続の接続処理中に旧 close が
        // 新接続を誤って閉じるため、状態では判定しない。
        if (socket !== current) return;
        handleClose(event.code, event.reason);
      });
      // `connect` の返却 Promise は試行の Promise そのものである。以降の決着は
      // 試行の `succeed`・`fail` が行い、調停役は終了順序で試行を消費・破棄する。
      return attempt.promise;
    },
    sendEcho: (
      streamId: StreamId,
      payload: unknown,
      options?: { readonly timeoutMs?: number },
    ): Promise<EchoResult> => {
      // 認可判定は接続状態の所有者（クライアント）が行い、本体はセッションに委ねる。
      if (state !== "authorized" || session === null) {
        return Promise.reject(new WorldClientError("NOT_AUTHORIZED", "認証後にのみ送信できる。"));
      }
      return session.sendEcho(streamId, payload, options);
    },
    sendCommand: (
      streamId: StreamId,
      command: string,
      params?: unknown,
      options?: { readonly timeoutMs?: number },
    ): Promise<CommandResponseMessage> => {
      // 認可判定は接続状態の所有者（クライアント）が行い、本体はセッションに委ねる。
      if (state !== "authorized" || session === null) {
        return Promise.reject(new WorldClientError("NOT_AUTHORIZED", "認証後にのみ送信できる。"));
      }
      return session.sendCommand(streamId, command, params, options);
    },
    sendLatest: (streamId: StreamId, payload: unknown): number => {
      // 認可判定は接続状態の所有者（クライアント）が行い、本体はセッションに委ねる。
      if (state !== "authorized" || session === null) {
        throw new WorldClientError("NOT_AUTHORIZED", "認証後にのみ送信できる。");
      }
      return session.sendLatest(streamId, payload);
    },
    getLatestSent: (streamId: StreamId): unknown => {
      // 直近記録は接続をまたぐローカル記録である。認可中はセッション経由で読み、
      // 切断中（セッションなし）はクライアント所有の実体から読む。指す実体は同一である。
      if (session !== null) {
        return session.getLatestSent(streamId);
      }
      return latestSent.get(streamId)?.payload;
    },
    close: (code?: number, reason?: string): void => {
      const current = socket;
      socket = null;
      if (current !== null) {
        try {
          current.close(code ?? 1000, reason ?? "client close");
        } catch {
          // 閉塞時の例外は無視し状態遷移を優先する。
        }
      }
      handleClose(code ?? 1000, reason ?? "client close");
    },
  };
  return client;
}
