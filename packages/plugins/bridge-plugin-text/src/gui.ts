/**
 * テキストの GUI 登録単位（`./gui`）。
 *
 * 管理記述子・companion 宣言・endpoint 工場の組だけを持ち、子画面固有契約の
 * 定義は `gui-contract`、通信契約は `contract`、本体は `plugin` が持つ。
 * ここでは再定義せず、公開 entry（`bridge-plugin-text/gui`）越しに
 * ホストの composition root だけが参照する。
 *
 * 中継の共通形は子→プラグインが `{method, params}`、プラグイン→子が
 * `{event, payload}` であり、応答は `PluginRelayResult`
 * （`{ok:true,value}`・`{ok:false,error}`）である。業務エラーは `value` 側に
 * 載せ、投げた例外は中継失敗に落とす。未知 `method` は不透明なエラー値で
 * 拒否し、反射呼出し（`operations[method]` 等）はしない。
 *
 * @packageDocumentation
 */
import { TEXT_PORT_ID, textPlugin } from "./plugin.ts";
import type { TextPluginOperations, TextPluginState, TextSendResult } from "./plugin.ts";
import { TEXT_SESSION_ID, validateTextForSend } from "./contract.ts";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { GuiPluginRegistration } from "bridge-gui-plugin-sdk/registration";
import type { PluginRelayRequest } from "bridge-gui-contract/plugin-instance";
import type { Unsubscribe } from "bridge-app-core/core";
import {
  TEXT_GET_STATE_METHOD,
  TEXT_MOUNT_KIND,
  TEXT_SEND_TEXT_METHOD,
  TEXT_STATE_CHANGED_EVENT,
  TEXT_VIEW_ENTRY,
  isTextSendTextParams,
  type TextChildSnapshot,
} from "./gui-contract.ts";

/**
 * 表示用 DTO を組み立てる。本体の状態と束縛情報を写すだけであり、本文は
 * 載せない。改訂番号は本体が進めた値を引き継ぐだけである。
 *
 * @param state - 本体の現在状態または変更通知の状態。
 * @param ref - ホストが選んだ一個体に限定した参照口。束縛情報の読取りに使う。
 * @returns 子へ送る表示用 DTO。
 * @throws `RangeError` — 所有外・失効・現割当て不一致の場合（ホスト自身の照合）。
 */
function toChildSnapshot(
  state: TextPluginState,
  ref: BoundPluginRef<TextPluginState, TextPluginOperations>,
): TextChildSnapshot {
  const binding = ref.getBinding();
  return {
    revision: state.revision,
    instanceId: binding.instanceId,
    localSessionId: binding.localSessionId,
    portId: binding.portId,
    canSend: state.canSend,
    pendingId: state.pendingId,
    lastResult: state.lastResult,
    stats: state.stats,
  };
}

/**
 * テキストの登録単位。管理記述子・companion 宣言・endpoint 工場の組である。
 *
 * composition root が静的登録で使い、マウント時に個体へ束縛した endpoint を
 * 生成する。旧 export（`createTextCompanion`・`textManagement` 等）は持たない。
 */
export const textGuiRegistration: GuiPluginRegistration<TextPluginState, TextPluginOperations> = {
  management: {
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
  },
  companion: {
    kind: TEXT_MOUNT_KIND,
    label: "テキスト",
    viewEntry: TEXT_VIEW_ENTRY,
  },
  createEndpoint(
    ref: BoundPluginRef<TextPluginState, TextPluginOperations>,
    emission: PluginEmissionPort,
  ): PluginEndpoint {
    let disposed = false;
    let unsubscribe: Unsubscribe | null = null;

    // 本体の状態変更を購読し、表示用 DTO をその表示期間の子へ送る。
    // アプリにキュー・再配信・最新状態キャッシュは無い。
    const publish = (state: TextPluginState): void => {
      if (disposed) return;
      let snapshot: TextChildSnapshot;
      try {
        snapshot = toChildSnapshot(state, ref);
      } catch {
        // 失効時は送らない。旧子への付け替え・自動再送もしない。
        return;
      }
      emission.emit({ event: TEXT_STATE_CHANGED_EVENT, payload: snapshot });
    };
    unsubscribe = ref.withOperations((operations) => operations.onStateChanged(publish));

    return {
      async handleRequest(request: PluginRelayRequest): Promise<unknown> {
        if (disposed) {
          throw new Error("終了済みの endpoint である。");
        }
        if (request.method === TEXT_GET_STATE_METHOD) {
          // 読取りは改訂を進めない。失効は投げて中継失敗に落とす。
          const state = ref.readState();
          return toChildSnapshot(state, ref);
        }
        if (request.method === TEXT_SEND_TEXT_METHOD) {
          if (!isTextSendTextParams(request.params)) {
            return { error: "送信要求の形状が不正である。" };
          }
          const validated = validateTextForSend(request.params.text);
          if (!validated.ok) {
            const reason =
              validated.reason === "empty"
                ? "本文が空のため送信しない。"
                : validated.reason === "too-long"
                  ? "本文が長すぎるため送信しない。"
                  : "本文が文字列でないため送信しない。";
            return { error: reason };
          }
          const text = validated.text;
          // ADR: 同期の投げ（所有外・失効・操作口不足）はそのまま投げて中継失敗に
          // 落とし、非同期の `RangeError` 拒否（送信不可・重複等）は業務エラー
          // として値に載せる。`sendText` の送信前拒否は `Promise` の拒否であり、
          // 同期投げとは分かれるため、この分け方が成立する。
          const flight: Promise<TextSendResult> = ref.withOperations((operations, binding) =>
            operations.sendText(text, binding.localSessionId),
          );
          try {
            return await flight;
          } catch (error: unknown) {
            if (error instanceof RangeError) {
              return { error: error.message };
            }
            throw error;
          }
        }
        return { error: `未知の要求である: ${request.method}` };
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        const stop = unsubscribe;
        unsubscribe = null;
        if (stop !== null) {
          try {
            stop();
          } catch {
            // 解放の失敗は二重解放にしない。
          }
        }
      },
    };
  },
};
