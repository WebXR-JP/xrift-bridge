/**
 * `node:dgram` による受信専用ソケット（本体の既定 factory）。
 *
 * 1 ソケット 1 bind で使い、再 bind しない。送信メソッドは作らない。
 * `close()` は閉塞標識と完了約束で冪等化する（`node:dgram` の `close` は
 * 冪等でなく、2 回呼ぶと `TypeError` になる）。bind 確定前の `close()` は
 * 保留中の `bind()` を閉塞理由で必ず決着（reject）させてから閉じるため、
 * bind 途中の close も同じ口で安全に行える。
 *
 * @packageDocumentation
 */
import dgram from "node:dgram";
import type { UdpReceiverSocket, UdpSocketAddress, UdpSocketFactory } from "./udp-socket.ts";

/**
 * 閉塞により確定前の `bind()` を取り消した理由。
 *
 * 本体は世代番号で取消を判定するため文言依存は無いが、試験で識別できる
 * よう名前を固定する。
 */
export class UdpSocketClosedError extends Error {
  /** @param message - 取消の説明。 */
  constructor(message = "閉塞のため確定前の bind を取り消した。") {
    super(message);
    this.name = "UdpSocketClosedError";
  }
}

/** 確定前の `bind()` の決着口と待機リスナ。 */
interface PendingBind {
  /** bind 失敗として決着させる口。 */
  readonly reject: (error: Error) => void;
  /** `listening` 待機リスナ（解除用）。 */
  readonly onListening: () => void;
  /** `error` 待機リスナ（解除用）。 */
  readonly onError: (error: Error) => void;
}

/** `node:dgram` 背負いの受信専用ソケット。 */
class NodeUdpReceiverSocket implements UdpReceiverSocket {
  private readonly socket: dgram.Socket;
  private bindUsed = false;
  private closeRequested = false;
  private closeDone: Promise<void> | null = null;
  private pendingBind: PendingBind | null = null;

  /**
   * @param type - ソケット種別。
   * @param ipv6Only - IPv6 の待受けを IPv6 のみに限るか。
   */
  constructor(type: "udp4" | "udp6", ipv6Only: boolean) {
    // ADR: `udp4` には `ipv6Only` を渡さない。種別外の選択肢の混入を避け、
    // IPv6 の二重待受け（dual-stack）を明示的に切るためである。
    const socket =
      type === "udp6" ? dgram.createSocket({ type, ipv6Only }) : dgram.createSocket(type);
    // ADR: `unref` は終了補助にのみ使う。受信待機が過程を生かし続けないための
    // 措置であり、`close` の代用にはしない（閉塞は必ず `close()` で行う）。
    socket.unref();
    this.socket = socket;
  }

  /** {@inheritDoc UdpReceiverSocket.bind} */
  bind(address: string, port: number): Promise<UdpSocketAddress> {
    if (this.closeRequested) {
      return Promise.reject(new Error("閉塞済みのソケットには bind できない。"));
    }
    if (this.bindUsed) {
      return Promise.reject(new Error("このソケットは bind 済みである（1 socket 1 bind）。"));
    }
    this.bindUsed = true;
    return new Promise<UdpSocketAddress>((resolve, reject) => {
      const onListening = (): void => {
        this.pendingBind = null;
        this.socket.removeListener("error", onError);
        const actual = this.socket.address();
        // ADR: `family` の型が将来広がっても受信側の二値に潰す。IPv6 以外は
        // IPv4 扱いであり、未知の族名を持ち込まない。
        const family = actual.family === "IPv6" ? ("IPv6" as const) : ("IPv4" as const);
        resolve({ address: actual.address, port: actual.port, family });
      };
      const onError = (error: Error): void => {
        this.pendingBind = null;
        this.socket.removeListener("listening", onListening);
        reject(error);
      };
      // ADR: bind 成否の確定に `once` を使う。bind 失敗時の `error` はここで
      // 消費し、実行時の恒常購読（`onError`）とは分ける。確定後は互いの片方を
      // 外し、遅延発火の混入を防ぐ。
      // ADR: 確定前の `close()` は保留を閉塞理由で決着させる。`dgram` は確定前
      // の close で `listening` も `error` も発火しないため、放置すると `bind()`
      // の約束が永久に未解決になる。待機リスナを外して一度だけ reject する。
      this.pendingBind = { reject, onListening, onError };
      this.socket.once("listening", onListening);
      this.socket.once("error", onError);
      this.socket.bind(port, address);
    });
  }

  /** {@inheritDoc UdpReceiverSocket.onMessage} */
  onMessage(cb: (data: Uint8Array, rinfo: { address: string; port: number }) => void): () => void {
    const listener = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      // ADR: 受信 buffer の写しを渡す。`Buffer` の共有域をそのまま渡すと、
      // 後の受信で内容が変わり得るためである。
      const copy = new Uint8Array(msg);
      try {
        cb(copy, { address: rinfo.address, port: rinfo.port });
      } catch {
        // 購読者の例外で受信を止めない。
      }
    };
    this.socket.on("message", listener);
    return () => {
      this.socket.removeListener("message", listener);
    };
  }

  /** {@inheritDoc UdpReceiverSocket.onError} */
  onError(cb: (error: unknown) => void): () => void {
    const listener = (error: Error): void => {
      try {
        cb(error);
      } catch {
        // 購読者の例外で受信を止めない。
      }
    };
    this.socket.on("error", listener);
    return () => {
      this.socket.removeListener("error", listener);
    };
  }

  /** {@inheritDoc UdpReceiverSocket.close} */
  close(): Promise<void> {
    // ADR: `close()` は冪等でない（2 回呼ぶと `TypeError`）ため、完了約束を
    // 保持して冪等化する。確定前の close は保留中の `bind()` を閉塞理由で
    // 一度だけ決着させ、待機リスナを外す。確定後の close は従来どおり閉じる。
    if (this.closeDone !== null) return this.closeDone;
    this.closeRequested = true;
    const pending = this.pendingBind;
    this.pendingBind = null;
    if (pending !== null) {
      this.socket.removeListener("listening", pending.onListening);
      this.socket.removeListener("error", pending.onError);
      pending.reject(new UdpSocketClosedError());
    }
    this.closeDone = new Promise<void>((resolve) => {
      const done = (): void => {
        resolve();
      };
      try {
        this.socket.close(done);
      } catch {
        // 閉塞済み等の同期失敗は完了扱いにする。
        done();
      }
    });
    return this.closeDone;
  }
}

/**
 * `node:dgram` 背負いの既定 factory。
 *
 * 本体の生成時に使う正本であり、テストでは偽 factory に差し替える。
 */
export const createNodeUdpSocket: UdpSocketFactory = (options) =>
  new NodeUdpReceiverSocket(options.type, options.ipv6Only ?? true);
