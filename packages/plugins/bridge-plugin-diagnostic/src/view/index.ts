/**
 * 診断子画面。自分の割当てと echo／ping 統計の表示だけを行う。
 *
 * main が束縛した個体の現割当てを使い、子から識別子を指定しない。
 * 受付・保留・照合・承認・接続断・割当て／解除・終了といった管理操作、
 * 他個体の情報は持たない。状態同期は「更新ハンドラ登録→初期取得→
 * 新しい revision のみ採用」で行う。子画面は表示期間ごとに作り直され、
 * 状態を持たない。読取り前の通知は初期取得で追い付くため、蓄積を持たない。
 *
 * 中継の共通形（子→プラグイン `{method, params}`・プラグイン→子
 * `{event, payload}`）だけを使い、アプリ本体との直接のデータ交換はしない。
 * 要求名・イベント名・表示の形状は固有契約（`gui-contract`）を正本とする。
 */
import { Electroview } from "electrobun/view";
import type { CompanionChannelRpc } from "bridge-gui-contract/plugin-instance";
import { parsePluginMountId, pluginMountKindOf } from "bridge-gui-contract/plugin-instance";
import {
  DIAGNOSTIC_MOUNT_KIND,
  DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED,
  DIAGNOSTIC_RELAY_METHOD_GET_STATE,
  isDiagnosticInstanceView,
  type DiagnosticInstanceView,
} from "../gui-contract.ts";

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

if (mountId === null || pluginMountKindOf(mountId) !== DIAGNOSTIC_MOUNT_KIND) {
  show("diagnostic-error", "配置識別子が無いため開始できない。不正な URL である。");
} else {
  // 現在採用中の表示状態。未取得の間は null である。
  let current: DiagnosticInstanceView | null = null;

  /**
   * 採用中の束縛個体の表示を画面に反映する。
   *
   * @param snapshot - 採用中の表示状態。
   */
  function render(snapshot: DiagnosticInstanceView): void {
    show(
      "diagnostic-assignment",
      `${snapshot.localSessionId}（instanceId ${snapshot.instanceId}・接続口 ${snapshot.portId}）`,
    );
    show("diagnostic-echo", `${snapshot.stats.diagnosticEcho} 件`);
    show("diagnostic-ping", `${snapshot.stats.diagnosticPing} 件`);
    show("diagnostic-revision", String(snapshot.revision));
  }

  /** 受信した表示状態を revision 規約で採用し、採用時のみ描画する。 */
  function adopt(incoming: DiagnosticInstanceView): void {
    if (current !== null && incoming.revision <= current.revision) {
      console.log(`[bridge-gui] 古い状態を無視した: incoming=${incoming.revision}`);
      return;
    }
    current = incoming;
    console.log(`[bridge-gui] 状態を更新した: revision=${incoming.revision}`);
    show("diagnostic-error", "");
    render(incoming);
  }

  const rpc = Electroview.defineRPC<CompanionChannelRpc>({
    handlers: {
      requests: {},
      messages: {
        emitted: (event) => {
          if (event.event !== DIAGNOSTIC_RELAY_EVENT_STATE_CHANGED) {
            return;
          }
          if (!isDiagnosticInstanceView(event.payload)) {
            console.log("[bridge-gui] 不正な状態通知を無視した");
            return;
          }
          adopt(event.payload);
        },
      },
    },
  });

  const view = new Electroview({ rpc });

  try {
    // 更新ハンドラ登録後に初期取得し、revision が新しいときだけ採用する。
    // 読取り前の通知はこの取得で追い付く。取得に失敗しても購読は残し、
    // 後の通知で追い付く。自動再送・ポーリングはしない。
    const result = await rpc.request.relay({
      method: DIAGNOSTIC_RELAY_METHOD_GET_STATE,
      params: {},
    });
    if (!result.ok) {
      console.log(`[bridge-gui] 初回取得に失敗した: ${result.error.code}`);
      show("diagnostic-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
    } else if (isDiagnosticInstanceView(result.value)) {
      adopt(result.value);
    } else {
      console.log("[bridge-gui] 初回取得が業務エラーで返った");
      show("diagnostic-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
    }
  } catch (error: unknown) {
    console.log(`[bridge-gui] 初回取得・表示に失敗した: ${String(error)}`);
    show("diagnostic-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
  }

  void view;
}
