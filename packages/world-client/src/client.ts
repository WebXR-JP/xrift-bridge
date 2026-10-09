/**
 * ワールド内からブリッジへ接続するためのクライアント。
 *
 * WebSocket オブジェクトは上位層に公開しない。切断後の再送・セッション復元・
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
  type RequestId,
  type StreamId,
} from "bridge-protocol";
import { parseBridgeEndpoint } from "./endpoint.ts";

/** クライアントの接続状態。 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "authorized"
  | "closed";

/** クライアントが配送する通知。 */
export type WorldClientEvent =
  | { readonly kind: "state"; readonly state: ConnectionState }
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

/** 認証成功の内容。 */
export interface ConnectResult {
  /** ブリッジが払い出した接続セッション識別子。 */
  readonly sessionId: string;
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
  /** 通知を購読する。戻り値で解除できる。 */
  onEvent(listener: WorldClientListener): Unsubscribe;
  /**
   * 接続してペアリング秘密値で認証する。
   *
   * 秘密値を URL・query に含めず、最初のアプリケーションメッセージで送る。
   */
  connect(secret: string, options?: { readonly timeoutMs?: number }): Promise<ConnectResult>;
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
  let sessionId: string | null = null;
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

  function failPending(error: WorldClientError): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    reliableQueue.length = 0;
  }

  function handleClose(code: number, reason: string): void {
    socket = null;
    sessionId = null;
    // 切断で会計をリセットする。再接続時は認証応答から作り直す。
    grantedLimit = 0;
    sentReliableTotal = 0;
    reliableQueue.length = 0;
    if (connectSettled !== null) {
      const settled = connectSettled;
      connectSettled = null;
      settled.reject(new WorldClientError("CONNECTION_CLOSED", "認証前に接続が閉じた。"));
    }
    // ADR: 切断時の未完了要求は結果不明として破棄し上位へ通知する。close code を
    // 通知に含め、処理済みか不明な要求を「未実行」とは断定しない。
    failPending(
      new WorldClientError(
        "CONNECTION_CLOSED",
        `切断（code=${code}）のため結果不明の要求を破棄した。処理済みかは確定しない。`,
      ),
    );
    if (state !== "closed") {
      setState("closed");
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
   * 送信メッセージの寸法を検査する。超過は会計・待機・採番に触れずに投げる。
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
    if (message.type === "auth_ok") {
      if (state !== "authenticating" || connectSettled === null) {
        emit({ kind: "error", code: "UNEXPECTED_MESSAGE", message: "想定外の認証応答である。" });
        return;
      }
      const settled = connectSettled;
      connectSettled = null;
      sessionId = message.sessionId;
      // 接続ごとに会計を作り直す。初期付与は auth_ok.window が担う。
      grantedLimit = message.window;
      sentReliableTotal = 0;
      setState("authorized");
      drainReliableQueue();
      settled.resolve({ sessionId: message.sessionId });
      return;
    }
    if (message.type === "error" && connectSettled !== null) {
      // 認証待ちの失敗は接続試行の失敗として返す。
      const settled = connectSettled;
      connectSettled = null;
      settled.reject(new WorldClientError(message.code, message.message));
      return;
    }
    if (state !== "authorized") {
      emit({
        kind: "error",
        code: "NOT_AUTHORIZED",
        message: "認証前の業務メッセージは扱わない。",
      });
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
    if (message.type === "error") {
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
    settleResponse(message);
  }

  const client: WorldClient = {
    endpoint,
    protocolVersion: PROTOCOL_VERSION,
    getState: () => state,
    onEvent: (listener: WorldClientListener): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: (
      secret: string,
      options?: { readonly timeoutMs?: number },
    ): Promise<ConnectResult> => {
      if (state === "connecting" || state === "authenticating") {
        return Promise.reject(
          new WorldClientError("ALREADY_CONNECTING", "接続処理が進行中である。"),
        );
      }
      if (state === "authorized") {
        return Promise.reject(new WorldClientError("ALREADY_CONNECTED", "既に認証済みである。"));
      }
      if (typeof secret !== "string" || secret.length === 0) {
        return Promise.reject(new WorldClientError("INVALID_SECRET", "秘密値は空にできない。"));
      }
      const timeoutMs = options?.timeoutMs ?? requestTimeoutMs;
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
        socket = current;
        connectSettled = { resolve, reject };
        setState("connecting");
        const timer = setTimeout(() => {
          if (connectSettled !== null) {
            connectSettled = null;
            try {
              current.close(1000, "connect timeout");
            } catch {
              // 閉塞時の例外は無視し下の拒否を優先する。
            }
            reject(new WorldClientError("CONNECT_TIMEOUT", "認証が時間内に完了しない。"));
          }
        }, timeoutMs);
        const clearConnectTimer = (): void => {
          clearTimeout(timer);
        };
        const originalResolve = resolve;
        const originalReject = reject;
        connectSettled = {
          resolve: (value: ConnectResult) => {
            clearConnectTimer();
            originalResolve(value);
          },
          reject: (error: WorldClientError) => {
            clearConnectTimer();
            originalReject(error);
          },
        };
        current.addEventListener("open", () => {
          if (socket !== current) return;
          setState("authenticating");
          try {
            current.send(stringifyBridgeMessage({ v: PROTOCOL_VERSION, type: "auth", secret }));
          } catch {
            if (connectSettled !== null) {
              const settled = connectSettled;
              connectSettled = null;
              clearConnectTimer();
              settled.reject(new WorldClientError("SEND_FAILED", "認証メッセージを送れない。"));
            }
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
