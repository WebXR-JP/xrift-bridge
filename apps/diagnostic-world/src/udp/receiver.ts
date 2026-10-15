/**
 * UDPデータグラム転送の受信手順。React・R3F・DOM に依存しない。
 *
 * 認可済みの管理口から in-world 表示板が開いた UDP 専用セッション（論理名 `udp`、
 * `reliable`・`bidirectional`）に結線し、UDPプラグインから転送される受信データグラムを
 * 受けて表示用状態へ反映する。echo／ping（`diag-echo`・`diag-ping`）・テキスト（`text`）とは
 * 別セッションであり、この受信の異常終了で診断セッションや Connection を閉じない。
 *
 * 受信検証は契約（`bridge-plugin-udp/contract`）の `isUdpDatagramMessage` に寄せ、
 * 不正な転送は無視して数える（当該セッションも Connection も閉じない）。
 * 復号済みデータは直近1件だけ保持し、履歴は残さない。逆方向の送信（ack 等）はしない。
 * 送信元・長さ・先頭プレビューは表示専用の写しにだけ置き、診断証拠 JSON・ログ・
 * 同期状態に含めない。
 *
 * @packageDocumentation
 */
import { decodeUdpData, isUdpDatagramMessage, type UdpSource } from "bridge-plugin-udp/contract";
import type { ReliableSession } from "world-client";

/** UDP受信の状態。直近データグラムの有無と専用セッションの終端を表す。 */
export type UdpReceiveStatus = "waiting" | "received" | "ended";

/** 先頭プレビューに載せるバイト数。 */
export const UDP_PREVIEW_BYTES = 32;

/** 購読者へ配るUDP受信用の写し。復号内容は表示専用であり証拠に含めない。 */
export interface UdpSnapshot {
  /** 受信状態。待機・受信済み・中断のいずれかである。 */
  readonly status: UdpReceiveStatus;
  /** 正規データグラムの累計受信件数。表示更新の間引きでも欠けない。 */
  readonly receivedCount: number;
  /** 復号済みバイト列の累計（バイト）。表示更新の間引きでも欠けない。 */
  readonly receivedBytes: number;
  /** 不正形状として無視した累計件数。 */
  readonly invalidCount: number;
  /** 直近データグラムの送信元。未受信では `null`。 */
  readonly source: UdpSource | null;
  /** 直近データグラムの長さ（バイト）。未受信では `null`。 */
  readonly byteLength: number | null;
  /**
   * 直近データグラムの先頭 `UDP_PREVIEW_BYTES` バイトのhex（小文字・区切りなし）。
   * 未受信では `null`。空データグラムでは空文字列。
   */
  readonly previewHex: string | null;
}

/** 写しを受け取る購読者。 */
export type UdpListener = (snapshot: UdpSnapshot) => void;

/** 受信手順の生成条件。開設済みのUDP専用セッションを受け取る。 */
export interface UdpReceiverOptions {
  /** 表示板が認可済み管理口から開いたUDP専用セッション。 */
  readonly session: ReliableSession;
}

/**
 * UDPデータグラム転送の受信手順。受信・表示用状態・後片付けを所有し、
 * `dispose` で終える。逆方向の送信はしない。
 */
export class UdpReceiver {
  private readonly session: ReliableSession;
  private readonly listeners = new Set<UdpListener>();
  private status: UdpReceiveStatus = "waiting";
  private receivedCount = 0;
  private receivedBytes = 0;
  private invalidCount = 0;
  private source: UdpSource | null = null;
  private byteLength: number | null = null;
  private previewHex: string | null = null;
  private readonly unsubs: Array<() => void> = [];
  private disposed = false;

  /**
   * 受信手順を生成し、専用セッションへの購読を始める。接続は行わない。
   *
   * @param options - 開設済みのUDP専用セッション。
   */
  constructor(options: UdpReceiverOptions) {
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

  /** 現在の表示用写しを返す。復号内容は表示専用であり証拠に含めない。 */
  getSnapshot(): UdpSnapshot {
    return {
      status: this.status,
      receivedCount: this.receivedCount,
      receivedBytes: this.receivedBytes,
      invalidCount: this.invalidCount,
      source: this.source === null ? null : { ...this.source },
      byteLength: this.byteLength,
      previewHex: this.previewHex,
    };
  }

  /**
   * 表示用写しを購読する。戻り値で解除できる。
   *
   * @param listener - 写しを受け取る購読者。
   * @returns 購読の解除関数。
   */
  subscribe(listener: UdpListener): () => void {
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
    // ADR: 不正な転送は無視して数え、セッションも Connection も閉じない。
    // 未知の拡張・上限超過を局所化し、後続の正規転送を受け付けるためである。
    if (!isUdpDatagramMessage(payload)) {
      this.invalidCount += 1;
      this.emit();
      return;
    }
    // ADR: `isUdpDatagramMessage` が復号と上限を検証済みのため、ここでの復号は
    // 失敗しない。復号済みデータは直近1件だけ保持し、履歴は残さない。
    const data = decodeUdpData(payload.dataBase64);
    // ADR: 写しには生バイト列を載せない。JSON 化時の証拠・ログへの混入を避けるため、
    // 表示に必要な送信元・長さ・先頭プレビューだけを残す。
    this.status = "received";
    this.receivedCount += 1;
    this.receivedBytes += data.length;
    this.source = { address: payload.source.address, port: payload.source.port };
    this.byteLength = data.length;
    this.previewHex = toPreviewHex(data);
    this.emit();
  }

  private handleTerminated(): void {
    if (this.disposed) return;
    if (this.status === "ended") return;
    // ADR: 専用セッションの終端は中断表示に留め、直近データ・統計は残す。
    // 直近を消すのは切断・再接続時（生成側 effect の破棄・再生成）だけである。
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

/**
 * 先頭 `UDP_PREVIEW_BYTES` バイトをhex（小文字・区切りなし）にする。
 *
 * @param data - 復号済みバイト列。変更しない。
 * @returns 先頭のhex。空データグラムでは空文字列。
 */
function toPreviewHex(data: Uint8Array): string {
  const head = data.subarray(0, UDP_PREVIEW_BYTES);
  let out = "";
  for (const byte of head) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
