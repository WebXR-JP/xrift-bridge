/**
 * ワールド内からブリッジへ接続するためのクライアント（0.3）。
 *
 * 接続はワールド起点で開始し、ブリッジが発行する比較コードを人間が
 * ブリッジ側で承認した接続だけを認可する。認可前の往復はテキスト
 * （`pairing_start`・`pairing_pending`・`auth_ok`・`error`）で行い、
 * `auth_ok` の受信処理内で同一 WebSocket 上の yamux mux へ切り替える。
 * 以降の送受信は `SessionProvider`・`Session` で行い、受信形式の
 * 推測判別は設けない。
 *
 * 切断後の再送・セッション復元・自動再実行は行わない（設計どおり）。
 * 再接続には再ペアリングが必要である。業務 request/response 相関・
 * 自動再送・要求待機タイマーは公開APIに持たず、上位層の責務とする。
 *
 * @packageDocumentation
 */
import {
  PROTOCOL_VERSION,
  parseBridgeMessage,
  stringifyBridgeMessage,
  type PairingCode,
  type PairingRequestId,
} from "bridge-protocol";
import {
  Connection,
  WsMessageStream,
  defaultTimerScheduler,
  type TimerScheduler,
  type WsMessageStreamOptions,
} from "bridge-protocol/transport";
import { BrowserSocket, normalizeSocketData, type NormalizedSocketData } from "./browser-socket.ts";
import { WorldClientError } from "./errors.ts";
import { PairingAttempt } from "./pairing-attempt.ts";
import { parseBridgeEndpoint } from "./endpoint.ts";
import { ClientSessionProvider, type SessionProvider } from "./session.ts";

export { WorldClientError };

/** 接続開始時の設定。 */
export interface ConnectOptions {
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
   * 接続試行を取り消す合図。取消時は `CONNECT_CANCELLED` で拒否しソケットを閉じる。
   */
  readonly signal?: AbortSignal;
  /**
   * 認可後に開始する transport のタイマー実装。省略時は環境のタイマーを使う。
   *
   * 認証まわりの待ち（比較コード受信・承認応答）に時限は設けない。
   * 試験で時間を手で進める場合に差し替える。
   */
  readonly scheduler?: TimerScheduler;
}

/** ブリッジが発行した比較コードの表示用情報。 */
export interface PairingInfo {
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** ASCII 数字 6 文字の比較コード。 */
  readonly code: PairingCode;
}

/**
 * 接続開始要求。内部的に WebSocket 接続を開始する。
 *
 * `pairingInfo` はブリッジからの比較コード（`pairing_pending` 受信）で
 * 解決し、`sessionProvider` は認証完了（`auth_ok` 受領・mux 開始後）に
 * 解決する。いずれも失敗時は `WorldClientError` で拒否する。両方の約束の
 * 扱いが必要であり、片方だけを待つ場合はもう片方にも拒否時の扱いを付ける
 * こと（未処理の拒否を残さない）。
 */
export interface ConnectionRequest {
  /** 比較コードの表示用情報で解ける約束。 */
  readonly pairingInfo: Promise<PairingInfo>;
  /** 認証完了後のセッション管理口で解ける約束。 */
  readonly sessionProvider: Promise<SessionProvider>;
}

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
  // 指定しない運用にする。
  return new WebSocket(endpoint, { headers: { origin } } as unknown as string[]);
}

/**
 * ブリッジへの接続を開始する。
 *
 * 比較コードの発行と認証完了を2つの約束で返す。承認前の取消は
 * `options.signal` で行う。比較コード受信待ちに時限は設けず、取消は
 * `signal`、通信失敗はソケットの close 通知で扱う。イベント購読・
 * 状態取得・業務送信 API は持たず、認可後の操作は解決した
 * `SessionProvider` で行う。
 *
 * 公開 API の選択理由: echo/command の要求相関・要求待機は上位層の責務とし
 * （`data` 一本化・相関委譲）、本関数は相関・待機を持たない。2約束の形は
 * 人間への表示（比較コード）と mux 準備完了の時点が異なるため分け、
 * 承認フロー（開始→表示→承認→mux）をそのまま表す。
 *
 * @param options - 接続先・取消合図・認可後 transport 設定。
 * @returns 比較コードとセッション管理口の約束。
 * @throws `RangeError` — `endpoint`・`origin` が不正な場合。
 * @throws `WorldClientError` — WebSocket が利用できない環境の場合。
 */
export function createConnectionRequest(options: ConnectOptions): ConnectionRequest {
  const endpoint = parseBridgeEndpoint(options.endpoint);
  const origin = options.origin;
  if (origin !== undefined && origin.length === 0) {
    throw new RangeError("origin を指定する場合は空にできない。");
  }
  const scheduler = options.scheduler ?? defaultTimerScheduler;
  const signal = options.signal;
  if (signal !== undefined && signal.aborted) {
    const cancelled = new WorldClientError("CONNECT_CANCELLED", "接続試行が取り消された。");
    return { pairingInfo: Promise.reject(cancelled), sessionProvider: Promise.reject(cancelled) };
  }

  const socket = openSocket(endpoint, origin);
  // ADR: 生成直後にバイナリ受信形式を固定する。以降の binary は `ArrayBuffer`
  // で届く（`Blob` で届く環境は正規化で吸収する）。
  socket.binaryType = "arraybuffer";
  const rawSocket = new BrowserSocket(socket);

  let pairingResolve: (info: PairingInfo) => void = () => undefined;
  let pairingReject: (error: WorldClientError) => void = () => undefined;
  let providerResolve: (provider: SessionProvider) => void = () => undefined;
  let providerReject: (error: WorldClientError) => void = () => undefined;
  const pairingInfo = new Promise<PairingInfo>((resolve, reject) => {
    pairingResolve = resolve;
    pairingReject = reject;
  });
  const sessionProvider = new Promise<SessionProvider>((resolve, reject) => {
    providerResolve = resolve;
    providerReject = reject;
  });

  // 認可前の段階。`requesting_pairing`（コード待ち）・`awaiting_approval`
  // （承認待ち）・`authorized`（mux 運用中）・`closed`（終了）のいずれか。
  // 段階の判定はこの調停役が行い、試行は比較コードの保持だけを持つ。
  let phase: "requesting_pairing" | "awaiting_approval" | "authorized" | "closed" =
    "requesting_pairing";
  // 生存中の接続試行。未決着の試行と有無は一致する。
  let liveAttempt: PairingAttempt | null = null;
  // 認可後の管理口。`authorized` と有無は一致する。
  let providerRef: ClientSessionProvider | null = null;

  /**
   * 接続試行を打ち切る。公開の約束の決着とソケット切断を確定する。
   *
   * 決着済みの約束への再拒否は無害であり、二重決着しない。
   *
   * @param error - 拒否理由。
   */
  function failRequest(error: WorldClientError): void {
    if (phase === "closed") return;
    phase = "closed";
    liveAttempt?.fail();
    liveAttempt = null;
    pairingReject(error);
    providerReject(error);
    try {
      socket.close(1000, "connect failure");
    } catch {
      // 閉塞時の例外は無視し拒否を優先する。
    }
  }

  /**
   * 認可済み接続を境界違反で打ち切る。
   *
   * @param error - 違反の符号と説明。
   */
  function terminateAfterAuth(error: WorldClientError): void {
    if (phase === "closed") return;
    phase = "closed";
    const provider = providerRef;
    providerRef = null;
    if (provider !== null) {
      provider.handleClosed(error);
    }
    try {
      socket.close(1000, "protocol violation");
    } catch {
      // 閉塞時の例外は無視し状態遷移を優先する。
    }
  }

  /**
   * mux を開始し、管理口を作る。`auth_ok` の受信処理内で同期に呼ぶ。
   *
   * 購読と mux を準備してから公開し、連続到着する最初の binary を落とさない。
   *
   * @param connectionId - `auth_ok` で払い出された接続識別子。
   * @returns 公開するセッション管理口。
   */
  function startMux(connectionId: string): ClientSessionProvider {
    let built: ClientSessionProvider | null = null;
    const stream = new WsMessageStream(rawSocket, {
      direction: "outbound",
      log: createNoopLogger(),
    });
    const connection = new Connection({
      transport: stream,
      role: "client",
      connectionId,
      scheduler,
      onSession: (session) => {
        built?.handleInbound(session);
      },
      onClose: (cause) => {
        built?.handleClosed(cause);
        // ADR: 相手起点の終端でもソケットを閉じる。サーバ側も閉じるため
        // 二重でも無害であり、片開きを残さない。
        if (phase !== "closed") {
          phase = "closed";
        }
        try {
          socket.close(1000, "connection closed");
        } catch {
          // 閉塞時の例外は無視する。
        }
      },
    });
    built = new ClientSessionProvider(connection, rawSocket);
    return built;
  }

  function handleNormalized(data: NormalizedSocketData): void {
    if (phase === "closed") return;
    if (data.kind === "bytes") {
      if (phase !== "authorized" || providerRef === null) {
        // ADR: 認可前の binary は推測判別せず境界違反として終了する。
        failRequest(new WorldClientError("UNEXPECTED_BINARY", "認可前は text のみ受け付ける。"));
        return;
      }
      rawSocket.pushBinary(data.bytes);
      return;
    }
    if (phase === "authorized") {
      // ADR: mux 移行後の text は境界違反として終了する（binary 列を汚さない）。
      // 重複 `auth_ok` もここで終了する。
      terminateAfterAuth(
        new WorldClientError("UNEXPECTED_MESSAGE", "mux 移行後の text は扱わない。"),
      );
      return;
    }
    let message: ReturnType<typeof parseBridgeMessage>;
    try {
      message = parseBridgeMessage(data.text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failRequest(new WorldClientError("INVALID_MESSAGE", detail));
      return;
    }
    if (message.type === "pairing_pending") {
      // ADR: コード通知は `requesting_pairing` の1回のみ受け付ける。重複・
      // 順序違いは取り違え防止のため終了扱いにし、黙って置換しない。
      const attempt = liveAttempt;
      if (phase !== "requesting_pairing" || attempt === null) {
        failRequest(new WorldClientError("UNEXPECTED_MESSAGE", "想定外の比較コード通知である。"));
        return;
      }
      const info = attempt.acceptPairingCode(message);
      phase = "awaiting_approval";
      pairingResolve(info);
      return;
    }
    if (message.type === "auth_ok") {
      // ADR: 承認は `awaiting_approval` かつ要求 ID 一致の場合のみ適用する。
      // 異なる要求の認可を取り違えないため終了扱いにする。
      const attempt = liveAttempt;
      const code = attempt?.getPairing() ?? null;
      if (phase !== "awaiting_approval" || attempt === null || code === null) {
        failRequest(new WorldClientError("UNEXPECTED_MESSAGE", "想定外の認証応答である。"));
        return;
      }
      if (message.requestId !== code.requestId) {
        failRequest(new WorldClientError("UNEXPECTED_MESSAGE", "認証応答の要求が一致しない。"));
        return;
      }
      attempt.succeed();
      liveAttempt = null;
      let provider: ClientSessionProvider;
      try {
        provider = startMux(message.connectionId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failRequest(new WorldClientError("MUX_FAILURE", `mux を開始できない: ${detail}`));
        return;
      }
      phase = "authorized";
      providerRef = provider;
      providerResolve(provider);
      return;
    }
    if (message.type === "error") {
      // ADR: 認可前の失敗は接続試行の失敗として返す。業務相関は持たない。
      failRequest(new WorldClientError(message.code, message.message));
      return;
    }
    // ADR: 認可前の業務メッセージ（`create_session`・`data`）は取り違え防止の
    // ため終了扱いにする。受信形式の推測判別は行わない。
    failRequest(new WorldClientError("UNEXPECTED_MESSAGE", "認証前の業務メッセージは扱わない。"));
  }

  /**
   * 受信値を正規化して順序どおり処理する。決して拒否しない。
   *
   * `Blob` の変換は非同期だが、受信鎖で直列化するため順序は保つ。
   * `auth_ok` の受信処理はこの鎖の中で同期に mux 開始まで行い、
   * 後続 binary の到着より先に受信口を準備する。
   */
  async function dispatchMessage(data: unknown): Promise<void> {
    try {
      const normalized = await normalizeSocketData(data);
      handleNormalized(normalized);
    } catch {
      if (phase === "authorized") {
        terminateAfterAuth(new WorldClientError("INVALID_MESSAGE", "受信値の形式が想定外である。"));
      } else {
        failRequest(new WorldClientError("INVALID_MESSAGE", "受信値の形式が想定外である。"));
      }
    }
  }

  // ADR: 受信鎖は `then` の成功・失敗の両方で次へ進める。1件の処理が
  // 拒否しても後続の受信を落とさない。`dispatchMessage` 自体は拒否しない
  // 作りであり、二重の備えである。
  let receiveChain: Promise<void> = Promise.resolve();
  socket.addEventListener("open", () => {
    if (phase !== "requesting_pairing") return;
    try {
      socket.send(stringifyBridgeMessage({ v: PROTOCOL_VERSION, type: "pairing_start" }));
    } catch {
      failRequest(new WorldClientError("SEND_FAILED", "開始メッセージを送れない。"));
    }
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    const run = (): Promise<void> => dispatchMessage(data);
    receiveChain = receiveChain.then(run, run);
  });
  socket.addEventListener("close", () => {
    rawSocket.notifyClosed();
    if (phase === "closed") return;
    phase = "closed";
    liveAttempt?.fail();
    liveAttempt = null;
    // ADR: 切断時の未決着は結果不明として破棄する。認可後（管理口あり）は
    // mux 経路の終端通知が担い、ここでは段階の確定だけを行う。
    // 再接続時は再ペアリングが必要であり、認可は引き継がない。
    if (providerRef === null) {
      const error = new WorldClientError("CONNECTION_CLOSED", "承認前に接続が閉じた。");
      pairingReject(error);
      providerReject(error);
    }
  });

  liveAttempt = new PairingAttempt({
    ...(signal === undefined ? {} : { signal }),
    callbacks: {
      onAttemptFailed: (failed, error) => {
        if (liveAttempt !== failed) return;
        failRequest(error);
      },
    },
  });

  return { pairingInfo, sessionProvider };
}
