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
  /** reliable の echo を往復させる。 */
  sendEcho(
    streamId: StreamId,
    payload: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<EchoResult>;
  /** コマンドを送り `requestId` 対応の応答を待つ。 */
  sendCommand(
    streamId: StreamId,
    command: string,
    params?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<CommandResponseMessage>;
  /**
   * latest 値を送る。同一ストリームの直近送信値を置換して保持する。
   *
   * 応答は待たない。欠番を許容する。
   */
  sendLatest(streamId: StreamId, payload: unknown): number;
  /** 直近に送信した latest 値。未送信なら `undefined`。 */
  getLatestSent(streamId: StreamId): unknown;
  /** 接続を閉じる。待機中の要求は破棄して通知する。 */
  close(code?: number, reason?: string): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_RELIABLE = 128;

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

  let state: ConnectionState = "disconnected";
  let socket: WebSocket | null = null;
  let sessionId: string | null = null;
  let creditWindow = 0;
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
    creditWindow = 0;
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

  function nextSeq(streamId: StreamId): number {
    const seq = streamSeq.get(streamId) ?? 0;
    streamSeq.set(streamId, seq + 1);
    return seq;
  }

  function sendRaw(text: string): void {
    const current = socket;
    if (current === null || current.readyState !== WebSocket.OPEN) {
      throw new WorldClientError("NOT_CONNECTED", "送信できる接続がない。");
    }
    current.send(text);
  }

  function drainReliableQueue(): void {
    while (creditWindow > 0 && reliableQueue.length > 0) {
      const send = reliableQueue.shift();
      if (send === undefined) break;
      creditWindow -= 1;
      send();
    }
  }

  /**
   * reliable 送信をクレジット範囲で実行する。枯渇時は有限待機する。
   *
   * @param send - クレジット消費時に一度だけ実行する送信処理。
   */
  function gateReliable(send: () => void): void {
    if (creditWindow > 0) {
      creditWindow -= 1;
      send();
      return;
    }
    if (reliableQueue.length >= maxPendingReliable) {
      // 黙って捨てず明示エラーにする（設計どおり）。
      throw new WorldClientError("LOCAL_QUEUE_FULL", "reliable の送信待機が満杯である。");
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
      creditWindow = message.window;
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
      creditWindow = message.window;
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
          if (socket !== current && state === "closed") return;
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
      const seq = nextSeq(streamId);
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
      const waiting = waitForResponse(requestId, options?.timeoutMs);
      try {
        gateReliable(() => {
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
      const seq = nextSeq(streamId);
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
      const waiting = waitForResponse(requestId, options?.timeoutMs);
      try {
        gateReliable(() => {
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
      const seq = nextSeq(streamId);
      latestSent.set(streamId, { seq, payload });
      sendRaw(
        stringifyBridgeMessage({
          v: PROTOCOL_VERSION,
          type: "data",
          sessionId,
          streamId,
          kind: "latest",
          seq,
          payload,
        }),
      );
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
