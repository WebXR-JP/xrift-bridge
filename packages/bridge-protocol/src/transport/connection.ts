/**
 * 認可後の1つの yamux mux を所有する Connection。
 *
 * 輸送（`MessageStream`）の上に `bridgeMuxer()` で muxer を作り、
 * 新規 yamux stream の最初の framed メッセージを `create_session`
 * ハンドシェイクとして Session（B2）に結び付ける。以降の送受信・終了は
 * Session が担い、ここでは対応表の維持・方向と役割の整合・keepalive・
 * Connection 単位の終端だけを担う。
 *
 * 終了は `terminate()`（自発 GoAway）か、相手 GoAway・mux 異常・
 * 輸送喪失の観測であり、いずれも全 Session を終端して `onClose` を
 * 一度だけ通知する。muxer は閉じるが輸送は閉じない。
 *
 * @packageDocumentation
 */

import type { MessageStream, StreamMessageEvent } from "@libp2p/interface";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import { PROTOCOL_VERSION, type SessionDirection, type SessionKind } from "../messages.ts";
import { parseBridgeMessage } from "../validate.ts";
import { FrameDecoder, encodeFrameJson } from "./framing.ts";
import { bridgeMuxer, type BridgeMuxer } from "./muxer.ts";
import { SessionEngine } from "./session.ts";
import type {
  InboundSession,
  LatestSenderSession,
  LatestSendDirectionMap,
  OutboundSession,
  ReliableSession,
  Session,
} from "./session-types.ts";
import { Keepalive } from "./keepalive.ts";
import { defaultTimerScheduler, type TimerScheduler } from "./timers.ts";

/** Connection が属する側。Session の `side` と一致する。 */
export type ConnectionRole = "client" | "server";

/** Connection の生成条件。 */
export interface ConnectionOptions<R extends ConnectionRole = ConnectionRole> {
  /**
   * 認可後のバイナリ専用輸送。認可プリリュードは外で済ませること。
   *
   * 向きは役割と対応すること（`client` は `outbound`、`server` は
   * `inbound`）。yamux の stream ID 割当に使うため、不一致は拒否する。
   */
  readonly transport: MessageStream;
  /** この側が `client`・`server` のどちらであるか。 */
  readonly role: R;
  /** 紐付ける接続の識別子。送受信する全メッセージに載せ照合する。 */
  readonly connectionId: string;
  /** タイマーの実装。省略時は環境のタイマーを使う。 */
  readonly scheduler?: TimerScheduler;
  /**
   * inbound の `create_session` が成立したときの通知。例外は隔離する。
   *
   * `NoInfer` はコールバックから `role` の推論が広がるのを防ぐ。
   */
  readonly onSession?: (session: InboundSession<NoInfer<R>>) => void;
  /** Connection 終端の通知。一度だけ呼ぶ。例外は隔離する。 */
  readonly onClose?: (cause: Error) => void;
}

/** `createSession` に渡す reliable Session の生成条件（双方向のみ）。 */
export interface ReliableCreateSessionRequest {
  /** 作成する Session の論理名。接続内で一意であること。 */
  readonly sessionId: string;
  /** 配送種別。`reliable` は双方向のみである。 */
  readonly kind: "reliable";
  /** 許す送信方向。`reliable` は双方向のみである。 */
  readonly direction: "bidirectional";
}

/**
 * `createSession` に渡す latest Session の生成条件（一方向のみ）。
 *
 * 作成側は送信側であり、方向は役割で決まる（client は `to_server`、
 * server は `to_client`）。
 */
export interface LatestCreateSessionRequest<R extends ConnectionRole = ConnectionRole> {
  /** 作成する Session の論理名。接続内で一意であること。 */
  readonly sessionId: string;
  /** 配送種別。`latest` は一方向のみである。 */
  readonly kind: "latest";
  /** 許す送信方向。役割に応じた送信方向のみである。 */
  readonly direction: LatestSendDirectionMap[R];
}

/**
 * `createSession` に渡す Session の生成条件（合法な組合せの合併）。
 *
 * 動的な要求には最後の overload（`OutboundSession` 戻り）を使う。
 * 種別・方向・役割の不正な組合せを受ける公開 fallback は設けない。
 */
export type CreateSessionRequest<R extends ConnectionRole = ConnectionRole> =
  | ReliableCreateSessionRequest
  | LatestCreateSessionRequest<R>;

/**
 * 方向と役割の整合を確かめる。
 *
 * 作成側は送信側である。`to_client` の送信側は server、`to_server` の
 * 送信側は client、`bidirectional` は双方である。outbound（自発作成）は
 * 自側が送信側、inbound（相手作成）は自側が受信側の場合に真である。
 */
function isDirectionAllowedForRole(
  direction: SessionDirection,
  role: ConnectionRole,
  outbound: boolean,
): boolean {
  if (direction === "bidirectional") return true;
  const sender: ConnectionRole = direction === "to_client" ? "server" : "client";
  return outbound ? role === sender : role !== sender;
}

/**
 * 認可後の1つの yamux mux を所有する Connection。
 *
 * `createSession()` で Session を開き、inbound stream は
 * `create_session` ハンドシェイクの成立で Session 化して `onSession` へ
 * 通知する。`terminate()` で GoAway＋全 Session 終端＋待機破棄を行う。
 */
export class Connection<R extends ConnectionRole = ConnectionRole> {
  /** 紐付ける接続の識別子。 */
  readonly connectionId: string;
  /** この側が `client`・`server` のどちらであるか。 */
  readonly role: R;

  private readonly muxer: BridgeMuxer;
  private readonly keepalive: Keepalive;
  private readonly onSessionNotify: ((session: InboundSession<R>) => void) | undefined;
  private readonly onCloseNotify: ((cause: Error) => void) | undefined;
  /** 論理名から engine への対応表。同時に同名は一つである。 */
  private readonly sessionsById = new Map<string, SessionEngine>();
  /** yamux stream から engine への対応表。論理名表と1対1である。 */
  private readonly sessionsByStream = new Map<YamuxStream, SessionEngine>();
  /** ハンドシェイク待ちの inbound stream とその後片付け。 */
  private readonly pendingHandshakes = new Map<YamuxStream, () => void>();
  /** 終端済みか。終端後は作成を受け付けず、受信も捨てる。 */
  private terminated = false;
  /** 終端理由。`onClose` への通知内容である。 */
  private closeCause: Error | undefined;
  /** `onClose` の通知済みか。一度だけ通知する。 */
  private closeNotified = false;

  /**
   * @param options - 輸送・役割・接続識別子・通知先。
   * @throws `Error` — 輸送の向きと役割が対応しない場合。
   */
  constructor(options: ConnectionOptions<R>) {
    // ADR: 向きの不一致は全 stream の ID 割当を壊すため、mux 開始前に
    // 拒否する。client は発信側（outbound）、server は受信側（inbound）である。
    const outbound = options.transport.direction === "outbound";
    if ((options.role === "client") !== outbound) {
      throw new Error("輸送の向きと役割が対応しない（client は outbound、server は inbound）。");
    }
    this.connectionId = options.connectionId;
    this.role = options.role;
    this.onSessionNotify = options.onSession;
    this.onCloseNotify = options.onClose;
    this.muxer = bridgeMuxer()().createStreamMuxer(options.transport);
    this.observeMuxerTermination();
    this.muxer.addEventListener("stream", (event) => {
      this.onInboundStream(event.detail);
    });
    const scheduler = options.scheduler ?? defaultTimerScheduler;
    this.keepalive = new Keepalive({
      ping: () => this.muxer.ping(),
      scheduler,
      onFailure: (cause) => {
        this.terminate(cause);
      },
    });
    this.keepalive.start();
  }

  /** 終端済みか。 */
  get closed(): boolean {
    return this.terminated;
  }

  /** 登録中の Session 数。 */
  get sessionCount(): number {
    return this.sessionsById.size;
  }

  /**
   * 論理名で Session を取り出す。
   *
   * @param sessionId - 取り出す Session の論理名。
   * @returns 登録中の Session。なければ `undefined`。
   */
  getSession(sessionId: string): Session<R> | undefined {
    const engine = this.sessionsById.get(sessionId);
    // ADR: 公開型は engine そのものの狭窄型であり、同一 engine には同一物を返す。
    // ファサードを作らないため同一性・委譲・getter 追従が自明に保たれる。
    return engine === undefined ? undefined : (engine as unknown as Session<R>);
  }

  /**
   * Session を開く。
   *
   * stream を開いて `create_session` を送り、Session を登録して返す。
   * 解決はローカル処理の完了（送出受付と登録）を意味し、相手の業務受付
   * 成功ではない。以降の送受信は返した Session で行う。
   *
   * 要求の組合せごとに戻り型が決まる overload であり、動的な合法要求には
   * 最後の overload（`OutboundSession` 戻り）を使う。不正な組合せを受ける
   * 公開 fallback は設けない（実行時検証は内部に残す）。
   *
   * @param request - 論理名・種別・方向。
   * @returns 登録した Session で解ける約束。
   * @throws `Error` — 終端後・同名 Session の存在・役割と方向の不整合・
   * 輸送失敗の場合。
   */
  createSession(request: ReliableCreateSessionRequest): Promise<ReliableSession<R>>;
  createSession(request: LatestCreateSessionRequest<R>): Promise<LatestSenderSession<R>>;
  createSession(request: CreateSessionRequest<R>): Promise<OutboundSession<R>>;
  async createSession(request: CreateSessionRequest<R>): Promise<OutboundSession<R>> {
    if (this.terminated) {
      throw new Error("終端した Connection では Session を開けない。");
    }
    this.checkKindAndDirection(request.kind, request.direction);
    if (!isDirectionAllowedForRole(request.direction, this.role, true)) {
      throw new Error("役割が送信側でない方向の Session は開けない。");
    }
    if (this.sessionsById.has(request.sessionId)) {
      throw new Error("同名の Session が既に存在する。");
    }
    const stream = await this.muxer.createStream();
    // ADR: `createStream` の待ち中に終端した場合は stream を孤立させず
    // RST して捨てる。登録前のため対応表の汚染はない。
    if (this.terminated) {
      this.abortStream(stream, new Error("作成待ちの間に Connection が終了した。"));
      throw new Error("作成待ちの間に Connection が終了した。");
    }
    // ADR: 同名の再登録は終端後の `createStream` との競合で起こりうるため、
    // 送出前に再検査する。登録済みがあれば stream を捨てて拒否する。
    if (this.sessionsById.has(request.sessionId)) {
      this.abortStream(stream, new Error("同名の Session が既に存在する。"));
      throw new Error("同名の Session が既に存在する。");
    }
    let frame: Uint8Array;
    try {
      frame = encodeFrameJson({
        v: PROTOCOL_VERSION,
        type: "create_session",
        connectionId: this.connectionId,
        sessionId: request.sessionId,
        kind: request.kind,
        direction: request.direction,
      });
    } catch (cause) {
      this.abortStream(
        stream,
        cause instanceof Error ? cause : new Error("create_session の符号化に失敗した。"),
      );
      throw cause;
    }
    try {
      stream.send(frame);
    } catch (cause) {
      this.abortStream(
        stream,
        cause instanceof Error ? cause : new Error("create_session の送出に失敗した。"),
      );
      throw cause;
    }
    let session: SessionEngine;
    try {
      session = new SessionEngine({
        connectionId: this.connectionId,
        sessionId: request.sessionId,
        kind: request.kind,
        direction: request.direction,
        side: this.role,
        stream,
      });
    } catch (cause) {
      this.abortStream(
        stream,
        cause instanceof Error ? cause : new Error("Session の生成条件が不正である。"),
      );
      throw cause;
    }
    this.registerSession(session, stream);
    // ADR: `getSession` と同じく engine そのものを狭窄型で返す。overload の
    // 戻り型は呼出し側の要求の組合せで決まり、実行時の物は同一である。
    return session as unknown as OutboundSession<R>;
  }

  /**
   * Session の送信方向を正常終了する（FIN）。
   *
   * @param sessionId - 終了する Session の論理名。
   * @returns FIN 送出の完了で解ける約束。
   * @throws `Error` — 終端後・Session 不在の場合。
   */
  closeSessionWrite(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    return session.closeWrite();
  }

  /**
   * Session を即時中断する（RST）。他 Session は維持する。
   *
   * @param sessionId - 中断する Session の論理名。
   * @param error - 中断の原因。省略時は Session の中断として扱う。
   * @throws `Error` — 終端後・Session 不在の場合。
   */
  abortSession(sessionId: string, error?: Error): void {
    const session = this.requireSession(sessionId);
    session.abort(error);
  }

  /**
   * Connection を終端する。
   *
   * GoAway（muxer を閉じる）＋全 Session の `terminate`（B2 経由で
   * 未決着拒否）＋ハンドシェイク待ちの破棄を行い、`onClose` を一度だけ
   * 通知する。二重呼び出しは無視する。輸送は閉じない。
   *
   * @param reason - 終端理由。
   */
  terminate(reason: Error): void {
    if (this.terminated) return;
    this.terminated = true;
    this.closeCause = reason;
    this.keepalive.stop();
    const sessions = [...this.sessionsById.values()];
    this.sessionsById.clear();
    this.sessionsByStream.clear();
    for (const session of sessions) {
      session.terminate(reason);
    }
    const pending = [...this.pendingHandshakes.entries()];
    this.pendingHandshakes.clear();
    for (const [stream, cleanup] of pending) {
      cleanup();
      this.abortStream(stream, reason);
    }
    // ADR: GoAway 送出はベストエフォートであり終端を止めない。`muxer.close()`
    // は stream 終了を待つため待たずに放す。輸送は閉じない。
    this.muxer.close().then(
      () => undefined,
      () => undefined,
    );
    this.notifyClosed();
  }

  /** 種別と方向の組合せを確かめる。Session 構築前の stream 消費を防ぐ。 */
  private checkKindAndDirection(kind: SessionKind, direction: SessionDirection): void {
    if (kind === "reliable" && direction !== "bidirectional") {
      throw new Error("reliable セッションの `direction` は `bidirectional` であること。");
    }
    if (kind === "latest" && direction === "bidirectional") {
      throw new Error(
        "latest セッションの `direction` は `to_client` または `to_server` であること。",
      );
    }
  }

  /** 論理名で engine を取り出す。なければ拒否する。 */
  private requireSession(sessionId: string): SessionEngine {
    if (this.terminated) {
      throw new Error("終端した Connection では Session を操作できない。");
    }
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      throw new Error("指定の Session が存在しない。");
    }
    return session;
  }

  /**
   * mux 終了の観測を仕掛ける。
   *
   * 相手 GoAway（正常・異常）・輸送喪失はいずれも `onTransportClosed`・
   * `abort` を通るため、ここで終端へつなぐ。自発の `terminate()` は
   * `muxer.close()` を呼ぶだけでこの2経路を通らず、二重終了しない。
   */
  private observeMuxerTermination(): void {
    // ADR: 終了イベントを持たない `AbstractStreamMuxer` の終了を逃さない
    // ための乗っ取りである。`as` を使う理由は、具象の型が引数なしで宣言
    // しているが基底の呼び出しは引数付きであり、包む側は基底の呼び方に
    // 合わせる必要があるためである。実行時は引数が渡る。
    const originalTransportClosed = this.muxer.onTransportClosed.bind(this.muxer) as (
      cause?: Error,
    ) => void;
    this.muxer.onTransportClosed = (cause?: Error): void => {
      originalTransportClosed(cause);
      this.terminate(
        cause instanceof Error ? cause : new Error("相手が mux を終了したか輸送が閉じた。"),
      );
    };
    const originalAbort = this.muxer.abort.bind(this.muxer);
    this.muxer.abort = (cause: Error): void => {
      originalAbort(cause);
      this.terminate(cause);
    };
  }

  /** inbound stream のハンドシェイク見張りを付ける。 */
  private onInboundStream(stream: YamuxStream): void {
    if (this.terminated) {
      this.abortStream(stream, new Error("Connection が終了しているため受け付けない。"));
      return;
    }
    const decoder = new FrameDecoder();
    const cleanup = (): void => {
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("close", onClose);
      this.pendingHandshakes.delete(stream);
    };
    const onMessage = (event: StreamMessageEvent): void => {
      if (this.terminated) {
        cleanup();
        this.abortStream(stream, new Error("見張り中に Connection が終了した。"));
        return;
      }
      const data = event.data;
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data.subarray());
      let values: unknown[];
      try {
        values = decoder.push(chunk);
      } catch (cause) {
        cleanup();
        this.abortStream(
          stream,
          cause instanceof Error ? cause : new Error("framing が壊れている。"),
        );
        return;
      }
      if (values.length === 0) return;
      // ADR: 見張りを外してから Session 化する。以降の到着は輸送緩衝に溜まり、
      // Session 構築時の購読で順序どおり渡る。同一配送に2件以上載る送信
      // （create_session 直後の data の結合）は未対応であり RST で検出する。
      // 送信側は create_session 単独送出の後に Session 送信を使うこと。
      cleanup();
      this.finishHandshake(stream, values);
    };
    const onClose = (): void => {
      // 初回フレーム前の終了は誰も待たないため黙って捨てる。
      cleanup();
    };
    this.pendingHandshakes.set(stream, cleanup);
    stream.addEventListener("message", onMessage);
    stream.addEventListener("close", onClose);
  }

  /** 初回フレームを検証し、Session 化して通知する。不正は RST する。 */
  private finishHandshake(stream: YamuxStream, values: unknown[]): void {
    const fail = (message: string): void => {
      this.abortStream(stream, new Error(message));
    };
    if (values.length > 1) {
      fail("初回配送に複数件が載っている。");
      return;
    }
    let parsed: ReturnType<typeof parseBridgeMessage>;
    try {
      parsed = parseBridgeMessage(values[0]);
    } catch {
      fail("初回フレームが不正である。");
      return;
    }
    if (parsed.type !== "create_session") {
      fail("初回フレームが `create_session` ではない。");
      return;
    }
    if (parsed.connectionId !== this.connectionId) {
      fail("別の接続宛ての `create_session` である。");
      return;
    }
    if (this.terminated) {
      fail("見張り中に Connection が終了した。");
      return;
    }
    // ADR: 重複 sessionId の新規 stream は RST し、既存 Session を維持する。
    // 終了で名前は再利用できるため、存在検査は登録表の現在値で行う。
    if (this.sessionsById.has(parsed.sessionId)) {
      fail("同名の Session が既に存在する。");
      return;
    }
    if (!isDirectionAllowedForRole(parsed.direction, this.role, false)) {
      fail("役割が受信側でない方向の `create_session` である。");
      return;
    }
    let session: SessionEngine;
    try {
      session = new SessionEngine({
        connectionId: this.connectionId,
        sessionId: parsed.sessionId,
        kind: parsed.kind,
        direction: parsed.direction,
        side: this.role,
        stream,
      });
    } catch {
      fail("Session の生成条件が不正である。");
      return;
    }
    this.registerSession(session, stream);
    if (this.onSessionNotify !== undefined) {
      try {
        // ADR: 実行時検証済みの engine を `InboundSession` の狭窄型で通知する。
        this.onSessionNotify(session as unknown as InboundSession<R>);
      } catch {
        // 購読者の例外は隔離し、Session と Connection を壊さない。
      }
    }
  }

  /** engine を対応表に載せ、終端時の登録解除を仕掛ける。 */
  private registerSession(session: SessionEngine, stream: YamuxStream): void {
    this.sessionsById.set(session.sessionId, session);
    this.sessionsByStream.set(stream, session);
    session.onEnd(() => {
      // ADR: 同一性の確認なしに名前で消すと、再利用後の後継 Session を
      // 旧終了コールバックが消す。登録値と同一の場合だけ外す。
      if (this.sessionsById.get(session.sessionId) === session) {
        this.sessionsById.delete(session.sessionId);
      }
      if (this.sessionsByStream.get(stream) === session) {
        this.sessionsByStream.delete(stream);
      }
    });
  }

  /** stream を RST する。送出失敗は無視する。 */
  private abortStream(stream: YamuxStream, cause: Error): void {
    try {
      stream.abort(cause);
    } catch {
      // RST 送出の失敗は呼び出し側の処理を止めない。
    }
  }

  /** `onClose` を一度だけ通知する。購読者の例外は隔離する。 */
  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    const cause = this.closeCause ?? new Error("Connection が終了した。");
    if (this.onCloseNotify === undefined) return;
    try {
      this.onCloseNotify(cause);
    } catch {
      // 購読者の例外は隔離する。
    }
  }
}
