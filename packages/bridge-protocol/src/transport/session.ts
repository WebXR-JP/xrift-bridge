/**
 * yamux stream 上のアプリ Session（1本の stream 上での送受信と終了）。
 *
 * Connection（mux 管理・create_session ハンドシェイク・keepalive）は扱わない。
 * この単位は1本の yamux stream に結び付いた Session の送受信と終了だけを担う。
 * 送信は framing（固定4バイト長＋UTF-8 JSON）し、payload は Unit A の
 * `DataMessage`（`type:"data"`、`connectionId`、`sessionId`、`payload`、
 * latest のみ `seq`）に沿わせる。`create_session` は扱わず、届けば境界違反とする。
 *
 * タイマーは使わない。待機は stream の `drain`・`idle`・`close`・`end` 配送と
 * 終端通知の競合だけで解く。
 *
 * @packageDocumentation
 */

import type { StreamCloseEvent, StreamMessageEvent } from "@libp2p/interface";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import {
  PROTOCOL_VERSION,
  type DataMessage,
  type SessionDirection,
  type SessionKind,
} from "../messages.ts";
import { isJsonValue, parseBridgeMessage } from "../validate.ts";
import { FrameDecoder, FrameRejectedError, encodeFrameJson } from "./framing.ts";

/** Session が属する側。送信可否は `direction` との組合せで決まる。 */
export type SessionSide = "client" | "server";

/** Session の生成条件。 */
export interface SessionOptions {
  /** 紐付ける接続の識別子。送受信する `data` に載せる。 */
  readonly connectionId: string;
  /** この Session の論理名。送受信する `data` に載せ照合する。 */
  readonly sessionId: string;
  /** 配送種別。`reliable` は双方向のみ、`latest` は一方向のみである。 */
  readonly kind: SessionKind;
  /** 許す送信方向。 */
  readonly direction: SessionDirection;
  /** この側が `client`・`server` のどちらであるか。 */
  readonly side: SessionSide;
  /** この Session が使う yamux stream。 */
  readonly stream: YamuxStream;
  /**
   * 所有 Connection の終端状態の参照口。省略時は終端していないものとして扱う。
   *
   * `Connection.terminate()` は終端確定後に各 Session を終端するため、
   * 参照できれば兄弟 Session も即時に終了扱いになる。
   */
  readonly isConnectionTerminated?: () => boolean;
}

/** Session 全体の終端理由の種別。 */
export type SessionEndKind =
  /** 両方向の FIN が揃った正常終了。 */
  | "closed"
  /** RST による即時中断（自発・相手由来を問わない）。 */
  | "aborted"
  /** Connection 終了に伴う終端。 */
  | "connection-closed"
  /** 方向・種別・形状の境界違反。 */
  | "protocol-violation"
  /** framing 異常（超過・破損・UTF-8 不正・0-byte・途中 FIN）。 */
  | "framing-error";

/** Session 全体の終端内容。購読者への通知内容である。 */
export interface SessionEnd {
  readonly kind: SessionEndKind;
  readonly error?: Error;
}

/** `terminate` に渡す理由。`Error` は Connection 終了扱いになる。 */
export type SessionTerminateReason = SessionEnd | Error;

/** Session の使い方の誤りを表す符号。 */
export type SessionErrorCode =
  /** 送信・受信が許されない方向への操作・到着。 */
  | "direction-violation"
  /** `kind` と送信 API の不一致・生成条件の不一致・受信の種別違反。 */
  | "kind-violation"
  /** 形状・宛先などの受信境界違反。 */
  | "protocol-violation"
  /** 終端後の操作。 */
  | "session-closed"
  /** `closeWrite` 後の送信。 */
  | "write-closed";

/**
 * Session の使い方の誤り（投入前拒否・同期 throw 用）。
 *
 * 受信側の方向・種別違反の原因としても使い、終端理由の `error` に載せる。
 */
export class SessionError extends Error {
  /** 機械可読の符号。 */
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

/** 受付済み reliable 送信1件。 */
interface PendingReliable {
  /** 受付時に確定した送信用バイト列（prefix＋本体）。 */
  readonly bytes: Uint8Array;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** 未知値を `Error` に寄せる。 */
function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/**
 * 1本の yamux stream 上でのアプリ Session の送受信と終了（内部の状態機械）。
 *
 * 公開する capability 別の見え方は `session-types.ts` が定め、`Connection` は
 * この engine そのものを狭窄型で返す。送信可否・受信可否は `direction` と
 * `side` の組合せで決まる（`to_client` は server が送信・client が受信、
 * `to_server` は逆、`bidirectional` は双方）。受信した `data` の購読と終端通知は
 * `onMessage`・`onRemoteEnd`・`onEnd` で受ける。購読者の例外は隔離し、
 * Session 内部を壊さない。
 */
export class SessionEngine {
  /** 紐付ける接続の識別子。 */
  readonly connectionId: string;
  /** この Session の論理名。 */
  readonly sessionId: string;
  /** 配送種別。 */
  readonly kind: SessionKind;
  /** 許す送信方向。 */
  readonly direction: SessionDirection;
  /** この側が `client`・`server` のどちらであるか。 */
  readonly side: SessionSide;

  private readonly stream: YamuxStream;
  private readonly decoder = new FrameDecoder();
  private readonly isConnectionTerminated: () => boolean;
  private readonly sendable: boolean;
  private readonly receivable: boolean;

  /** 全体終端済みか。終端後は送信を受け付けず、受信も捨てる。 */
  private terminated = false;
  /** 終端内容。終端後に登録した購読者へそのまま渡す。 */
  private terminalEnd: SessionEnd | undefined;
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  /** 購読登録前に届いた payload の待避列。登録時に順序どおり渡す。 */
  private readonly pendingMessages: unknown[] = [];
  private terminateResolve: (() => void) | undefined;
  /** 全体終端で解ける待ち。`closeWrite` の FIN 待ちと競合させる。 */
  private readonly terminatedPromise: Promise<void>;
  /** 終端時に輸送待ちを解くための掛け口。タイマーではない。 */
  private readonly terminationHooks = new Set<() => void>();

  /** 自側の送信終了（`closeWrite` 受付）済みか。 */
  private writeClosed = false;
  private closeWritePromise: Promise<void> | undefined;
  /** 自側の FIN 送出済みか。 */
  private localFinSent = false;
  /** FIN 送出中（`stream.close()` 実行中）か。送出直後の `close` 配送の判定に使う。 */
  private finSending = false;
  /** 相手 FIN の観測（`remoteCloseWrite` 到着）済みか。 */
  private remoteFinSeen = false;
  /** 相手 FIN の処理（EOF 通知）済みか。 */
  private remoteEnded = false;

  private reliableQueue: PendingReliable[] = [];
  private reliablePumping = false;
  private reliableRun: Promise<void> | undefined;

  private latestBusy = false;
  private latestPumping = false;
  private latestInflight: Uint8Array | undefined;
  private latestPending: Uint8Array | undefined;
  private latestRun: Promise<void> | undefined;
  /** 送信受付ごとに進める outbound 連番。置換で消える値も消費する。 */
  private nextOutboundSeq = 0;

  /** 受け渡し済みの受信件数。 */
  private receivedMessages = 0;
  /** latest で古い・同値のため捨てた受信件数。 */
  private droppedStaleMessages = 0;
  /** latest で飛び越えた連番の合計（欠番の計数）。 */
  private missingSeqTotal = 0;
  /** latest の受信連番の最大値。未受信は -1 である。 */
  private lastReceivedSeq = -1;

  /**
   * @param options - 接続・論理名・種別・方向・側・使う stream。
   * @throws `SessionError` — `kind` と `direction` の組合せが不正の場合。
   */
  constructor(options: SessionOptions) {
    // ADR: `kind` と `direction` の組合せは型でも表すが、Session 境界でも
    // 検証する。reliable は双方向のみ、latest は一方向のみである。
    if (options.kind === "reliable" && options.direction !== "bidirectional") {
      throw new SessionError(
        "kind-violation",
        "reliable セッションの `direction` は `bidirectional` であること。",
      );
    }
    if (options.kind === "latest" && options.direction === "bidirectional") {
      throw new SessionError(
        "kind-violation",
        "latest セッションの `direction` は `to_client` または `to_server` であること。",
      );
    }
    this.connectionId = options.connectionId;
    this.sessionId = options.sessionId;
    this.kind = options.kind;
    this.direction = options.direction;
    this.side = options.side;
    this.stream = options.stream;
    this.isConnectionTerminated = options.isConnectionTerminated ?? (() => false);
    this.sendable =
      options.direction === "bidirectional" ||
      (options.direction === "to_client" && options.side === "server") ||
      (options.direction === "to_server" && options.side === "client");
    this.receivable =
      options.direction === "bidirectional" ||
      (options.direction === "to_client" && options.side === "client") ||
      (options.direction === "to_server" && options.side === "server");
    this.terminatedPromise = new Promise<void>((resolve) => {
      this.terminateResolve = resolve;
    });
    this.stream.addEventListener("message", this.onStreamMessage);
    this.stream.addEventListener("remoteCloseWrite", this.onStreamRemoteCloseWrite);
    this.stream.addEventListener("end", this.onStreamEnd);
    this.stream.addEventListener("close", this.onStreamClose);
    // ADR: 構築前に FIN が届いた stream では `end` を取りこぼすため、状態で
    // 補う。読み残しがある場合は `end` 配送が来るので何もしない。
    if (this.stream.remoteWriteStatus === "closed") this.remoteFinSeen = true;
    if (this.stream.readableEnded) this.processPeerFin();
  }

  /** この側が送信できる方向か（`direction` と `side` の組合せ）。 */
  get canSend(): boolean {
    return this.sendable;
  }

  /** この側が受信できる方向か（`direction` と `side` の組合せ）。 */
  get canReceive(): boolean {
    return this.receivable;
  }

  /** 全体終端済みか。 */
  get closed(): boolean {
    return this.terminated;
  }

  /**
   * 全体終端していなければ真（`closed` の読み替え）。
   *
   * 公開 capability 型が参照する名前であり、所有 Connection の終端開始後も
   * 偽になる（自 Session の `terminate` 前でも終了扱いである）。
   * engine を狭窄型でそのまま返すため、実行時に欠けないようここに置く。
   */
  get isAlive(): boolean {
    return !this.isEnded();
  }

  /** 自側の送信終了（`closeWrite` 受付）済みか。 */
  get writeEnded(): boolean {
    return this.writeClosed;
  }

  /** 相手 FIN の処理（EOF 通知）済みか。 */
  get peerEnded(): boolean {
    return this.remoteEnded;
  }

  /** 受け渡し済みの受信件数。 */
  get receivedCount(): number {
    return this.receivedMessages;
  }

  /** latest で古い・同値のため捨てた受信件数。 */
  get staleDroppedCount(): number {
    return this.droppedStaleMessages;
  }

  /** latest で飛び越えた連番の合計。 */
  get missingSeqCount(): number {
    return this.missingSeqTotal;
  }

  /** latest の受信連番の最大値。未受信は -1 である。 */
  get lastRecvSeq(): number {
    return this.lastReceivedSeq;
  }

  /**
   * 確実に届けたい値を送る。
   *
   * 受付時に検証・シリアライズし、Session 内で直列化する。prefix と本体は
   * 1回の `stream.send()` で一体として投入し、false でも再投入しない。
   * 下位 backpressure の解消（`writeBufferLength` と `drain`）を待って決着する。
   *
   * @param value - 配送する JSON 値（`null` を含む）。
   * @returns ローカル送信処理の完了で解ける約束。相手受信・業務完了ではない。
   */
  sendReliable(value: unknown): Promise<void> {
    const rejected = this.checkSendable("reliable");
    if (rejected !== undefined) return Promise.reject(rejected);
    if (!isJsonValue(value)) {
      return Promise.reject(
        new FrameRejectedError("payload は JSON 値であること（関数・非有限数などは送れない）。"),
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = this.buildDataBytes(value, undefined);
    } catch (error) {
      // ADR: 上限超過・シリアライズ失敗は投入前に拒否し、Session は切断しない。
      return Promise.reject(toError(error, "frame の符号化に失敗した。"));
    }
    return new Promise<void>((resolve, reject) => {
      // ADR: `encodeFrameJson` 時点で文字列化済みのため、呼出し後の参照変更の
      // 影響を受けない。queue には値ではなく確定バイト列を積む。
      this.reliableQueue.push({ bytes, resolve, reject });
      this.pumpReliable();
    });
  }

  /**
   * 最新の状態を送る（同期受付）。
   *
   * 検証後、yamux 投入前に未投入値を置換し、outbound 連番を進める。
   * 投入中1件＋未投入最新1件のみ保持し、投入済みは取り消さない。
   * 値ごとの約束は作らず、非同期失敗は Session の終端通知で知らせる。
   *
   * @param value - 配送する JSON 値（`null` を含む）。
   * @throws `SessionError` — 終端後・送信終了後・送信不可方向・種別不一致の場合。
   * @throws `FrameRejectedError` — payload 不正・上限超過・符号化失敗の場合（切断しない）。
   */
  sendLatest(value: unknown): void {
    const rejected = this.checkSendable("latest");
    if (rejected !== undefined) throw rejected;
    if (!isJsonValue(value)) {
      throw new FrameRejectedError(
        "payload は JSON 値であること（関数・非有限数などは送れない）。",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = this.buildDataBytes(value, this.nextOutboundSeq);
    } catch (error) {
      throw toError(error, "frame の符号化に失敗した。");
    }
    // ADR: 受付ごとに連番を進める。置換で消える値も連番を消費し、受信側で
    // 欠番として数えられる（鮮度は輸送全体では保証しない）。
    this.nextOutboundSeq += 1;
    if (this.latestBusy) {
      // ADR: 投入中がある場合は未投入の最新1件だけを置換する。投入済みの
      // 値は取り消さない。
      this.latestPending = bytes;
      return;
    }
    this.latestBusy = true;
    this.latestInflight = bytes;
    this.pumpLatest();
  }

  /**
   * 受信した payload を購読する。
   *
   * 登録前の到着分は順序どおり渡す。購読者の例外は隔離する。
   *
   * @param handler - payload を受け取る処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onMessage(handler: (payload: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    // ADR: 登録前の到着分を失わないため、登録時に順序どおり渡す。読み残しは
    // yamux window（256KiB）で抑えられ、アプリ層の待機上限は設けない。
    if (this.pendingMessages.length > 0) {
      const backlog = this.pendingMessages.splice(0, this.pendingMessages.length);
      for (const payload of backlog) {
        try {
          handler(payload);
        } catch {
          // 購読者の例外は隔離し、後続と Session を壊さない。
        }
      }
    }
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * 相手 FIN（読み終わり）を購読する。
   *
   * 自側の送信は継続できる。処理済みなら登録時に同期で即時通知する。
   *
   * @param handler - 相手 FIN の処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onRemoteEnd(handler: () => void): () => void {
    this.remoteEndHandlers.add(handler);
    if (this.remoteEnded) {
      try {
        handler();
      } catch {
        // 購読者の例外は隔離する。
      }
    }
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  /**
   * Session 全体の終端を購読する。一度だけ通知する。
   *
   * 終端済みなら登録時に同期で即時通知する。購読解除を通知内で呼ぶ場合は
   * 解除変数の確定前に呼ばれるため `let` で受けること。
   *
   * @param handler - 終端内容を受け取る処理。
   * @returns 購読解除。終端後の呼び出しも安全である。
   */
  onEnd(handler: (end: SessionEnd) => void): () => void {
    this.endHandlers.add(handler);
    if (this.terminated && this.terminalEnd !== undefined) {
      try {
        handler(this.terminalEnd);
      } catch {
        // 購読者の例外は隔離する。
      }
    }
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  /**
   * 送信方向を正常終了する（FIN）。
   *
   * 新規送信を止め、受付済みの排出後に FIN を送る（`stream.close()` は FIN 前に
   * idle＋drain を待つ）。逆方向の受信・送信は継続する。二重呼び出しは同じ
   * 結果を返す。正常終了も業務成功の証明ではない。
   *
   * @returns FIN 送出の完了で解ける約束。
   */
  closeWrite(): Promise<void> {
    if (this.terminated) return Promise.resolve();
    if (this.closeWritePromise !== undefined) return this.closeWritePromise;
    this.writeClosed = true;
    this.closeWritePromise = this.runCloseWrite();
    return this.closeWritePromise;
  }

  /**
   * 即時中断する（RST）。
   *
   * 待機送信・未完成フレームを破棄する。他 Session は維持する。
   * RST は「未実行」を意味しない。二重呼び出しは無視する。
   *
   * @param error - 中断の原因。省略時は Session の中断として扱う。
   */
  abort(error?: Error): void {
    if (this.terminated) return;
    const err = error ?? new SessionError("session-closed", "Session を中断した。");
    this.terminateInternal({ kind: "aborted", error: err });
    // ADR: 終端後に RST を送る。`stream.abort` の `close` 配送は終端済みの
    // ため無視され、終端理由が上書きされない。
    try {
      this.stream.abort(err);
    } catch {
      // RST 送出の失敗は終端を止めない。
    }
  }

  /**
   * Session を終端する。Connection 終了時に使う。
   *
   * 未決着の送信約束を一度だけ拒否し（二重決着しない）、drain 待ちを解く。
   * 購読者へ終端を通知する。stream には触れず、mux 終了が面倒を見る。
   * 二重呼び出しは無視する。
   *
   * @param reason - 終端理由。`Error` は Connection 終了扱いになる。
   */
  terminate(reason: SessionTerminateReason): void {
    if (this.terminated) return;
    this.terminateInternal(
      reason instanceof Error ? { kind: "connection-closed", error: reason } : reason,
    );
  }

  /** 自 Session の終端または所有 Connection の終端開始後か。 */
  private isEnded(): boolean {
    return this.terminated || this.isConnectionTerminated();
  }

  /** 送信受付の可否を確かめる。受付不可の理由を返す。 */
  private checkSendable(kind: SessionKind): SessionError | undefined {
    // ADR: 所有 Connection の終端開始後は自 Session の `terminate` 前でも
    // 受け付けない。`Connection.terminate()` は確定後に各 Session を終端する
    // ため、`onEnd` 処理中の兄弟への送信をここで塞ぐ。
    if (this.isEnded()) {
      return new SessionError("session-closed", "終端した Session には送信できない。");
    }
    if (this.writeClosed) {
      return new SessionError("write-closed", "送信終了した Session には送信できない。");
    }
    if (kind !== this.kind) {
      return new SessionError(
        "kind-violation",
        `種別 \`${this.kind}\` の Session に \`send${kind === "reliable" ? "Reliable" : "Latest"}\` は使えない。`,
      );
    }
    if (!this.sendable) {
      return new SessionError(
        "direction-violation",
        "送信が許されない方向の Session には送信できない。",
      );
    }
    return undefined;
  }

  /** 送信用の `data` バイト列を作る。受付時点で確定する。 */
  private buildDataBytes(payload: unknown, seq: number | undefined): Uint8Array {
    const message: DataMessage =
      seq === undefined
        ? {
            v: PROTOCOL_VERSION,
            type: "data",
            connectionId: this.connectionId,
            sessionId: this.sessionId,
            payload,
          }
        : {
            v: PROTOCOL_VERSION,
            type: "data",
            connectionId: this.connectionId,
            sessionId: this.sessionId,
            seq,
            payload,
          };
    return encodeFrameJson(message);
  }

  /** reliable 送信列を進める。多重起動しない。 */
  private pumpReliable(): void {
    if (this.reliablePumping) return;
    this.reliablePumping = true;
    // ADR: `runReliableQueue` は例外を外へ漏らさない作りであり、ここでの
    // 失敗時は内部で終端済みである。run の約束は `closeWrite` の排出待ちが使う。
    this.reliableRun = this.runReliableQueue().finally(() => {
      this.reliablePumping = false;
      this.reliableRun = undefined;
      // ADR: ループ終了と見張り解除の間の到着を取りこぼさない。残っていれば
      // 再始動する（到着側は見張り中のため戻っており、 orphan にならない）。
      if (!this.terminated && this.reliableQueue.length > 0) {
        this.pumpReliable();
      }
    });
  }

  /** reliable 送信列の本体。1件ずつ送り、輸送排出を待って決着する。 */
  private async runReliableQueue(): Promise<void> {
    while (!this.terminated) {
      const head = this.reliableQueue[0];
      if (head === undefined) return;
      try {
        // ADR: `send()` は1件につき一度だけ呼び、false でも再投入しない。
        // 戻り値は再投入判断に使わず、下位の排出は `writeBufferLength` と
        // `drain` で待つ。prefix＋本体は一体のバイト列であり交錯しない。
        this.stream.send(head.bytes);
      } catch (error) {
        this.reliableQueue.shift();
        head.reject(toError(error, "送信中に stream が壊れた。"));
        this.failWithRst({ kind: "aborted", error: toError(error, "送信中に stream が壊れた。") });
        return;
      }
      const flushed = await this.waitForTransportFlushed();
      // ADR: 終端時は `terminateInternal` が拒否済みであり、ここで決着しない。
      // 二重決着を防ぐため、終端を見たら抜けるだけにする。
      if (!flushed || this.terminated) return;
      this.reliableQueue.shift();
      head.resolve();
    }
  }

  /** latest 送信を進める。多重起動しない。 */
  private pumpLatest(): void {
    if (this.latestPumping) return;
    this.latestPumping = true;
    // ADR: `runLatestQueue` は例外を外へ漏らさない作りである。値ごとの約束は
    // 作らず、非同期失敗は Session の終端通知で知らせる。
    this.latestRun = this.runLatestQueue().finally(() => {
      this.latestPumping = false;
      this.latestRun = undefined;
      // ADR: `pumpReliable` と同じく、終了と解除の間の到着を取りこぼさない。
      if (
        !this.terminated &&
        (this.latestInflight !== undefined || this.latestPending !== undefined)
      ) {
        this.pumpLatest();
      }
    });
  }

  /** latest 送信の本体。未投入の最新1件を繰り上げながら送る。 */
  private async runLatestQueue(): Promise<void> {
    try {
      while (!this.terminated) {
        const inflight = this.latestInflight;
        if (inflight === undefined) return;
        try {
          this.stream.send(inflight);
        } catch (error) {
          this.failWithRst({
            kind: "aborted",
            error: toError(error, "送信中に stream が壊れた。"),
          });
          return;
        }
        const flushed = await this.waitForTransportFlushed();
        if (!flushed || this.terminated) return;
        this.latestInflight = this.latestPending;
        this.latestPending = undefined;
        if (this.latestInflight === undefined) return;
      }
    } finally {
      if (this.latestInflight === undefined && this.latestPending === undefined) {
        this.latestBusy = false;
      }
    }
  }

  /**
   * 下位輸送への排出完了を待つ。
   *
   * `writeBufferLength` が 0 かつ `drain` 不要になるまで `idle`・`drain` で
   * 待つ。`close`・終端では中断として偽を返す（呼び出し側は終端済み扱いにする）。
   *
   * @returns 排出完了なら真、中断なら偽。
   */
  private waitForTransportFlushed(): Promise<boolean> {
    if (this.terminated) return Promise.resolve(false);
    if (this.stream.writeBufferLength === 0 && !this.stream.writableNeedsDrain) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        this.stream.removeEventListener("drain", onDrain);
        this.stream.removeEventListener("idle", onIdle);
        this.stream.removeEventListener("close", onClose);
        this.terminationHooks.delete(onTerminated);
      };
      const check = (): void => {
        if (this.terminated) {
          cleanup();
          resolve(false);
          return;
        }
        if (this.stream.writeBufferLength === 0 && !this.stream.writableNeedsDrain) {
          cleanup();
          resolve(true);
        }
        // 残っていれば次の `idle`・`drain` を待つ。
      };
      const onDrain = (): void => {
        check();
      };
      const onIdle = (): void => {
        check();
      };
      const onClose = (): void => {
        cleanup();
        resolve(false);
      };
      const onTerminated = (): void => {
        cleanup();
        resolve(false);
      };
      this.stream.addEventListener("drain", onDrain);
      this.stream.addEventListener("idle", onIdle);
      this.stream.addEventListener("close", onClose);
      this.terminationHooks.add(onTerminated);
      // ADR: 登録中の変化を取りこぼさないため、登録直後に再検査する。
      check();
    });
  }

  /** `closeWrite` の本体。新規受付は止めてあり、受付済みの排出後に FIN を送る。 */
  private async runCloseWrite(): Promise<void> {
    while (!this.terminated) {
      if (this.reliableRun === undefined && this.latestRun === undefined) break;
      // ADR: 新規受付は `writeClosed` で止めてあるため、現在の run が解ければ
      // 受付済みは空である。終端と競合したら待機を解く（タイマーは使わない）。
      await Promise.race([
        ...(this.reliableRun !== undefined ? [this.reliableRun] : []),
        ...(this.latestRun !== undefined ? [this.latestRun] : []),
        this.terminatedPromise,
      ]);
    }
    if (this.terminated) return;
    // ADR: FIN 送出は `stream.close()` の途中であり、送出直後に `close` 配送が
    // 同期で来る。送出中を示して両 FIN 完了の判定に使う。完了前に終端したら
    // この値は意味を持たない（終端ガードで無視される）。
    this.finSending = true;
    try {
      // `stream.close()` は FIN 前に idle＋drain を待つ。
      await Promise.race([this.stream.close(), this.terminatedPromise]);
    } catch (error) {
      if (this.terminated) return;
      throw error;
    }
    if (this.terminated) return;
    this.localFinSent = true;
    this.maybeTerminateWhenBothFin();
  }

  /** 両方向の FIN が揃えば正常終了として終端する。 */
  private maybeTerminateWhenBothFin(): void {
    if (this.localFinSent && this.remoteEnded && !this.terminated) {
      this.terminateInternal({ kind: "closed" });
    }
  }

  /** stream の `message` 断片を framing 復元し、`data` として処理する。 */
  private readonly onStreamMessage = (event: StreamMessageEvent): void => {
    if (this.isEnded()) return;
    const data = event.data;
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data.subarray());
    let values: unknown[];
    try {
      values = this.decoder.push(chunk);
    } catch (error) {
      this.failWithRst({ kind: "framing-error", error: toError(error, "framing が壊れている。") });
      return;
    }
    for (const value of values) {
      this.handleFrameValue(value);
      if (this.isEnded()) return;
    }
  };

  /** 復元した1件を Session 境界で検証し、購読者へ渡す。 */
  private handleFrameValue(value: unknown): void {
    let message: DataMessage;
    try {
      const parsed = parseBridgeMessage(value);
      if (parsed.type !== "data") {
        throw new SessionError(
          "protocol-violation",
          "`data` 以外のメッセージが Session stream に届いた。",
        );
      }
      message = parsed;
    } catch (error) {
      this.failWithRst({
        kind: "protocol-violation",
        error: toError(error, "不正なメッセージである。"),
      });
      return;
    }
    if (message.connectionId !== this.connectionId || message.sessionId !== this.sessionId) {
      this.failWithRst({
        kind: "protocol-violation",
        error: new SessionError(
          "protocol-violation",
          "別の接続・セッション宛ての `data` が届いた。",
        ),
      });
      return;
    }
    if (!this.receivable) {
      this.failWithRst({
        kind: "protocol-violation",
        error: new SessionError(
          "direction-violation",
          "受信が許されない方向の Session に `data` が届いた。",
        ),
      });
      return;
    }
    if (this.kind === "reliable") {
      // ADR: reliable の順序は yamux stream に委ね、アプリ層 `seq` は持たない。
      // `seq` 混入は境界違反として終了する。
      if ("seq" in message) {
        this.failWithRst({
          kind: "protocol-violation",
          error: new SessionError("kind-violation", "reliable の `data` に `seq` が載っている。"),
        });
        return;
      }
      this.deliverPayload(message.payload);
      return;
    }
    if (!("seq" in message) || message.seq === undefined) {
      this.failWithRst({
        kind: "protocol-violation",
        error: new SessionError("kind-violation", "latest の `data` に `seq` がない。"),
      });
      return;
    }
    // ADR: `seq` の形式は `parseBridgeMessage` が検証済み（0 以上の安全な整数）。
    // 最新優先・欠番許容であり、受信 seq は単調に扱う。古い・同値は無視して
    // 数え、前に進んだ分の飛びは欠番として数える。
    const seq = message.seq;
    if (seq <= this.lastReceivedSeq) {
      this.droppedStaleMessages += 1;
      return;
    }
    this.missingSeqTotal += seq - this.lastReceivedSeq - 1;
    this.lastReceivedSeq = seq;
    this.deliverPayload(message.payload);
  }

  /** 受理した payload を数えて購読者へ渡す（例外は隔離、購読者不在時は待避）。 */
  private deliverPayload(payload: unknown): void {
    this.receivedMessages += 1;
    if (this.messageHandlers.size === 0) {
      this.pendingMessages.push(payload);
      return;
    }
    for (const handler of Array.from(this.messageHandlers)) {
      try {
        handler(payload);
      } catch {
        // 購読者の例外は隔離し、後続と Session を壊さない。
      }
    }
  }

  /** 相手 FIN の到着を記録する。EOF 処理は `end` 配送で行う。 */
  private readonly onStreamRemoteCloseWrite = (): void => {
    this.remoteFinSeen = true;
  };

  /** 読み終わりで相手 FIN を処理する。自発の end（中断後）は無視する。 */
  private readonly onStreamEnd = (): void => {
    if (this.terminated) return;
    if (!this.remoteFinSeen) return;
    this.processPeerFin();
  };

  /** 相手 FIN を処理する。未完成 frame が残れば途中 FIN として異常終了する。 */
  private processPeerFin(): void {
    if (this.terminated || this.remoteEnded) return;
    try {
      this.decoder.finish();
    } catch (error) {
      this.failWithRst({
        kind: "framing-error",
        error: toError(error, "未完成の frame が残ったまま FIN が届いた。"),
      });
      return;
    }
    this.remoteEnded = true;
    for (const handler of Array.from(this.remoteEndHandlers)) {
      try {
        handler();
      } catch {
        // 購読者の例外は隔離する。
      }
    }
    this.maybeTerminateWhenBothFin();
  }

  /**
   * stream の `close` を処理する。
   *
   * 自発の中断は先に終端済みのため到達しない。相手 RST は中断、両方向 FIN 済み
   * の正常な輸送終了は正常終了、それ以外の輸送終了は Connection 終了扱いにする。
   */
  private readonly onStreamClose = (event: StreamCloseEvent): void => {
    if (this.terminated) return;
    const error = event.error;
    if (error !== undefined) {
      this.terminateInternal({ kind: "aborted", error });
      return;
    }
    // ADR: `stream.close()` の内部では FIN 送出直後に `close` が同期配送される
    // ため、`localFinSent` だけでなく送出中（`finSending`）も完了扱いにする。
    // 送出中の判定時点では FIN は送出済みであり、相手 FIN と揃えば正常終了である。
    if ((this.localFinSent || this.finSending) && this.remoteEnded) {
      this.terminateInternal({ kind: "closed" });
      return;
    }
    this.terminateInternal({
      kind: "connection-closed",
      error: new SessionError("session-closed", "輸送が閉じたため Session を終了した。"),
    });
  };

  /** 境界違反・framing 異常で終端し、相手へ RST を送る。 */
  private failWithRst(end: SessionEnd): void {
    if (this.terminated) return;
    this.terminateInternal(end);
    // ADR: 終端後に RST を送る。`stream.abort` の `close` 配送は終端済みの
    // ため無視され、終端理由が上書きされない。
    try {
      this.stream.abort(
        end.error ?? new SessionError("session-closed", "Session を異常終了した。"),
      );
    } catch {
      // RST 送出の失敗は終端を止めない。
    }
  }

  /**
   * Session 終端の本体。一度だけ実行する。
   *
   * 未決着の送信約束を一度だけ拒否し（二重決着しない）、drain 待ちを解き、
   * 購読者へ通知する。
   */
  private terminateInternal(end: SessionEnd): void {
    if (this.terminated) return;
    this.terminated = true;
    this.terminalEnd = end;
    const failure =
      end.error ?? new SessionError("session-closed", "Session が終了したため送信を取り消した。");
    const pending = this.reliableQueue;
    this.reliableQueue = [];
    for (const entry of pending) {
      entry.reject(failure);
    }
    this.latestInflight = undefined;
    this.latestPending = undefined;
    for (const hook of Array.from(this.terminationHooks)) {
      try {
        hook();
      } catch {
        // 終了待ちの解除失敗は無視する。
      }
    }
    this.terminationHooks.clear();
    const resolveTerminated = this.terminateResolve;
    this.terminateResolve = undefined;
    resolveTerminated?.();
    for (const handler of Array.from(this.endHandlers)) {
      try {
        handler(end);
      } catch {
        // 購読者の例外は隔離する。
      }
    }
  }
}
