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
  NgDevObserveResult,
  OperationAck,
  PairingViewResult,
  StateChangedMessage,
} from "bridge-gui-contract/management";
import type { AssignmentSummary } from "bridge-gui-contract/management";
import type { ApprovalResult, RejectionResult } from "bridge-server";
import type { TextSendResult } from "bridge-app-core";
import type {
  PluginMountDto,
  SpikeMountSummary,
  SpikePushResult,
} from "bridge-gui-contract/plugin-spike";

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

  // ADR: 段階観測（`ngDevObserve`）も `ngDebugProbe` と同じく生成時に
  // 要求される。登録はサービスの生成と同期的に行い、未登録での呼び出しは
  // 起きない想定であり、代替応答は置かない。
  private devObserveHandler!: (params: { revision: number }) => NgDevObserveResult;

  private readonly stateHandlers = new Set<StateChangedHandler>();

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
   * 保留を比較コード照合で承認する。承認可否は server が決める。
   *
   * @param requestId - 照合対象の要求識別子。
   * @param code - 入力欄の比較コード（整形しない）。
   * @returns 承認結果。
   */
  approvePairing(requestId: string, code: string): Promise<ApprovalResult> {
    return this.rpc.request.approvePairing({ requestId, code });
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
   * 診断インスタンスを割り当てる。対象外セッションの判定は表示側で行う。
   *
   * @param localSessionId - 割り当てる生存セッションのローカル識別子。
   * @returns 割当て結果。
   */
  assignDiagnostics(localSessionId: string): Promise<AssignmentSummary> {
    return this.rpc.request.assignDiagnostics({ localSessionId });
  }

  /**
   * 固定テキスト表示を明示割当てする。引数は取らない。
   *
   * @returns 割当て結果。
   */
  assignText(): Promise<AssignmentSummary> {
    return this.rpc.request.assignText({});
  }

  /**
   * 固定テキストを送信する。本文は送信時のみ扱い、記録に残さない。
   *
   * @param localSessionId - 画面が認識している割当て先のローカル識別子。
   * @param instanceId - 画面が認識している割当て先のインスタンス識別子。
   * @param text - 送信する本文。
   * @returns 送信結果。
   */
  sendText(localSessionId: string, instanceId: string, text: string): Promise<TextSendResult> {
    return this.rpc.request.sendText({ localSessionId, instanceId, text });
  }

  /**
   * 固定テキストの割当てを外す。
   *
   * @returns 受付応答。
   */
  unassignText(): Promise<OperationAck> {
    return this.rpc.request.unassignText({});
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
   * 段0スパイクの子画面破棄を要求する。所有表からの削除と表示の破棄を行う。
   *
   * @param mountId - 外す子画面のマウント識別子。
   * @returns 受付応答。
   */
  destroySpike(mountId: string): Promise<OperationAck> {
    return this.rpc.request.spikeDestroy({ mountId });
  }

  /**
   * 段0スパイクの子画面へ push を送る。混線の確認用である。
   *
   * @param mountId - 送り先マウントの識別子。
   * @returns 送った改訂番号。
   */
  pushSpike(mountId: string): Promise<SpikePushResult> {
    return this.rpc.request.spikePush({ mountId });
  }

  /**
   * 段0スパイクの所有中マウント一覧を取得する。表示用である。
   *
   * @returns 所有中のマウント一覧。
   */
  listSpikes(): Promise<readonly SpikeMountSummary[]> {
    return this.rpc.request.spikeList({});
  }

  /**
   * 段0スパイクの全マウント破棄を要求する。再読込み掃除と終了処理に使う。
   *
   * @returns 受付応答。
   */
  resetSpike(): Promise<OperationAck> {
    return this.rpc.request.spikeReset({});
  }

  /**
   * 実プラグイン子画面の失敗消去と現割当てへの再配置を要求する。
   *
   * 失敗表示を消し、現在の割当てに配置が無いものを作り直す。
   * 既存の配置・割当て・送信には触らない。
   *
   * @returns 受付応答。
   */
  retryPluginMounts(): Promise<OperationAck> {
    return this.rpc.request.retryPluginMounts({});
  }
}
