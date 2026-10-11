/**
 * 管理画面 RPC の接続・型付き送受信だけを担う薄い接続口。
 *
 * Electroview の生成・`defineRPC<ManagementRpc>`・型付き request・`viewReady`
 * 通知・`stateChanged` 購読をここに閉じ込める。表示状態（signals）・DOM
 * （`document`・`window`）は持たない。契約型は `bridge-gui-contract` の公開
 * subpath から再利用する（循環が無いことを `tsc` で確かめる）。
 *
 * @packageDocumentation
 */
import { Injectable } from "@angular/core";
import { Electroview } from "electrobun/view";
import type {
  AdmissionState,
  ManagementRpc,
  ManagementSnapshot,
  NgDebugProbeResult,
  OperationAck,
  StateChangedMessage,
} from "bridge-gui-contract/management";
import type { PluginMountDto } from "bridge-gui-contract/plugin-spike";

/** `stateChanged` push の受信処理。採用判断は呼び出し側が行う。 */
export type StateChangedHandler = (message: StateChangedMessage) => void;

@Injectable({ providedIn: "root" })
export class ManagementRpcClient {
  // ADR: `defineRPC` は webview 側の request 処理（`ngDebugProbe`）を生成時に
  // 要求する一方、観測応答の組み立ては表示状態を持つサービス側の責務である。
  // 登録はサービスの生成と同期的に行い、その間に応答が届くことはない（RPC の
  // 到達は非同期のため）。未登録での呼び出しは起きない想定であり、代替応答は
  // 置かない。
  private probeHandler!: () => NgDebugProbeResult;

  private readonly stateHandlers = new Set<StateChangedHandler>();

  private readonly rpc = Electroview.defineRPC<ManagementRpc>({
    handlers: {
      requests: {
        ngDebugProbe: () => this.probeHandler(),
      },
      messages: {
        stateChanged: (message) => {
          for (const handler of this.stateHandlers) {
            handler(message);
          }
        },
      },
    },
  });

  /** RPC 接続の保持。購読の破棄はしない（画面の寿命と同じ）。 */
  private readonly view = new Electroview({ rpc: this.rpc });

  constructor() {
    // 接続の保持だけが目的であり、以後は `rpc` 経由で使う。
    void this.view;
  }

  /**
   * 開発専用観測口の応答処理を登録する。状態サービスが生成時に呼ぶ。
   *
   * @param handler - 観測応答を組み立てる処理。
   */
  setProbeHandler(handler: () => NgDebugProbeResult): void {
    this.probeHandler = handler;
  }

  /**
   * 状態 push の購読を登録する。
   *
   * @param handler - 受信した push を受ける処理。
   * @returns 購読を解除する関数。
   */
  onStateChanged(handler: StateChangedHandler): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /**
   * 表示状態を取得する。
   *
   * @returns main が返す最新の表示状態。
   */
  getSnapshot(): Promise<ManagementSnapshot> {
    return this.rpc.request.getSnapshot({});
  }

  /**
   * 受付を有効化する。
   *
   * @returns 有効化後の受付状態。
   */
  enableAcceptance(): Promise<AdmissionState> {
    return this.rpc.request.enableAcceptance({});
  }

  /**
   * 受付を無効化する。認可済みは維持する。
   *
   * @returns 無効化後の受付状態。
   */
  disableAcceptance(): Promise<AdmissionState> {
    return this.rpc.request.disableAcceptance({});
  }

  /**
   * 準備完了を通知する。題名は呼び出し側が渡す（DOM を読まない）。
   *
   * @param title - 通知に載せる文書題。
   */
  notifyViewReady(title: string): void {
    this.rpc.send.viewReady({ title });
  }

  /**
   * 段0スパイクの子画面配置を要求する。配置用 DTO（識別子＋初期 URL）を返す。
   *
   * @returns 所有表が発行した配置用 DTO。
   */
  createSpike(): Promise<PluginMountDto> {
    return this.rpc.request.spikeCreate({});
  }

  /**
   * 段0スパイクの全マウント破棄を要求する。再読込み掃除と終了処理に使う。
   *
   * @returns 受付応答。
   */
  resetSpike(): Promise<OperationAck> {
    return this.rpc.request.spikeReset({});
  }
}
