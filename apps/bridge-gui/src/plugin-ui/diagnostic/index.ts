/**
 * 診断子画面。自分の割当てと echo／ping 統計の表示だけを行う。
 *
 * main が束縛した個体の現割当てを使い、子から識別子を指定しない。
 * 受付・保留・照合・承認・接続断・割当て／解除・終了といった管理操作、
 * 他個体の情報は持たない。状態同期は管理画面と同じ規約（更新ハンドラ登録→
 * 初期取得→最新全状態 push、新しい revision のみ採用）で行う。
 *
 * 統計の更新通知は main 側の最小の状態購読口（GUI 側の変化検出）が担い、
 * 子は push を数えるだけである。汎用プラグイン基盤の再設計はしない。
 */
import { Electroview } from "electrobun/view";
import type {
  DiagnosticInstanceRpc,
  DiagnosticInstanceSnapshot,
} from "../../shared/plugin-instance.ts";
import {
  parsePluginMountId,
  pluginMountKindOf,
  selectNewerInstanceSnapshot,
} from "../../shared/plugin-instance.ts";

/**
 * 表示欄に短い文を出す。
 *
 * @param id - 要素の識別子。
 * @param value - 表示する文。
 */
function show(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) {
    element.textContent = value;
  }
}

// 自分のマウント識別子。URL 断片から読む（申告では決めない）。
const mountId = parsePluginMountId(window.location.href);

if (mountId === null || pluginMountKindOf(mountId) !== "diagnostic") {
  show("diagnostic-error", "配置識別子が無いため開始できない。不正な URL である。");
} else {
  // 現在採用中の表示状態。未取得の間は null である。
  let current: DiagnosticInstanceSnapshot | null = null;

  /**
   * 採用中の束縛個体の表示を画面に反映する。
   *
   * @param snapshot - 採用中の表示状態。
   */
  function render(snapshot: DiagnosticInstanceSnapshot): void {
    show(
      "diagnostic-assignment",
      `${snapshot.localSessionId}（instanceId ${snapshot.instanceId}・接続口 ${snapshot.portId}）`,
    );
    show("diagnostic-echo", `${snapshot.stats.diagnosticEcho} 件`);
    show("diagnostic-ping", `${snapshot.stats.diagnosticPing} 件`);
    show("diagnostic-revision", String(snapshot.revision));
  }

  /** 受信した表示状態を revision 規約で採用し、採用時のみ描画する。 */
  function adopt(incoming: DiagnosticInstanceSnapshot): void {
    const next = selectNewerInstanceSnapshot(current, incoming);
    if (next !== current) {
      current = next;
      console.log(`[bridge-gui] 状態を更新した: revision=${next.revision}`);
      render(next);
    } else {
      console.log(`[bridge-gui] 古い状態を無視した: incoming=${incoming.revision}`);
    }
  }

  const rpc = Electroview.defineRPC<DiagnosticInstanceRpc>({
    handlers: {
      requests: {},
      messages: {
        diagnosticStateChanged: (message) => {
          adopt(message.snapshot);
        },
      },
    },
  });

  const view = new Electroview({ rpc });

  try {
    // 更新ハンドラ登録後に初回取得し、revision が新しいときだけ採用する。
    adopt(await rpc.request.getDiagnosticState({}));
  } catch (error: unknown) {
    console.log(`[bridge-gui] 初回取得・表示に失敗した: ${String(error)}`);
    show("diagnostic-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
  }

  void view;
}
