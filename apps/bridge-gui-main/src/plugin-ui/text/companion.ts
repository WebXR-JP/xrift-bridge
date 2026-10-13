/**
 * テキスト companion の main 側アダプター。限定状態・操作から RPC ハンドラ表を作る。
 *
 * 子から識別子の指定は受け付けず、結線時に束縛した個体だけを使う。
 * backend は不透明に受け取り、テキストの限定射影・送信だけを使う。
 * 生の `Session`・`BridgeServer`・管理 backend 全体には触らない。
 * WebView 生成・transport・束縛・失効は持たない（ホストの責務）。
 *
 * @packageDocumentation
 */
import type { TextSendResult } from "bridge-app-core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import type {
  CompanionDesiredBinding,
  CompanionRequestEnv,
  PluginCompanion,
} from "../../main/plugin-companions.ts";
import { TEXT_MOUNT_KIND, TEXT_VIEW_PATH, buildTextViewUrl } from "./contract.ts";
import type { TextInstanceSnapshot, TextInstanceView } from "./contract.ts";

/** テキストの限定射影・送信だけを持つ backend の最小口。構造的に満たす。 */
interface TextProjection {
  /** 束縛テキスト個体の限定表示を返す。現割当て失効時は `RangeError`。 */
  getTextInstanceView(params: { instanceId: unknown }): TextInstanceView;
  /** 束縛テキスト個体の現割当てへ本文を送る。 */
  sendTextForInstance(instanceId: unknown, params: { text: unknown }): Promise<TextSendResult>;
}

/** テキストの現割当てだけを問う backend の最小口。構造的に満たす。 */
interface TextBindingSource {
  /** 現在のテキスト束縛。無ければ `null`。 */
  getTextBinding(): { instanceId: string; localSessionId: string; portId: string } | null;
}

/**
 * backend をテキストの最小口として読む。
 *
 * @param backend - 対応付けが預かる backend。不透明に受け取る。
 * @returns テキストの最小口。
 */
function asTextProjection(backend: unknown): TextProjection {
  // ADR: `as` を使う理由は、登録表が backend を不透明に運び、種別ごとの
  // 到達口は companion が知るためである。根拠は、登録時にこの companion と
  // テキスト射影を持つ backend を組み合わせることであり、口が無ければ
  // 後続の呼び出しが例外で失敗する。
  return backend as TextProjection;
}

/**
 * テキスト companion の記述子。種別トークン・表示先・限定射影への到達と
 * RPC ハンドラ表の組み立てだけを持つ。
 */
export const textCompanion: PluginCompanion = {
  kind: TEXT_MOUNT_KIND,
  label: "テキスト",
  // ADR: `viewPath` と `buildViewUrl` の二重定義を避けるため、表示先の正本は
  // `contract.ts` の `TEXT_VIEW_PATH` に置き、ここでは参照だけする。
  viewPath: TEXT_VIEW_PATH,
  buildViewUrl(mountId: string): string {
    return buildTextViewUrl(mountId);
  },
  listDesired(backend: unknown): CompanionDesiredBinding[] {
    // ADR: `as` を使う理由は上記と同様であり、束縛の有無だけを問う。
    const source = backend as TextBindingSource;
    const binding = source.getTextBinding();
    if (binding === null) {
      return [];
    }
    return [binding];
  },
  readView(backend: unknown, instanceId: string): InstanceBaseView {
    return asTextProjection(backend).getTextInstanceView({ instanceId });
  },
  toSnapshot(view: InstanceBaseView, revision: number): unknown {
    // ADR: `as` を使う理由は、同じ companion の `readView` が作った表示に
    // 改訂番号だけを付けるためである。根拠は、対応付けが同一種別の記述子で
    // 読み・付番を対にすることである。
    const typed = view as TextInstanceView;
    const snapshot: TextInstanceSnapshot = { ...typed, revision };
    return snapshot;
  },
  send(backend: unknown, instanceId: string, params: unknown): Promise<unknown> {
    // ADR: `as` を使う理由は上記と同様であり、本文の検証は委譲先が行う。
    const table = params as { text: unknown };
    return asTextProjection(backend).sendTextForInstance(instanceId, { text: table.text });
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
