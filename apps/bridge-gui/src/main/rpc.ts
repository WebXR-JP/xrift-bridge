import { BrowserView } from "electrobun/main";
import type { ManagementRpc, OperationAck } from "../shared/management.ts";
import type { PluginMountDto, SpikeMountSummary, SpikePushResult } from "../shared/plugin-spike.ts";
import type { GuiBackend } from "./backend.ts";

/** Webview 側からの通知に対する main 側の振る舞い。 */
export interface ManagementRpcHooks {
  /** `viewReady` を受信したときに到達を記録する。 */
  readonly onViewReady: (title: string) => void;
  /** `getSnapshot` 要求を受信したことを記録する。 */
  readonly onSnapshotRequested: () => void;
  /**
   * `quit` 要求を受信したときに終了手順を開始する。
   *
   * 非同期の後始末を終えてからアプリ終了を再要求すること。
   * `before-quit` は待たないため、ここで待機しない。
   */
  readonly onQuitRequested: () => void;
}

/**
 * 段0スパイクのマウント操作口。実体は所有表が担い、RPC 層は薄く保つ。
 *
 * 識別子の検証は所有表側で行い、型付き RPC を実行時検証とみなさない。
 */
export interface SpikeMountOperations {
  /** 子画面配置の受付。配置用 DTO を返す。 */
  readonly createSpikeMount: () => PluginMountDto;
  /**
   * 子画面破棄の実行。
   *
   * @param mountId - 破棄するマウント識別子。
   */
  readonly destroySpikeMount: (mountId: unknown) => OperationAck;
  /**
   * 当該マウントへの push 送信。
   *
   * @param mountId - 送り先のマウント識別子。
   * @returns 送った改訂番号。
   */
  readonly pushSpikeMount: (mountId: unknown) => SpikePushResult;
  /** 所有中マウント一覧の取得。 */
  readonly listSpikeMounts: () => readonly SpikeMountSummary[];
  /** 全マウント破棄の実行。 */
  readonly resetSpikeMounts: () => OperationAck;
}

/**
 * main 側 RPC 定義。表示データ（DTO）と限定操作だけを公開する。
 *
 * Webview へ関数や生オブジェクトを渡さない。引数・ID・終了中状態の検証は
 * バックエンド側で行い、型付き RPC を実行時検証とみなさない。
 * ログには revision 番号と操作名だけを残し、比較コード本文や
 * 業務 payload・テキスト本文を残さない。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param hooks - Webview 通知に対する後処理。
 * @param spike - 段0スパイクのマウント操作口。
 * @returns `BrowserWindow` に渡す RPC 接続。
 */
export function createManagementRpc(
  backend: GuiBackend,
  hooks: ManagementRpcHooks,
  spike: SpikeMountOperations,
) {
  return BrowserView.defineRPC<ManagementRpc>({
    handlers: {
      requests: {
        // 段2の観測点。到達の事実だけを残し、応答内容は残さない。
        getSnapshot: () => {
          hooks.onSnapshotRequested();
          return backend.getSnapshot();
        },
        openAcceptance: () => backend.openAcceptance(),
        closeAcceptance: () => backend.closeAcceptance(),
        getPairingView: ({ requestId }) => backend.getPairingView({ requestId }),
        approvePairing: ({ requestId, code }) => backend.approvePairing({ requestId, code }),
        rejectPairing: ({ requestId }) => backend.rejectPairing({ requestId }),
        disconnectConnection: ({ connectionId }) => backend.disconnectConnection({ connectionId }),
        assignDiagnostics: ({ localSessionId }) => backend.assignDiagnostics({ localSessionId }),
        assignText: () => backend.assignText(),
        sendText: ({ localSessionId, instanceId, text }) =>
          backend.sendText({ localSessionId, instanceId, text }),
        unassignText: () => backend.unassignText(),
        spikeCreate: () => spike.createSpikeMount(),
        spikeDestroy: ({ mountId }) => spike.destroySpikeMount(mountId),
        spikePush: ({ mountId }) => spike.pushSpikeMount(mountId),
        spikeList: () => spike.listSpikeMounts(),
        spikeReset: () => spike.resetSpikeMounts(),
        quit: () => {
          hooks.onQuitRequested();
          return { ok: true as const };
        },
      },
      messages: {
        viewReady: ({ title }) => {
          hooks.onViewReady(title);
        },
        // 段2の観測点。画面→main の通知名だけを残し、payload は残さない。
        "*": (name) => {
          console.log(`[bridge-gui] 画面通知を受信した: ${String(name)}`);
        },
      },
    },
  });
}

/** `createManagementRpc` が返す RPC 接続の型。 */
export type ManagementRpcConnection = ReturnType<typeof createManagementRpc>;
