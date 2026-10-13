/**
 * 診断 companion の main 側アダプター。限定状態から RPC ハンドラ表を作る。
 *
 * 子から識別子の指定は受け付けず、結線時に束縛した個体だけを使う。
 * `GuiPluginAccess` を capture した factory で作り、backend 引数は持たない。
 * 生の `Session`・`BridgeServer`・管理 backend 全体には触らない。
 * WebView 生成・transport・束縛・失効は持たない（ホストの責務）。
 *
 * @packageDocumentation
 */
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import type { GuiPluginAccess } from "bridge-gui-plugin-sdk/management";
import type {
  CompanionRequestEnv,
  PluginCompanionDeclaration,
} from "bridge-gui-plugin-sdk/companion";
import { DIAGNOSTIC_MOUNT_KIND, DIAGNOSTIC_VIEW_ENTRY } from "./contract.ts";
import type { DiagnosticInstanceSnapshot, DiagnosticInstanceView } from "./contract.ts";
import type { DiagnosticManagementOperations } from "./management.ts";

/**
 * 診断 companion を組み立てる。`GuiPluginAccess` を capture する。
 *
 * 解決前の宣言（振る舞いと相対 entrypoint）だけを返し、解決済み view パス・
 * 子画面 URL の組み立ては持たない。composition が静的 manifest と照合して
 * 解決済みを付与し、登録表に載せる。
 *
 * @param access - 管理層が返す種別の公開参照口。
 * @returns 診断 companion の解決前の宣言。送信操作は持たない。
 */
export function createDiagnosticCompanion(
  access: GuiPluginAccess<DiagnosticInstanceView, DiagnosticManagementOperations>,
): PluginCompanionDeclaration {
  return {
    kind: DIAGNOSTIC_MOUNT_KIND,
    label: "診断",
    viewEntry: DIAGNOSTIC_VIEW_ENTRY,
    listDesired() {
      return access.listBindings().map((binding) => ({
        instanceId: binding.instanceId,
        localSessionId: binding.localSessionId,
        portId: binding.portId,
      }));
    },
    readView(instanceId: string): InstanceBaseView {
      return access.readView(instanceId);
    },
    toSnapshot(view: InstanceBaseView, revision: number): unknown {
      // ADR: `as` を使う理由は、同じ companion の `readView` が作った表示に
      // 改訂番号だけを付けるためである。根拠は、対応付けが同一種別の記述子で
      // 読み・付番を対にすることである。
      const typed = view as DiagnosticInstanceView;
      const snapshot: DiagnosticInstanceSnapshot = { ...typed, revision };
      return snapshot;
    },
    pushMessageName: "diagnosticStateChanged",
    buildRequestHandlers(mountId: string, env: CompanionRequestEnv) {
      return {
        getDiagnosticState: () => {
          const snapshot = env.readSnapshot(DIAGNOSTIC_MOUNT_KIND, mountId);
          // ADR: `as` を使う理由は上記と同様であり、対応付けが同一種別の
          // 記述子で読んだ表示を返すためである。
          const typed = snapshot as DiagnosticInstanceSnapshot;
          env.markReady(mountId);
          return typed;
        },
      };
    },
  };
}
