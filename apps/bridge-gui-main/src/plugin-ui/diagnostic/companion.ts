/**
 * 診断 companion の main 側アダプター。限定状態から RPC ハンドラ表を作る。
 *
 * 子から識別子の指定は受け付けず、結線時に束縛した個体だけを使う。
 * backend は不透明に受け取り、診断の限定射影だけを使う。
 * 生の `Session`・`BridgeServer`・管理 backend 全体には触らない。
 * WebView 生成・transport・束縛・失効は持たない（ホストの責務）。
 *
 * @packageDocumentation
 */
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import type {
  CompanionDesiredBinding,
  CompanionRequestEnv,
  PluginCompanion,
} from "../../main/plugin-companions.ts";
import { DIAGNOSTIC_MOUNT_KIND, DIAGNOSTIC_VIEW_PATH, buildDiagnosticViewUrl } from "./contract.ts";
import type { DiagnosticInstanceSnapshot, DiagnosticInstanceView } from "./contract.ts";

/** 診断の限定射影だけを持つ backend の最小口。構造的に満たす。 */
interface DiagnosticProjection {
  /** 束縛診断個体の限定表示を返す。現割当て失効時は `RangeError`。 */
  getDiagnosticInstanceView(params: { instanceId: unknown }): DiagnosticInstanceView;
}

/** 診断の現割当てだけを問う backend の最小口。構造的に満たす。 */
interface DiagnosticBindingSource {
  /** 現在の診断束縛の一覧。無ければ空配列。 */
  listDiagnosticBindings(): Array<{
    instanceId: string;
    localSessionId: string;
    portId: string;
  }>;
}

/**
 * 診断 companion の記述子。種別トークン・表示先・限定射影への到達と
 * RPC ハンドラ表の組み立てだけを持つ。送信操作は持たない。
 */
export const diagnosticCompanion: PluginCompanion = {
  kind: DIAGNOSTIC_MOUNT_KIND,
  label: "診断",
  // ADR: `viewPath` と `buildViewUrl` の二重定義を避けるため、表示先の正本は
  // `contract.ts` の `DIAGNOSTIC_VIEW_PATH` に置き、ここでは参照だけする。
  viewPath: DIAGNOSTIC_VIEW_PATH,
  buildViewUrl(mountId: string): string {
    return buildDiagnosticViewUrl(mountId);
  },
  listDesired(backend: unknown): CompanionDesiredBinding[] {
    // ADR: `as` を使う理由は、登録表が backend を不透明に運び、種別ごとの
    // 到達口は companion が知るためである。根拠は、登録時にこの companion と
    // 診断射影を持つ backend を組み合わせることであり、口が無ければ
    // 後続の呼び出しが例外で失敗する。
    const source = backend as DiagnosticBindingSource;
    return source.listDiagnosticBindings();
  },
  readView(backend: unknown, instanceId: string): InstanceBaseView {
    // ADR: `as` を使う理由は上記と同様であり、失効時は委譲先が `RangeError` で示す。
    const projection = backend as DiagnosticProjection;
    return projection.getDiagnosticInstanceView({ instanceId });
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
