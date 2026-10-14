/**
 * テキストの GUI companion の登録口（`./gui`）。
 *
 * 管理記述子と companion factory の対応付けだけを持ち、子画面固有契約の
 * 定義は `gui-contract`、通信契約は `contract`、本体は `plugin` が持つ。
 * ここでは再定義せず、公開 entry（`bridge-plugin-text/gui`）越しに
 * ホストの composition root だけが参照する。
 *
 * @packageDocumentation
 */
import { TEXT_PORT_ID, textPlugin } from "./plugin.ts";
import type { TextPluginOperations, TextPluginState, TextSendResult } from "./plugin.ts";
import { TEXT_SESSION_ID } from "./contract.ts";
import type {
  GuiPluginAccess,
  GuiPluginManagementDescriptor,
  PluginOperationAccess,
} from "bridge-gui-plugin-sdk/management";
import type {
  CompanionRequestEnv,
  PluginCompanionDeclaration,
} from "bridge-gui-plugin-sdk/companion";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import { TEXT_MOUNT_KIND, TEXT_VIEW_ENTRY } from "./gui-contract.ts";
import type { TextInstanceSnapshot, TextInstanceView } from "./gui-contract.ts";

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
