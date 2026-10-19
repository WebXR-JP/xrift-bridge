/**
 * 管理画面 RPC の接続・型付き送受信だけを担う薄い接続口。
 *
 * Electroview の生成・`defineRPC<ManagementRpc>`・型付き request・
 * `stateChanged` 購読をここに閉じ込める。表示状態（signals）・DOM
 * （`document`・`window`）は持たない。契約型は `bridge-gui-contract` の公開
 * subpath から再利用する（循環が無いことを `tsc` で確かめる）。
 *
 * @packageDocumentation
 */
import { Injectable } from "@angular/core";
import { Electroview } from "electrobun/view";
import type {
  AdmissionState,
  LocalMcpStatus,
  ManagementRpc,
  ManagementSnapshot,
  NgDebugProbeResult,
  NgDevObserveResult,
  OperationAck,
  PairingViewResult,
  PluginBindingSummary,
  StateChangedMessage,
  UnassignPluginResult,
} from "bridge-gui-contract/management";
import type { PluginViewRequest, SetPluginViewResult } from "bridge-gui-contract/plugin-instance";
import type { ApprovalResult, RejectionResult } from "bridge-server";

/** `stateChanged` push の受信処理。採用判断は呼び出し側が行う。 */
export type StateChangedHandler = (message: StateChangedMessage) => void;

/** 製品向け MCP の公開状態 push の受信処理。 */
export type LocalMcpChangedHandler = (status: LocalMcpStatus) => void;

@Injectable({ providedIn: "root" })
export class ManagementRpcClient {
  // ADR: `defineRPC` は webview 側の request 処理（`ngDebugProbe`）を生成時に
  // 要求する一方、観測応答の組み立ては表示状態を持つサービス側の責務である。
  // 登録はサービスの生成と同期的に行い、その間に応答が届くことはない（RPC の
  // 到達は非同期のため）。未登録での呼び出しは起きない想定であり、代替応答は
  // 置かない。
  private probeHandler!: () => NgDebugProbeResult;

  // ADR: 段階観測（`ngDevObserve`）も `ngDebugProbe` と同じく生成時に
  // 要求される。登録はサービスの生成と同期的に行い、未登録での呼び出しは
  // 起きない想定であり、代替応答は置かない。
  private devObserveHandler!: (params: { revision: number }) => NgDevObserveResult;

  private readonly stateHandlers = new Set<StateChangedHandler>();

  /** 製品向け MCP の公開状態 push の受信口。 */
  private readonly localMcpHandlers = new Set<LocalMcpChangedHandler>();

  private readonly rpc = Electroview.defineRPC<ManagementRpc>({
    handlers: {
      requests: {
        ngDebugProbe: () => this.probeHandler(),
        ngDevObserve: (params) => this.devObserveHandler(params),
      },
      messages: {
        stateChanged: (message) => {
          for (const handler of this.stateHandlers) {
            handler(message);
          }
        },
        localMcpChanged: (status) => {
          for (const handler of this.localMcpHandlers) {
            handler(status);
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
   * 開発専用の段階観測（DOM 反映）の応答処理を登録する。状態サービスが生成時に呼ぶ。
   *
   * @param handler - 観測応答を組み立てる処理。要求の改訂番号は相関用であり、採用判断は呼び出し側が行う。
   */
  setDevObserveHandler(handler: (params: { revision: number }) => NgDevObserveResult): void {
    this.devObserveHandler = handler;
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
   * 製品向け MCP の公開状態 push の購読を登録する。
   *
   * @param handler - 受信した公開状態を受ける処理。
   * @returns 購読を解除する関数。
   */
  onLocalMcpChanged(handler: LocalMcpChangedHandler): () => void {
    this.localMcpHandlers.add(handler);
    return () => {
      this.localMcpHandlers.delete(handler);
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
   * 選択した保留の比較コードを表示用に取得する。承認はしない。
   *
   * @param requestId - 照合対象の要求識別子。
   * @returns 表示用の取得結果（本文の記録には使わない）。
   */
  getPairingView(requestId: string): Promise<PairingViewResult> {
    return this.rpc.request.getPairingView({ requestId });
  }

  /**
   * 保留を要求 ID だけで承認する。承認可否は server が決める。
   *
   * 比較コードは表示専用であり、承認には送らない。
   *
   * @param requestId - 承認対象の要求識別子。
   * @returns 承認結果。
   */
  approvePairing(requestId: string): Promise<ApprovalResult> {
    return this.rpc.request.approvePairing({ requestId });
  }

  /**
   * 保留を取り下げ、対象の接続を終了する。
   *
   * @param requestId - 照合対象の要求識別子。
   * @returns 取り下げ結果。
   */
  rejectPairing(requestId: string): Promise<RejectionResult> {
    return this.rpc.request.rejectPairing({ requestId });
  }

  /**
   * 指定接続だけを切断する。待ち受けと他接続は維持する。
   *
   * @param connectionId - 切断する接続の識別子。
   * @returns 受付応答。
   */
  disconnectConnection(connectionId: string): Promise<OperationAck> {
    return this.rpc.request.disconnectConnection({ connectionId });
  }

  /**
   * 汎用プラグインを割り当てる。種別と割当て先だけを指定する。
   *
   * @param pluginKind - 割り当てる種別トークン。
   * @param localSessionId - 割り当てる生存セッションのローカル識別子。省略時は方針に従い選ぶ。
   * @returns 確定した束縛の表示状態。
   */
  assignPlugin(pluginKind: string, localSessionId?: string): Promise<PluginBindingSummary> {
    return this.rpc.request.assignPlugin({ pluginKind, localSessionId });
  }

  /**
   * 汎用プラグインの割当てを外す。描画した所有記録の三識別子で照合する。
   *
   * @param instanceId - 描画した所有記録のインスタンス識別子。
   * @param localSessionId - 描画した所有記録のローカル識別子。
   * @param portId - 描画した所有記録の接続口識別子。
   * @returns 解放結果。
   */
  unassignPlugin(
    instanceId: string,
    localSessionId: string,
    portId: string,
  ): Promise<UnassignPluginResult> {
    return this.rpc.request.unassignPlugin({ instanceId, localSessionId, portId });
  }

  /**
   * 製品向け MCP の公開状態を取得する（URL のみで接続する）。
   *
   * @returns 現在の公開状態。
   */
  getLocalMcpStatus(): Promise<LocalMcpStatus> {
    return this.rpc.request.getLocalMcpStatus({});
  }

  /**
   * 製品向け MCP を有効化する。待受けを開く／作り直す。
   *
   * @returns 有効化後の公開状態。
   */
  enableLocalMcp(): Promise<LocalMcpStatus> {
    return this.rpc.request.enableLocalMcp({});
  }

  /**
   * 製品向け MCP を停止する。個体の受付を失効し、待受けを止める。
   *
   * @returns 停止後の公開状態（解放の確認結果を含む）。
   */
  disableLocalMcp(): Promise<LocalMcpStatus> {
    return this.rpc.request.disableLocalMcp({});
  }

  /**
   * アプリ終了を要求する。後始末完了後に終了する。
   *
   * @returns 受付応答。
   */
  quit(): Promise<OperationAck> {
    return this.rpc.request.quit({});
  }

  /**
   * 実プラグイン子画面の表示要求を送る。表示意図と観測した基準世代を伝える。
   *
   * 基準世代は採用中 snapshot の採用済み世代であり、採番は main が行う。
   * 応答は採用／stale と現在の採用済み対象・世代を返す（RPC 成功と採用を
   * 混同しない）。
   *
   * @param request - 表示意図と観測した基準世代。
   * @returns 採用可否と現在の採用済み表示対象・世代。
   */
  setPluginView(request: PluginViewRequest): Promise<SetPluginViewResult> {
    return this.rpc.request.setPluginView(request);
  }

  /**
   * 実プラグイン子画面の失敗消去と現割当てへの再配置を対象個体だけに要求する。
   *
   * 指定した実インスタンスの失敗表示だけを消し、その個体が現割当てに
   * あれば配置を作り直す。他個体の失敗・既存の配置・割当て・送信には
   * 触らない。受付であり準備完了を保証しない。
   *
   * @param instanceId - 再試行する対象のインスタンス識別子。
   * @returns 受付応答。
   */
  retryPluginMount(instanceId: string): Promise<OperationAck> {
    return this.rpc.request.retryPluginMount({ instanceId });
  }
}
