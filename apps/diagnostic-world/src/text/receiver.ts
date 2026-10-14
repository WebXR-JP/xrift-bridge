/**
 * テキスト表示要求の受信手順。React・R3F・DOM に依存しない。
 *
 * 認可済みの管理口から 3D盤が開いたテキスト専用セッション（論理名 `text`、
 * `reliable`・`bidirectional`）に結線し、PC からの表示要求を受けて表示用状態へ
 * 反映してから反映確認を返す。echo／ping（`diag-echo`・`diag-ping`）とは別
 * セッションであり、この受信の異常終了で診断セッションや Connection を閉じない。
 *
 * 受信検証は契約（`bridge-plugin-text/contract`）の `isTextShowRequest` に寄せ、
 * 本文の解釈（HTML・Markdown・コマンド実行）はしない。反映確認は「表示用状態に
 * 反映した」の意味であり、描画完了を保証しない。不正な表示要求は無視し、当該
 * セッションも Connection も閉じない（後続の正規要求を受け付けるため）。
 * 本文は表示専用の写しにだけ置き、診断証拠 JSON・ログ・同期状態に含めない。
 *
 * @packageDocumentation
 */
import { TEXT_SHOWN_OP, isTextShowRequest, type TextShownAck } from "bridge-plugin-text/contract";
import type { ReliableSession } from "world-client";

/** テキスト受信の状態。直近本文の有無と専用セッションの終端を表す。 */
export type TextReceiveStatus = "waiting" | "received" | "ended";

/** 購読者へ配るテキスト表示用の写し。本文は表示専用であり証拠に含めない。 */
export interface TextSnapshot {
  /** 受信状態。待機・受信済み・中断のいずれかである。 */
  readonly status: TextReceiveStatus;
  /** 直近の本文。未受信・中断前未受信では `null`。 */
  readonly text: string | null;
  /** 直近の表示要求の相関識別子。未受信では `null`。 */
  readonly id: string | null;
}

/** 写しを受け取る購読者。 */
export type TextListener = (snapshot: TextSnapshot) => void;

/** 受信手順の生成条件。開設済みのテキスト専用セッションを受け取る。 */
export interface TextReceiverOptions {
  /** 3D盤が認可済み管理口から開いたテキスト専用セッション。 */
  readonly session: ReliableSession;
}

/**
 * テキスト表示要求の受信手順。受信・表示用状態・反映確認・後片付けを所有し、
 * `dispose` で終える。
 */
export class TextReceiver {
  private readonly session: ReliableSession;
  private readonly listeners = new Set<TextListener>();
  private status: TextReceiveStatus = "waiting";
  private text: string | null = null;
  private id: string | null = null;
  private readonly unsubs: Array<() => void> = [];
  private disposed = false;

  /**
   * 受信手順を生成し、専用セッションへの購読を始める。接続は行わない。
   *
   * @param options - 開設済みのテキスト専用セッション。
   */
  constructor(options: TextReceiverOptions) {
    this.session = options.session;
    this.unsubs.push(
      this.session.onMessage((payload) => {
        this.handleMessage(payload);
      }),
      this.session.onRemoteEnd(() => {
        this.handleTerminated();
      }),
      this.session.onEnd(() => {
        this.handleTerminated();
      }),
    );
  }

  /** 現在の表示用写しを返す。本文は表示専用であり証拠に含めない。 */
  getSnapshot(): TextSnapshot {
    return { status: this.status, text: this.text, id: this.id };
  }

  /**
   * 表示用写しを購読する。戻り値で解除できる。
   *
   * @param listener - 写しを受け取る購読者。
   * @returns 購読の解除関数。
   */
  subscribe(listener: TextListener): () => void {
    if (this.disposed) {
      throw new Error("破棄済みの受信手順は購読できない。");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 購読を終える。専用セッション自体は中断しない。
   *
   * セッションの破棄（`abort`）は生成した側の effect が担い、ここでは購読解除と
   * 通知停止だけを行う。以降の受信は反映せず、購読者へは通知しない。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const unsubscribe of this.unsubs.splice(0, this.unsubs.length)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は無視する。
      }
    }
  }

  private handleMessage(payload: unknown): void {
    if (this.disposed) return;
    // ADR: 不正な表示要求は無視し、セッションも Connection も閉じない。
    // 未知の拡張・遅延重複を局所化し、後続の正規要求を受け付けるためである。
    if (!isTextShowRequest(payload)) return;
    // ADR: 状態反映を先に行い、その後に反映確認を送る。確認の送出完了は
    // ローカル処理の完了であり、相手の受領ではない。送出失敗は終端通知に任せる。
    this.status = "received";
    this.text = payload.text;
    this.id = payload.id;
    this.emit();
    const ack: TextShownAck = { op: TEXT_SHOWN_OP, id: payload.id };
    void this.session.sendReliable(ack).catch(() => {
      // 送出失敗は終端通知（`onEnd`）で中断表示に反映するため、ここでは握りつぶす。
    });
  }

  private handleTerminated(): void {
    if (this.disposed) return;
    if (this.status === "ended") return;
    // ADR: 専用セッションの終端は中断表示に留め、直近本文は残す。
    // 本文を消すのは切断・再接続時（生成側 effect の破棄・再生成）だけである。
    // 診断セッションや Connection には触れない。
    this.status = "ended";
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // 購読者の例外で受信状態を壊さないため握りつぶす。
      }
    }
  }
}
