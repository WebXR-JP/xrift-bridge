/**
 * UDP子画面の固有契約の正本（`./gui-contract`）。
 *
 * RPC 契約型・限定 DTO・種別トークン・相対 entrypoint の定義元はここだけであり、
 * 重複定義を持たない。共有型（`InstanceBaseView`）だけを共有契約
 * （`bridge-gui-contract/plugin-instance`）から借りる。表示先は相対 entrypoint
 * の宣言だけを持ち、絶対 `views://` パスや子画面 URL の組み立ては持たない。
 * 解決（配置先・`views://` パス・URL 組み立て）はホスト（composition の静的
 * manifest と対応付け）が行う。子画面（`src/view/index.ts`）は同パッケージ内の
 * 相対参照、GUI 側は `bridge-plugin-udp/gui-contract` を参照する。
 *
 * 本体（`plugin.ts`）は `node:dgram` を import するため、ここからは型だけを
 * type-only で借り、実行時 import はしない。子画面・GUI から実行時に使う
 * 純粋関数・定数は `./contract` 側に置く。
 *
 * @packageDocumentation
 */
import type {
  UdpBindConfig,
  UdpControlResult,
  UdpPhase,
  UdpSocketAddress,
  UdpStartParams,
  UdpStats,
} from "./plugin.ts";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";

/**
 * UDP 個体の限定表示。payload 本文は含めない（統計だけを持つ）。
 */
export interface UdpInstanceView extends InstanceBaseView {
  /** 現在の段階。 */
  readonly phase: UdpPhase;
  /** 直近に要求した bind 設定。未開始なら `null`。 */
  readonly requestedBind: UdpBindConfig | null;
  /** 実際の待受け先。待受け中でなければ `null`。 */
  readonly boundAddress: UdpSocketAddress | null;
  /** `start()` を受け付ける状態なら真。 */
  readonly canStart: boolean;
  /** 待受け中なら真。 */
  readonly isRunning: boolean;
  /** インスタンス単位の統計。 */
  readonly stats: UdpStats;
  /** 直近の異常終了・失敗の説明。無ければ `null`。 */
  readonly lastError: string | null;
}

/**
 * UDP子画面が受け取る snapshot。
 */
export interface UdpInstanceSnapshot extends UdpInstanceView {
  /** 単調増加の改訂番号。新しいときだけ採用する。 */
  readonly revision: number;
}

/** main から UDP子画面への状態通知。最新の全状態を送る唯一の通知である。 */
export interface UdpInstanceChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: UdpInstanceSnapshot;
}

// ADR: Electrobun の `RPCSchema<I>` は `{requests, messages}` に解決される
// 構造型であり、`ElectrobunRPCSchema` 制約（`{bun, webview}`）も構造適合で
// 満たせる。そのため契約ではこの素朴な構造型で表し、`electrobun/rpc` を
// import しない（main 側のビルドを `.hutch` に依存させない）。
// 制約が構造型を拒否する場合は bridge-gui-main 側のアダプタで最小の型写像を行う。
type RpcSchema<Requests, Messages> = {
  requests: Requests;
  messages: Messages;
};

/** UDP子画面用 RPC の型。main・子画面の両方から参照する。 */
export type UdpInstanceRpc = {
  bun: RpcSchema<
    {
      /** 束縛個体の状態取得。識別子の指定は受け付けない。読み取りは revision を進めない。 */
      getUdpState: { params: {}; response: UdpInstanceSnapshot };
      /**
       * 束縛個体の UDP 受信開始。bind 設定と非 loopback 確認だけを受け、
       * 個体識別子の指定は受け付けない。main が束縛した個体に委譲する。
       */
      startUdp: { params: UdpStartParams; response: UdpControlResult };
      /** 束縛個体の UDP 受信停止。識別子の指定は受け付けない。 */
      stopUdp: { params: {}; response: UdpControlResult };
    },
    {}
  >;
  webview: RpcSchema<
    {},
    {
      /** main からの状態 push。 */
      udpStateChanged: UdpInstanceChangedMessage;
    }
  >;
};

/** UDP companion の種別トークン。マウント識別子に載る。 */
export const UDP_MOUNT_KIND = "udp";

/**
 * UDP子画面の相対 entrypoint。資産ルート（`src/view`）起点である。
 *
 * 解決済み `views://` パス・配置先・コピー表の正本はホストの静的 manifest
 * （`src/composition/bundled-plugin-assets.ts`）が持ち、ここでは相対名だけを
 * 宣言する。一致は資産の同期テストで固定する。ホストへ宣言する bundle の
 * entry はこの解決後の相対 entry（`index.html`）だけである。
 */
export const UDP_VIEW_ENTRY = "index.html";

/** UDP子画面の表示スクリプトの相対 entrypoint。 */
export const UDP_SCRIPT_ENTRY = "index.ts";

/** UDP子画面の表示様式の相対 entrypoint。 */
export const UDP_STYLE_ENTRY = "index.css";

/**
 * UDP 開始・停止 request の RPC 待機期限（ミリ秒）。
 *
 * 制御操作は手元の bind・閉塞完了待ちであり、応答待ちのような長期待機は
 * 無い。余裕は OS の bind・閉塞の遅延用であり、自動再送の猶予ではない。
 * RPC 自体の失敗は開始・停止の成否とみなさず、状態再取得で確かめる。
 */
export const UDP_SEND_REQUEST_TIMEOUT_MS = 10_000;
