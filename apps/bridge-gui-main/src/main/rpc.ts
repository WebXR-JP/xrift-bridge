import { BrowserView } from "electrobun/main";
import type { ManagementRpc, OperationAck } from "bridge-gui-contract/management";
import type {
  PluginUiMountFailure,
  PluginUiMountPlacement,
} from "bridge-gui-contract/plugin-instance";
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
 * 実プラグイン子画面の配置操作口。実体は対応付けが担い、RPC 層は薄く保つ。
 *
 * 配置の実体（`BrowserView`）は main が持ち、backend は持たない。
 * snapshot への現在値の載せ替えはここで行い、backend の改訂番号を
 * 共有時計として使う。
 */
export interface PluginUiOperations {
  /**
   * 現割当てへの対応付けの追随。配置・回収・期限切れの整理を行う。
   *
   * 表示状態の取得前に呼び、読み取り時点の現割当てを反映する。
   */
  readonly syncPluginUi: () => void;
  /** 配置中の対応付け一覧の取得。 */
  readonly listPluginUiMounts: () => readonly PluginUiMountPlacement[];
  /** 失敗表示の一覧の取得。 */
  readonly listPluginUiFailures: () => readonly PluginUiMountFailure[];
  /**
   * 失敗表示の消去と現割当てへの再配置（個体限定）。
   *
   * @param instanceId - 再試行する実インスタンスの識別子。
   * @returns 受付応答。後続の状態は `stateChanged` で受け取る。
   */
  readonly retryPluginUiMount: (instanceId: unknown) => OperationAck;
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
 * @param pluginUi - 実プラグイン子画面の配置操作口。
 * @returns `BrowserWindow` に渡す RPC 接続。
 */
export function createManagementRpc(
  backend: GuiBackend,
  hooks: ManagementRpcHooks,
  pluginUi: PluginUiOperations,
) {
  return BrowserView.defineRPC<ManagementRpc>({
    handlers: {
      requests: {
        // 段2の観測点。到達の事実だけを残し、応答内容は残さない。
        getSnapshot: () => {
          hooks.onSnapshotRequested();
          // 読み取り時点の現割当てへ対応付けを追随させ、配置の現在値を載せる。
          pluginUi.syncPluginUi();
          const snapshot = backend.getSnapshot();
          return {
            ...snapshot,
            pluginMounts: pluginUi.listPluginUiMounts(),
            pluginMountFailures: pluginUi.listPluginUiFailures(),
          };
        },
        enableAcceptance: () => backend.enableAcceptance(),
        disableAcceptance: () => backend.disableAcceptance(),
        getPairingView: ({ requestId }) => backend.getPairingView({ requestId }),
        approvePairing: ({ requestId, code }) => backend.approvePairing({ requestId, code }),
        rejectPairing: ({ requestId }) => backend.rejectPairing({ requestId }),
        disconnectConnection: ({ connectionId }) => backend.disconnectConnection({ connectionId }),
        assignPlugin: ({ pluginKind, localSessionId }) =>
          backend.assignPlugin({ pluginKind, localSessionId }),
        unassignPlugin: ({ instanceId, localSessionId, portId }) =>
          backend.unassignPlugin({ instanceId, localSessionId, portId }),
        retryPluginMount: ({ instanceId }) => pluginUi.retryPluginUiMount(instanceId),
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
