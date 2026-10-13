/**
 * テキスト companion の main 側アダプター。限定状態・操作から RPC ハンドラ表を作る。
 *
 * 子から識別子の指定は受け付けず、結線時に束縛した個体だけを使う。
 * `GuiPluginAccess` を capture した factory で作り、backend 引数は持たない。
 * 生の `Session`・`BridgeServer`・管理 backend 全体には触らない。
 * WebView 生成・transport・束縛・失効は持たない（ホストの責務）。
 *
 * @packageDocumentation
 */
import type { TextSendResult } from "bridge-app-core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import type { GuiPluginAccess } from "bridge-gui-plugin-sdk/management";
import type {
  CompanionRequestEnv,
  PluginCompanionDeclaration,
} from "bridge-gui-plugin-sdk/companion";
import { TEXT_MOUNT_KIND, TEXT_VIEW_ENTRY } from "./contract.ts";
import type { TextInstanceSnapshot, TextInstanceView } from "./contract.ts";
import type { TextManagementOperations } from "./management.ts";

/**
 * テキスト companion を組み立てる。`GuiPluginAccess` を capture する。
 *
 * 解決前の宣言（振る舞いと相対 entrypoint）だけを返し、解決済み view パス・
 * 子画面 URL の組み立ては持たない。composition が静的 manifest と照合して
 * 解決済みを付与し、登録表に載せる。
 *
 * @param access - 管理層が返す種別の公開参照口。
 * @returns テキスト companion の解決前の宣言。
 */
export function createTextCompanion(
  access: GuiPluginAccess<TextInstanceView, TextManagementOperations>,
): PluginCompanionDeclaration {
  return {
    kind: TEXT_MOUNT_KIND,
    label: "テキスト",
    viewEntry: TEXT_VIEW_ENTRY,
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
      const typed = view as TextInstanceView;
      const snapshot: TextInstanceSnapshot = { ...typed, revision };
      return snapshot;
    },
    send(instanceId: string, params: unknown): Promise<unknown> {
      // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
      // 根拠は、要求表の `sendText` が本文だけを渡すことである。本文の検証は
      // 委譲先（固有操作）が行う。
      const table = params as { text: unknown };
      return access.operations.sendText(instanceId, table.text);
    },
    pushMessageName: "textStateChanged",
    buildRequestHandlers(mountId: string, env: CompanionRequestEnv) {
      return {
        getTextState: () => {
          const snapshot = env.readSnapshot(TEXT_MOUNT_KIND, mountId);
          // ADR: `as` を使う理由は上記と同様であり、対応付けが同一種別の
          // 記述子で読んだ表示を返すためである。
          const typed = snapshot as TextInstanceSnapshot;
          env.markReady(mountId);
          return typed;
        },
        sendText: (params: { text: string }) => {
          const result = env.send(TEXT_MOUNT_KIND, mountId, params);
          // ADR: `as` を使う理由は上記と同様であり、委譲先の解決型を保つためである。
          return result as Promise<TextSendResult>;
        },
      };
    },
  };
}
