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
import { parseBridgeEndpoint } from "./endpoint.ts";

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

/** クライアント操作の失敗。 */
export class WorldClientError extends Error {
  /** 機械可読の符号。 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorldClientError";
    this.code = code;
  }
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
 * `setTimeout` に安全に渡せる上限（ミリ秒）。
 *
 * Node・ブラウザともに 2^31−1 を超える遅延はオーバーフローし、即時発火や
 * 警告の原因になる。承認待ちの watchdog は期限再判定付きの分割で扱い、
 * 接続開始タイマーの入力はこの範囲に収める。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 接続開始タイマーの入力を検証する。有限の正の整数かつタイマー安全範囲であること。
 *
 * @param timeoutMs - 検証対象の候補値。
 */
function assertConnectTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("timeoutMs は1以上2147483647以下の整数（ミリ秒）であること。");
  }
}

/**
 * 文字列の UTF-8 バイト数を量る。
 *
 * `text.length` では多バイト文字を扱えない。生成物はブラウザでも動かすため
 * `Buffer` ではなく `TextEncoder` を使う。計測用の符号化は一時領域であり、
 * 待機データの bound には含めない。
 */
const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

interface PendingRequest {
  readonly resolve: (value: BridgeToClientMessage) => void;
  readonly reject: (error: WorldClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

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
  let sessionId: SessionId | null = null;
  let pairing: PairingInfo | null = null;
  // クレジット会計（接続単位）。送信可能残数 = grantedLimit − sentReliableTotal。
  // grantedLimit: 累積付与件数（auth_ok.window が初期値、credit.limit で更新）。
  // sentReliableTotal: 実際に送出した reliable の累積件数。待機への追加では増やさない。
  // 応答の受信だけでは回復しない。
  let grantedLimit = 0;
  let sentReliableTotal = 0;
  const listeners = new Set<WorldClientListener>();
  const pending = new Map<RequestId, PendingRequest>();
  const reliableQueue: Array<() => void> = [];
  const streamSeq = new Map<StreamId, number>();
  const latestSent = new Map<StreamId, { seq: number; payload: unknown }>();
  let connectSettled: {
    resolve: (value: ConnectResult) => void;
    reject: (error: WorldClientError) => void;
  } | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let abortSignal: AbortSignal | null = null;
  let abortHandler: (() => void) | null = null;
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

  function clearConnectTimer(): void {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  /**
   * 承認待ち watchdog を期限再判定付きの分割タイマーで仕掛ける。
   *
   * `expiresInMs + requestTimeoutMs` がタイマー安全範囲を超える場合、単発の
   * `setTimeout` はオーバーフローして早期発火するため、期限時刻まで残量ごとに
   * 分割して待ち直す。独自の短い上限で承認待ちを切り詰めない。
   * 未決着 `connect` のタイマーは既定で ref を維持し、`unref` しない。
   * 終了・成功時は呼び出し側が `clearConnectTimer()` で必ず解除すること。
   *
   * @param attempt - 仕掛けた接続試行のID。入れ替わっていたら発火時に何もしない。
   * @param deadlineMs - 承認応答の期限時刻（`Date.now()` 基準）。
   */
  function startApprovalWatchdog(attempt: number, deadlineMs: number): void {
    clearConnectTimer();
    const schedule = (delayMs: number): void => {
      // ADR: ref を維持するため `unref` を呼ばない。終了・成功時の解除は呼び出し側が行う。
      connectTimer = setTimeout(() => {
        // 旧試行のタイマー発火を新試行へ作用させない。状態だけでは close→再connect を
        // 区別できないため試行IDで区別する。解除済み・決着済みも何もしない。
        if (attempt !== connectAttempt || connectSettled === null) return;
        if (connectTimer === null) return;
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
          terminateConnect(
            new WorldClientError("APPROVAL_RESPONSE_TIMEOUT", "承認応答が時間内に届かない。"),
            false,
          );
          return;
        }
        schedule(Math.min(remaining, MAX_TIMER_DELAY_MS));
      }, delayMs);
    };
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      terminateConnect(
        new WorldClientError("APPROVAL_RESPONSE_TIMEOUT", "承認応答が時間内に届かない。"),
        false,
      );
      return;
    }
    schedule(Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  function detachAbort(): void {
    if (abortSignal !== null && abortHandler !== null) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
    abortSignal = null;
    abortHandler = null;
  }

  function failPending(error: WorldClientError): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    reliableQueue.length = 0;
  }

  /**
   * 接続試行を特定の符号で打ち切る。Promise 決着と内部状態を購読者通知より先に確定する。
   *
   * ADR: 通知中の `close()` 等による二重決着を防ぐため、`connectSettled` の回収・
   * タイマー解除・ソケット切り離し・状態更新を先に行い、その後に決着と通知を行う。
   * ソケットを切り離すため遅れて届く close は旧ソケットとして捨てる。
   *
   * @param error - `connect` の拒否理由。
   * @param emitError - 異常系の理由を `error` 通知でも配送するか。
   */
  function terminateConnect(error: WorldClientError, emitError: boolean): void {
    const settled = connectSettled;
    if (settled === null) return;
    connectSettled = null;
    clearConnectTimer();
    detachAbort();
    const hadPairing = pairing !== null;
    pairing = null;
    const current = socket;
    socket = null;
    if (current !== null) {
      try {
        current.close(1000, "connect failure");
      } catch {
        // 閉塞時の例外は無視し下の拒否を優先する。
      }
    }
    grantedLimit = 0;
    sentReliableTotal = 0;
    failPending(new WorldClientError("CONNECTION_CLOSED", "接続試行の失敗により待機を破棄した。"));
    state = "closed";
    settled.reject(error);
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
    sessionId = null;
    grantedLimit = 0;
    sentReliableTotal = 0;
    failPending(
      new WorldClientError(
        "CONNECTION_CLOSED",
        "切断のため結果不明の要求を破棄した。処理済みかは確定しない。",
      ),
    );
    reliableQueue.length = 0;
    state = "closed";
    emit({ kind: "error", code: error.code, message: error.message });
    emit({ kind: "state", state });
    emit({ kind: "closed", code: 1000, reason: "protocol error" });
  }

  function handleClose(code: number, reason: string): void {
    // ADR: 終了済みの重複 close で closed 通知を重ねない。`close()` の再入や
    // 後処理の多重呼び出しで購読者の集計がずれないようにするため。
    if (state === "closed" && socket === null && connectSettled === null) return;
    socket = null;
    sessionId = null;
    const hadPairing = pairing !== null;
    pairing = null;
    // 切断で会計をリセットする。再接続時は認証応答から作り直す。
    grantedLimit = 0;
    sentReliableTotal = 0;
    reliableQueue.length = 0;
    // ADR: Promise 決着と内部状態を通知より先に確定する。通知中の `close()` が
    // 再入しても `connectSettled` 回収済みのため二重決着しない。
    const settled = connectSettled;
    connectSettled = null;
    clearConnectTimer();
    detachAbort();
    state = "closed";
    if (settled !== null) {
      settled.reject(new WorldClientError("CONNECTION_CLOSED", "承認前に接続が閉じた。"));
    }
    // ADR: 切断時の未完了要求は結果不明として破棄し上位へ通知する。close code を
    // 通知に含め、処理済みか不明な要求を「未実行」とは断定しない。
    failPending(
      new WorldClientError(
        "CONNECTION_CLOSED",
        `切断（code=${code}）のため結果不明の要求を破棄した。処理済みかは確定しない。`,
      ),
    );
    emit({ kind: "state", state });
    if (hadPairing) {
      emit({ kind: "pairing", pairing: null });
    }
    emit({ kind: "closed", code, reason });
  }

  /**
   * 次に使う連番を読む。寸法検査・受付可否判定で落とす要求で消費しないよう、
   * 受付確定後に書き込む。
   */
  function peekSeq(streamId: StreamId): number {
    return streamSeq.get(streamId) ?? 0;
  }

  /**
   * 送信メッセージの寸法を検査する。超過は会計・待機枠・採番に触れずに投げる。
   *
   * @param text - 送出予定の JSON 文字列。
   */
  function assertMessageSize(text: string): void {
    if (utf8ByteLength(text) > maxMessageBytes) {
      // credit・待機枠を消費しない純粋なローカル拒否であり、切断しない。
      throw new WorldClientError(
        "MESSAGE_TOO_LARGE",
        `送信メッセージが上限（${maxMessageBytes} bytes）を超えている。`,
      );
    }
  }

  function sendRaw(text: string): void {
    const current = socket;
    if (current === null || current.readyState !== WebSocket.OPEN) {
      throw new WorldClientError("NOT_CONNECTED", "送信できる接続がない。");
    }
    current.send(text);
  }

  /** 送信可能残数。累積付与から累積送信を引いた値。 */
  function sendableReliable(): number {
    return grantedLimit - sentReliableTotal;
  }

  function drainReliableQueue(): void {
    while (sendableReliable() > 0 && reliableQueue.length > 0) {
      const send = reliableQueue.shift();
      if (send === undefined) break;
      // 実際に送出するときに1件消費する。待機への追加では消費しない。
      sentReliableTotal += 1;
      send();
    }
  }

  /**
   * reliable 送信の受付可否を判定する。会計・待機枠・連番のいずれも消費しない。
   *
   * 受付可能な場合は即時送出か待機かだけを返し、満杯の場合は投げる。
   * 呼び出し側は受付成功後に採番を確定し、間を空けず同期待ちなしで
   * {@link dispatchReliable} へ渡すこと。途中で会計は変わらない。
   */
  function admitReliable(): "send" | "queue" {
    if (sendableReliable() > 0) {
      return "send";
    }
    if (reliableQueue.length >= maxPendingReliable) {
      // 黙って捨てず明示エラーにする（設計どおり）。
      throw new WorldClientError("LOCAL_QUEUE_FULL", "reliable の送信待機が満杯である。");
    }
    return "queue";
  }

  /**
   * 受付済みの reliable 送信を振り分ける。即時は会計を消費して送出し、
   * 枯渇時は待機に積む（消費は送出時に持ち越す）。
   *
   * @param admission - 直前の {@link admitReliable} の判定結果。
   * @param send - クレジット消費時に一度だけ実行する送信処理。
   */
  function dispatchReliable(admission: "send" | "queue", send: () => void): void {
    if (admission === "send") {
      // 実際に送出するときに1件消費する。待機への追加では消費しない。
      sentReliableTotal += 1;
      send();
      return;
    }
    reliableQueue.push(send);
  }

  function waitForResponse(
    requestId: RequestId,
    timeoutMs: number | undefined,
  ): { promise: Promise<BridgeToClientMessage>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<BridgeToClientMessage>((resolve, reject) => {
      timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new WorldClientError("REQUEST_TIMEOUT", "応答の待ち時間が過ぎた。"));
      }, timeoutMs ?? requestTimeoutMs);
      pending.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });
    return {
      promise,
      cancel: () => {
        pending.delete(requestId);
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  function settleResponse(message: BridgeToClientMessage): void {
    const requestId =
      message.type === "echo_response" || message.type === "command_response"
        ? message.requestId
        : null;
    if (requestId === null) return;
    const entry = pending.get(requestId);
    if (entry === undefined) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(message);
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
      // 取り違え防止のため終了扱いにし、黙って置換しない。
      if (state !== "requesting_pairing" || connectSettled === null) {
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
      const info: PairingInfo = {
        requestId: message.requestId,
        code: message.code,
        expiresAt: message.expiresAt,
        expiresInMs: message.expiresInMs,
      };
      pairing = info;
      const attemptAtReceipt = connectAttempt;
      // ADR: `timeoutMs` は接続開始からコード受信までであり、人間の承認待ちを
      // 打ち切らない。コード受信で解除し、承認応答待ちの watchdog へ切り替える。
      // ADR: 承認応答の watchdog は `expiresInMs + requestTimeoutMs` とし、
      // ブリッジ側の期限切れと断定しない符号で打ち切る。長時間は期限再判定付きの
      // 分割タイマーで扱い、独自の短い上限で承認待ちを切り詰めない。
      startApprovalWatchdog(attemptAtReceipt, Date.now() + message.expiresInMs + requestTimeoutMs);
      setState("awaiting_approval");
      // ADR: 状態通知中に `close()` されると `handleClose()` が決着・状態・保存を
      // 先に確定する（コード受信段階は未決着のため `CONNECTION_CLOSED` で拒否）。
      // その後に stale な pairing（コード）を再通知しないよう、試行ID・状態・
      // 保存中の pairing を再確認してから通知する。単なる状態確認では
      // close→再connect を区別できないため試行IDを用いる。
      // narrowing 回避のため関数境界で読み直して比較する。
      const stateAfterNotify = currentState();
      if (
        attemptAtReceipt !== connectAttempt ||
        connectSettled === null ||
        stateAfterNotify !== "awaiting_approval" ||
        pairing !== info
      ) {
        return;
      }
      emit({ kind: "pairing", pairing: info });
      return;
    }
    if (message.type === "auth_ok") {
      // ADR: 承認は `awaiting_approval` かつ要求 ID 一致の場合のみ適用する。
      // 異なる要求の認可を取り違えないため終了扱いにする。
      if (state !== "awaiting_approval" || connectSettled === null || pairing === null) {
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
      if (message.requestId !== pairing.requestId) {
        terminateConnect(
          new WorldClientError("UNEXPECTED_MESSAGE", "認証応答の要求が一致しない。"),
          true,
        );
        return;
      }
      // ADR: Promise 決着と内部状態を通知より先に確定する。通知中の `close()` が
      // 再入しても決着済みのため二重決着せず、認可成功を通知前に確定済みなら
      // 成功結果を拒否へ変更しない（`handleClose()` の二重決着防止で守られる）。
      const settled = connectSettled;
      connectSettled = null;
      clearConnectTimer();
      detachAbort();
      const attemptAtApproval = connectAttempt;
      const result: ConnectResult = {
        requestId: message.requestId,
        sessionId: message.sessionId,
      };
      sessionId = message.sessionId;
      // 接続ごとに会計を作り直す。初期付与は auth_ok.window が担う。
      grantedLimit = message.window;
      sentReliableTotal = 0;
      pairing = null;
      state = "authorized";
      settled.resolve(result);
      drainReliableQueue();
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
      const pendingEntry =
        message.requestId !== undefined ? pending.get(message.requestId) : undefined;
      // ADR: ペアリング要求への失敗は接続試行の失敗として返す。業務待機への相関は
      // 認可後の応答経路と同じく要求 ID で行う。
      if (
        connectSettled !== null &&
        (state === "requesting_pairing" || state === "awaiting_approval")
      ) {
        if (
          pairing !== null &&
          message.requestId !== undefined &&
          message.requestId === pairing.requestId
        ) {
          terminateConnect(new WorldClientError(message.code, message.message), false);
          return;
        }
        if (pendingEntry !== undefined && message.requestId !== undefined) {
          pending.delete(message.requestId);
          clearTimeout(pendingEntry.timer);
          pendingEntry.reject(new WorldClientError(message.code, message.message));
          return;
        }
        terminateConnect(new WorldClientError(message.code, message.message), false);
        return;
      }
      if (state !== "authorized") {
        terminateConnect(new WorldClientError(message.code, message.message), false);
        return;
      }
      if (message.requestId !== undefined) {
        const entry = pending.get(message.requestId);
        if (entry !== undefined) {
          pending.delete(message.requestId);
          clearTimeout(entry.timer);
          entry.reject(new WorldClientError(message.code, message.message));
          return;
        }
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
    if (message.type === "credit") {
      // セッション不一致の credit は会計へ適用しない。同じ limit の再通知は
      // 差分が生じないため追加付与にならない。応答の受信だけでは回復しない。
      if (sessionId === null || message.sessionId !== sessionId) return;
      // 減少通知は古い会計値の誤再通知として無視し、付与済みの送信権を撤回しない。
      // エラー通知・切断はしない。
      if (message.limit < grantedLimit) return;
      grantedLimit = message.limit;
      drainReliableQueue();
      return;
    }
    settleResponse(message);
  }

  const client: WorldClient = {
    endpoint,
    protocolVersion: PROTOCOL_VERSION,
    getState: () => state,
    getPairing: () => pairing,
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
      return new Promise<ConnectResult>((resolve, reject) => {
        let current: WebSocket;
        try {
          current = openSocket(endpoint, origin);
        } catch (error) {
          reject(
            error instanceof WorldClientError
              ? error
              : new WorldClientError("SOCKET_ERROR", "ソケットを開けない。"),
          );
          return;
        }
        connectAttempt += 1;
        const attempt = connectAttempt;
        // 新しい接続試行では接続単位のストリーム連番を作り直す。サーバの
        // `expectedSeq` は接続ごとに 0 始まりのため、旧接続の連番を引き継ぐと
        // `UNEXPECTED_SEQ` になる。`latestSent` は直近送信値のローカル記録
        // （API の意味）のため維持する。
        streamSeq.clear();
        socket = current;
        connectSettled = { resolve, reject };
        setState("connecting");
        // ADR: 未決着 `connect` のタイマーは既定で ref を維持し、`unref` しない。
        // 終了・成功時は `connectSettled` のラッパー・`terminateConnect`・`handleClose`・
        // 認可確定のいずれかで必ず解除する。
        connectTimer = setTimeout(() => {
          if (connectSettled === null) return;
          if (attempt !== connectAttempt) return;
          if (socket !== current) return;
          terminateConnect(
            new WorldClientError("CONNECT_TIMEOUT", "比較コードが時間内に届かない。"),
            false,
          );
        }, timeoutMs);
        const originalResolve = resolve;
        const originalReject = reject;
        connectSettled = {
          resolve: (value: ConnectResult) => {
            clearConnectTimer();
            detachAbort();
            originalResolve(value);
          },
          reject: (error: WorldClientError) => {
            clearConnectTimer();
            detachAbort();
            originalReject(error);
          },
        };
        if (signal !== undefined) {
          abortSignal = signal;
          abortHandler = (): void => {
            if (connectSettled === null) return;
            if (attempt !== connectAttempt) return;
            if (socket !== current) return;
            terminateConnect(
              new WorldClientError("CONNECT_CANCELLED", "接続試行が取り消された。"),
              false,
            );
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        }
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
          clearConnectTimer();
          handleClose(event.code, event.reason);
        });
      });
    },
    sendEcho: (
      streamId: StreamId,
      payload: unknown,
      options?: { readonly timeoutMs?: number },
    ): Promise<EchoResult> => {
      if (state !== "authorized" || sessionId === null) {
        return Promise.reject(new WorldClientError("NOT_AUTHORIZED", "認証後にのみ送信できる。"));
      }
      const activeSession = sessionId;
      const seq = peekSeq(streamId);
      const requestId: RequestId = crypto.randomUUID();
      const text = stringifyBridgeMessage({
        v: PROTOCOL_VERSION,
        type: "echo",
        sessionId: activeSession,
        streamId,
        kind: "reliable",
        seq,
        requestId,
        payload,
      });
      // 寸法検査→受付可否判定の順で、拒否時は採番・待機枠・会計のいずれも消費しない。
      let echoAdmission: "send" | "queue";
      try {
        assertMessageSize(text);
        echoAdmission = admitReliable();
      } catch (error) {
        // 本 API は Promise で結果を返す契約のため、同期の検査落ちも拒否に載せる。
        return Promise.reject(error);
      }
      // 受付確定時に採番する。待機中の複数件は異なる増加連番を持ち、
      // ローカル拒否ではここに到達しないため連番を消費しない。
      streamSeq.set(streamId, seq + 1);
      const waiting = waitForResponse(requestId, options?.timeoutMs);
      try {
        dispatchReliable(echoAdmission, () => {
          sendRaw(text);
        });
      } catch (error) {
        waiting.cancel();
        return Promise.reject(error);
      }
      return waiting.promise.then((message) => {
        if (message.type !== "echo_response") {
          throw new WorldClientError("UNEXPECTED_MESSAGE", "echo 応答ではない。");
        }
        return { seq: message.seq, requestId: message.requestId, payload: message.payload };
      });
    },
    sendCommand: (
      streamId: StreamId,
      command: string,
      params?: unknown,
      options?: { readonly timeoutMs?: number },
    ): Promise<CommandResponseMessage> => {
      if (state !== "authorized" || sessionId === null) {
        return Promise.reject(new WorldClientError("NOT_AUTHORIZED", "認証後にのみ送信できる。"));
      }
      const activeSession = sessionId;
      const seq = peekSeq(streamId);
      const requestId: RequestId = crypto.randomUUID();
      const text = stringifyBridgeMessage({
        v: PROTOCOL_VERSION,
        type: "command_request",
        sessionId: activeSession,
        streamId,
        kind: "reliable",
        seq,
        requestId,
        command,
        ...(params === undefined ? {} : { params }),
      });
      // 寸法検査→受付可否判定の順で、拒否時は採番・待機枠・会計のいずれも消費しない。
      let commandAdmission: "send" | "queue";
      try {
        assertMessageSize(text);
        commandAdmission = admitReliable();
      } catch (error) {
        // 本 API は Promise で結果を返す契約のため、同期の検査落ちも拒否に載せる。
        return Promise.reject(error);
      }
      // 受付確定時に採番する。待機中の複数件は異なる増加連番を持ち、
      // ローカル拒否ではここに到達しないため連番を消費しない。
      streamSeq.set(streamId, seq + 1);
      const waiting = waitForResponse(requestId, options?.timeoutMs);
      try {
        dispatchReliable(commandAdmission, () => {
          sendRaw(text);
        });
      } catch (error) {
        waiting.cancel();
        return Promise.reject(error);
      }
      return waiting.promise.then((message) => {
        if (message.type !== "command_response") {
          throw new WorldClientError("UNEXPECTED_MESSAGE", "command 応答ではない。");
        }
        return message;
      });
    },
    sendLatest: (streamId: StreamId, payload: unknown): number => {
      if (state !== "authorized" || sessionId === null) {
        throw new WorldClientError("NOT_AUTHORIZED", "認証後にのみ送信できる。");
      }
      const seq = peekSeq(streamId);
      const text = stringifyBridgeMessage({
        v: PROTOCOL_VERSION,
        type: "data",
        sessionId,
        streamId,
        kind: "latest",
        seq,
        payload,
      });
      // 受付前に検査し、超過は保持の更新・採番をせずに投げる。
      assertMessageSize(text);
      streamSeq.set(streamId, seq + 1);
      latestSent.set(streamId, { seq, payload });
      sendRaw(text);
      return seq;
    },
    getLatestSent: (streamId: StreamId): unknown => {
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
