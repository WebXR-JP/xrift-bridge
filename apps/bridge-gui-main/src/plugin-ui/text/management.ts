/**
 * テキスト companion が所有する管理記述子。
 *
 * 生成元・割当て方針・監視方式・表示射影・固有操作の宣言をここに束ね、
 * 汎用管理層（`PluginInstanceManager`）がこれに従って駆動する。種別分岐は
 * 持たず、候補不足・曖昧の場合は `RangeError` で示す。
 *
 * @packageDocumentation
 */
import { TEXT_PORT_ID, TEXT_SESSION_ID, textPlugin } from "bridge-app-core";
import type { TextPluginOperations, TextPluginState, TextSendResult } from "bridge-app-core";
import type {
  GuiPluginManagementDescriptor,
  PluginOperationAccess,
} from "bridge-gui-plugin-sdk/management";
import { TEXT_MOUNT_KIND } from "./contract.ts";
import type { TextInstanceView } from "./contract.ts";

/**
 * テキストの公開する固有操作。
 *
 * raw operations を保存せず、利用の都度限定口を通す。
 */
export interface TextManagementOperations {
  /**
   * 束縛個体の現割当てへ本文を送る。
   *
   * @param instanceId - 操作対象の個体識別子。
   * @param text - 送信する本文。文字列であること（詳細検証はプラグインが行う）。
   * @returns 反映確認または結果不明。送信処理の失敗は `Promise` の拒否で表す。
   * @throws `RangeError` — 本文が文字列でない、不明・失効・現割当て不一致の場合（同期的）。
   */
  sendText(instanceId: string, text: unknown): Promise<TextSendResult>;
}

/**
 * テキストの管理記述子。`definition: textPlugin`、`maxInstances: 1`。
 *
 * 候補は生存・未割当て・`sessionId===TEXT_SESSION_ID`・reliable/bidirectional
 * で全接続通じて唯一のときのみ選択する（0/複数は `RangeError`、`mode:"session"`
 * でも唯一条件を緩めない）。監視は購読（`handle.getOperations()`→
 * `onStateChanged`、操作口不足は `TypeError`）で行う。
 */
export const textManagement: GuiPluginManagementDescriptor<
  TextPluginState,
  TextPluginOperations,
  TextInstanceView,
  TextManagementOperations
> = {
  kind: TEXT_MOUNT_KIND,
  definition: textPlugin,
  assignment: {
    maxInstances: 1,
    select({ request, candidates }) {
      const eligible = candidates.filter(
        (candidate) =>
          candidate.alive &&
          candidate.assignment === null &&
          candidate.sessionId === TEXT_SESSION_ID &&
          candidate.capability.kind === "reliable" &&
          candidate.capability.direction === "bidirectional",
      );
      if (eligible.length === 0) {
        throw new RangeError("テキスト割当ての候補が無い。");
      }
      if (eligible.length > 1) {
        throw new RangeError("テキスト割当ての候補が複数ある。");
      }
      const target = eligible[0];
      if (target === undefined) {
        throw new RangeError("テキスト割当ての候補が無い。");
      }
      if (request.mode === "session" && target.localSessionId !== request.localSessionId) {
        throw new RangeError("指定した候補と割当て先が一致しない。");
      }
      return { localSessionId: target.localSessionId, portId: TEXT_PORT_ID };
    },
  },
  observation: {
    mode: "subscribe",
    start(handle, changed) {
      const operations = handle.getOperations?.();
      if (operations === undefined) {
        throw new TypeError("テキストの操作口が無い。");
      }
      return operations.onStateChanged(() => {
        changed();
      });
    },
  },
  projectView({ binding, state }) {
    return {
      instanceId: binding.instanceId,
      pluginId: binding.pluginId,
      portId: binding.portId,
      localSessionId: binding.localSessionId,
      canSend: state.canSend,
      pendingId: state.pendingId,
      lastResult: state.lastResult,
      stats: state.stats,
    };
  },
  buildOperations(access: PluginOperationAccess<TextPluginOperations>): TextManagementOperations {
    return {
      sendText(instanceId: string, text: unknown): Promise<TextSendResult> {
        if (typeof text !== "string") {
          throw new RangeError("text は文字列であること。");
        }
        const body = text;
        return access.withOperations(instanceId, (operations, binding) =>
          operations.sendText(body, binding.localSessionId),
        );
      },
    };
  },
};
