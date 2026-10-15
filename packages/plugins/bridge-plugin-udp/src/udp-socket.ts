/**
 * 受信専用 UDP ソケットの抽象（テスト注入用）。
 *
 * 本体（`plugin.ts`）は UDP 受信にこの口だけを使い、`node:dgram` を直接
 * 触らない。送信メソッドは持たない（片方向転送のため）。
 * 生成時の `socketFactory` 差替えで偽ソケットを注入し、本体と OS 資源を
 * 分けて検証する。実行時依存を持たず、型だけからなる。
 *
 * @packageDocumentation
 */

/**
 * bind 後に確定した実際の待受け先。
 */
export interface UdpSocketAddress {
  /** 確定した待受けアドレス表記。 */
  readonly address: string;
  /** 確定した待受けポート番号。 */
  readonly port: number;
  /** 確定したアドレス族。 */
  readonly family: "IPv4" | "IPv6";
}

/**
 * 受信専用 UDP ソケット。
 *
 * 1 ソケット 1 bind で使い、再 bind しない。`close()` 完了後は再利用しない。
 * 実装者は `close()` を冪等にすること（`node:dgram` の `close` は冪等でない）。
 */
export interface UdpReceiverSocket {
  /**
   * 指定先へ bind する。
   *
   * @param address - 待受けアドレスの数値リテラル。
   * @param port - 待受けポート番号（1..65535）。
   * @returns 確定した待受け先。失敗時は拒否する（`EADDRINUSE` 等）。
   */
  bind(address: string, port: number): Promise<UdpSocketAddress>;
  /**
   * データグラム受信を購読する。
   *
   * @param cb - 受信バイト列と送信者を受け取る処理。例外は隔離すること。
   * @returns 購読解除。
   */
  onMessage(cb: (data: Uint8Array, rinfo: { address: string; port: number }) => void): () => void;
  /**
   * ソケット異常を購読する。
   *
   * @param cb - 異常を受け取る処理。例外は隔離すること。
   * @returns 購読解除。
   */
  onError(cb: (error: unknown) => void): () => void;
  // ADR: `node:dgram` は確定前の close で `listening` も `error` も発火せず、
  // 放置すると `bind()` の約束が永久に未解決になる。bind 途中の close も同じ口で
  // 安全に行えるよう、保留中の `bind()` の決着まで実装者が責を負う。
  /**
   * ソケットを閉じる。冪等であり、何度呼んでも同じ完了を返す。
   *
   * 確定前の `bind()` を保留している間に呼ばれた場合、その `bind()` を拒否して
   * 必ず決着させる。未決着のまま残さない。
   *
   * @returns 閉塞の完了で解ける約束。
   */
  close(): Promise<void>;
}

/**
 * 受信専用ソケットの生成口。
 *
 * 本体の生成時に差し替え、テストでは偽ソケットを返す factory を渡す。
 * 利用者の bind 設定とは分け、実行時に切り替えない。
 */
export type UdpSocketFactory = (options: {
  /** ソケット種別。IPv6 は `ipv6Only` と組み合わせる。 */
  readonly type: "udp4" | "udp6";
  /** IPv6 の待受けを IPv6 のみに限るか。`udp4` では使わない。 */
  readonly ipv6Only?: boolean;
}) => UdpReceiverSocket;
