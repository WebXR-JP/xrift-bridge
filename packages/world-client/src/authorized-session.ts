/**
 * 認可済みセッションの会計・採番・要求応答管理。
 *
 * `auth_ok` で確定した接続セッション単位の状態を持つ。セッションを認可ごとに
 * 作り直すことで、ストリーム連番は接続試行ごとに 0 始まりになる。直近 latest
 * 記録だけは接続をまたぐローカル記録のため、実体はクライアント側が所有し、
 * セッションは参照を受け取って書き込む。
 */
import {
  PROTOCOL_VERSION,
  stringifyBridgeMessage,
  type BridgeToClientMessage,
  type CommandResponseMessage,
  type CreditMessage,
  type RequestId,
  type SessionId,
  type StreamId,
} from "bridge-protocol";
import type { EchoResult } from "./client.ts";
import { WorldClientError } from "./errors.ts";

interface PendingRequest {
  readonly resolve: (value: BridgeToClientMessage) => void;
  readonly reject: (error: WorldClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 直近 latest 記録の置き場。接続をまたぐローカル記録であり、実体は
 * クライアントが生成時に一度だけ作り、認可ごとのセッションへ渡して維持する。
 */
export type LatestSentStore = Map<StreamId, { seq: number; payload: unknown }>;

/** セッション生成時の設定。いずれも認可時に確定し、認可後は変えない。 */
export interface AuthorizedSessionOptions {
  /** 要求応答の待ち時間（ミリ秒）。 */
  readonly requestTimeoutMs: number;
  /** クレジット枯渇時に保持する reliable 待機の上限件数。 */
  readonly maxPendingReliable: number;
  /** 送信メッセージ1件の上限（UTF-8 バイト）。 */
  readonly maxMessageBytes: number;
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

/**
 * 認可済みセッション。クレジット会計・ストリーム採番・要求応答の所有者。
 *
 * 接続状態・ソケット・ペアリングは持たない。送出だけを輸送関数に委ね、
 * 接続状態の判定は呼び出し側（クライアント）が行う。
 */
export class AuthorizedSession {
  /** ブリッジが払い出した接続セッション識別子。認可後に確定する。 */
  readonly sessionId: SessionId;
  // クレジット会計（接続単位）。送信可能残数 = grantedLimit − sentReliableTotal。
  // grantedLimit: 累積付与件数（auth_ok.window が初期値、credit.limit で更新）。
  // sentReliableTotal: 実際に送出した reliable の累積件数。待機への追加では増やさない。
  // 応答の受信だけでは回復しない。
  private grantedLimit: number;
  private sentReliableTotal = 0;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly reliableQueue: Array<() => void> = [];
  private readonly streamSeq = new Map<StreamId, number>();

  /**
   * @param sessionId - 認可で確定した接続セッション識別子。
   * @param initialWindow - 初期付与（`auth_ok.window`）。会計初期化であり認可後送信の前提。
   * @param options - 生成時に確定する設定。
   * @param sendRaw - 開いたソケットへの送出。接続確認は所有側が行う。
   * @param latestSent - クライアント所有の直近記録。参照を受け取り書き込む。
   */
  constructor(
    sessionId: SessionId,
    initialWindow: number,
    private readonly options: AuthorizedSessionOptions,
    private readonly sendRaw: (text: string) => void,
    private readonly latestSent: LatestSentStore,
  ) {
    this.sessionId = sessionId;
    this.grantedLimit = initialWindow;
  }

  /**
   * 次に使う連番を読む。寸法検査・受付可否判定で落とす要求で消費しないよう、
   * 受付確定後に書き込む。
   */
  private peekSeq(streamId: StreamId): number {
    return this.streamSeq.get(streamId) ?? 0;
  }

  /**
   * 送信メッセージの寸法を検査する。超過は会計・待機枠・採番に触れずに投げる。
   *
   * @param text - 送出予定の JSON 文字列。
   */
  private assertMessageSize(text: string): void {
    if (utf8ByteLength(text) > this.options.maxMessageBytes) {
      // credit・待機枠を消費しない純粋なローカル拒否であり、切断しない。
      throw new WorldClientError(
        "MESSAGE_TOO_LARGE",
        `送信メッセージが上限（${this.options.maxMessageBytes} bytes）を超えている。`,
      );
    }
  }

  /** 送信可能残数。累積付与から累積送信を引いた値。 */
  private sendableReliable(): number {
    return this.grantedLimit - this.sentReliableTotal;
  }

  private drainReliableQueue(): void {
    while (this.sendableReliable() > 0 && this.reliableQueue.length > 0) {
      const send = this.reliableQueue.shift();
      if (send === undefined) break;
      // 実際に送出するときに1件消費する。待機への追加では消費しない。
      this.sentReliableTotal += 1;
      send();
    }
  }

  /**
   * reliable 送信の受付可否を判定する。会計・待機枠・連番のいずれも消費しない。
   *
   * 受付可能な場合は即時送出か待機かだけを返し、満杯の場合は投げる。
   * 呼び出し側は受付成功後に採番を確定し、間を空けず同期待ちなしで
   * {@link AuthorizedSession.dispatchReliable} へ渡すこと。途中で会計は変わらない。
   */
  private admitReliable(): "send" | "queue" {
    if (this.sendableReliable() > 0) {
      return "send";
    }
    if (this.reliableQueue.length >= this.options.maxPendingReliable) {
      // 黙って捨てず明示エラーにする（設計どおり）。
      throw new WorldClientError("LOCAL_QUEUE_FULL", "reliable の送信待機が満杯である。");
    }
    return "queue";
  }

  /**
   * 受付済みの reliable 送信を振り分ける。即時は会計を消費して送出し、
   * 枯渇時は待機に積む（消費は送出時に持ち越す）。
   *
   * @param admission - 直前の {@link AuthorizedSession.admitReliable} の判定結果。
   * @param send - クレジット消費時に一度だけ実行する送信処理。
   */
  private dispatchReliable(admission: "send" | "queue", send: () => void): void {
    if (admission === "send") {
      // 実際に送出するときに1件消費する。待機への追加では消費しない。
      this.sentReliableTotal += 1;
      send();
      return;
    }
    this.reliableQueue.push(send);
  }

  private waitForResponse(
    requestId: RequestId,
    timeoutMs: number | undefined,
  ): { promise: Promise<BridgeToClientMessage>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<BridgeToClientMessage>((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new WorldClientError("REQUEST_TIMEOUT", "応答の待ち時間が過ぎた。"));
      }, timeoutMs ?? this.options.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });
    return {
      promise,
      cancel: () => {
        this.pending.delete(requestId);
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  /**
   * 認可後の業務応答を待機へ配送する。対応する待機がなければ何もしない。
   *
   * @param message - `echo_response` または `command_response`。
   */
  settleResponse(message: BridgeToClientMessage): void {
    const requestId =
      message.type === "echo_response" || message.type === "command_response"
        ? message.requestId
        : null;
    if (requestId === null) return;
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }

  /**
   * 認可後の要求エラーを待機へ配送する。
   *
   * @returns 対応する待機を持ち、拒否した場合は `true`。
   */
  rejectRequest(requestId: RequestId, code: string, message: string): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(new WorldClientError(code, message));
    return true;
  }

  /**
   * 待機中の要求を結果不明として破棄する。切断・認可後プロトコルエラー時に使う。
   *
   * @param error - 待機の拒否理由。
   */
  failPending(error: WorldClientError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.reliableQueue.length = 0;
  }

  /**
   * `credit` を会計へ適用する。セッション不一致・減少通知は無視し、
   * 同値再通知は差分が生じないため追加付与にならない。
   */
  handleCredit(message: CreditMessage): void {
    // セッション不一致の credit は会計へ適用しない。同じ limit の再通知は
    // 差分が生じないため追加付与にならない。応答の受信だけでは回復しない。
    if (message.sessionId !== this.sessionId) return;
    // 減少通知は古い会計値の誤再通知として無視し、付与済みの送信権を撤回しない。
    // エラー通知・切断はしない。
    if (message.limit < this.grantedLimit) return;
    this.grantedLimit = message.limit;
    this.drainReliableQueue();
  }

  /** reliable の echo を往復させる。送信メッセージが上限を超える場合は拒否する。 */
  sendEcho(
    streamId: StreamId,
    payload: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<EchoResult> {
    const seq = this.peekSeq(streamId);
    const requestId: RequestId = crypto.randomUUID();
    const text = stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "echo",
      sessionId: this.sessionId,
      streamId,
      kind: "reliable",
      seq,
      requestId,
      payload,
    });
    // 寸法検査→受付可否判定の順で、拒否時は採番・待機枠・会計のいずれも消費しない。
    let echoAdmission: "send" | "queue";
    try {
      this.assertMessageSize(text);
      echoAdmission = this.admitReliable();
    } catch (error) {
      // 本 API は Promise で結果を返す契約のため、同期の検査落ちも拒否に載せる。
      return Promise.reject(error);
    }
    // 受付確定時に採番する。待機中の複数件は異なる増加連番を持ち、
    // ローカル拒否ではここに到達しないため連番を消費しない。
    this.streamSeq.set(streamId, seq + 1);
    const waiting = this.waitForResponse(requestId, options?.timeoutMs);
    try {
      this.dispatchReliable(echoAdmission, () => {
        this.sendRaw(text);
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
  }

  /** コマンドを送り `requestId` 対応の応答を待つ。送信メッセージが上限を超える場合は拒否する。 */
  sendCommand(
    streamId: StreamId,
    command: string,
    params?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<CommandResponseMessage> {
    const seq = this.peekSeq(streamId);
    const requestId: RequestId = crypto.randomUUID();
    const text = stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "command_request",
      sessionId: this.sessionId,
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
      this.assertMessageSize(text);
      commandAdmission = this.admitReliable();
    } catch (error) {
      // 本 API は Promise で結果を返す契約のため、同期の検査落ちも拒否に載せる。
      return Promise.reject(error);
    }
    // 受付確定時に採番する。待機中の複数件は異なる増加連番を持ち、
    // ローカル拒否ではここに到達しないため連番を消費しない。
    this.streamSeq.set(streamId, seq + 1);
    const waiting = this.waitForResponse(requestId, options?.timeoutMs);
    try {
      this.dispatchReliable(commandAdmission, () => {
        this.sendRaw(text);
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
  }

  /**
   * latest 値を送る。同一ストリームの直近送信値を置換して保持する。
   *
   * 応答は待たない。欠番を許容する。送信メッセージが上限を超える場合は拒否する。
   */
  sendLatest(streamId: StreamId, payload: unknown): number {
    const seq = this.peekSeq(streamId);
    const text = stringifyBridgeMessage({
      v: PROTOCOL_VERSION,
      type: "data",
      sessionId: this.sessionId,
      streamId,
      kind: "latest",
      seq,
      payload,
    });
    // 受付前に検査し、超過は保持の更新・採番をせずに投げる。
    this.assertMessageSize(text);
    this.streamSeq.set(streamId, seq + 1);
    this.latestSent.set(streamId, { seq, payload });
    this.sendRaw(text);
    return seq;
  }

  /** 直近に送信した latest 値。未送信なら `undefined`。 */
  getLatestSent(streamId: StreamId): unknown {
    return this.latestSent.get(streamId)?.payload;
  }
}
