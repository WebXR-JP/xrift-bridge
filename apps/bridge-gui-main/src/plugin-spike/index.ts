/**
 * 段0スパイクの子画面。自分のマウント識別子の表示、main への状態取得、
 * main からの push 受信回数の表示だけを行う。
 *
 * 実プラグインの結線はしない。マウント識別子は main が発行した URL の
 * 断片から読み、申告では決めない。準備完了は初期 snapshot の採用通知で
 * main へ送り、`dom-ready` だけでは判定しない。
 */
import { Electroview } from "electrobun/view";
import type { SpikeRpc } from "bridge-gui-contract/plugin-spike";
import { parseMountId } from "bridge-gui-contract/plugin-spike";

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
const mountId = parseMountId(window.location.href);
// main からの push 受信回数。混線の確認用である。
let pushCount = 0;
// 採用中の改訂番号。古い push では巻き戻さない。
let adoptedRevision = -1;

if (mountId === null) {
  show("spike-error", "配置識別子が無いため開始できない。不正な URL である。");
} else {
  show("spike-mount", mountId);
  const rpc = Electroview.defineRPC<SpikeRpc>({
    handlers: {
      requests: {},
      messages: {
        spikeStateChanged: (message) => {
          // 当該マウント専用の結線に届くはずであり、別識別子は無視する。
          if (message.mountId !== mountId) {
            console.log("[bridge-gui] 別マウントの push を無視した");
            return;
          }
          if (message.revision <= adoptedRevision) {
            console.log(`[bridge-gui] 古い push を無視した: revision=${message.revision}`);
            return;
          }
          adoptedRevision = message.revision;
          pushCount += 1;
          show("spike-revision", String(adoptedRevision));
          show("spike-pushes", String(pushCount));
        },
      },
    },
  });

  const view = new Electroview({ rpc });

  try {
    // 初期 snapshot を取得し、採用してから準備完了を通知する。
    const snapshot = await rpc.request.getSpikeState({ mountId });
    if (snapshot.mountId !== mountId) {
      throw new Error("結線したマウントと応答が一致しない。");
    }
    adoptedRevision = snapshot.revision;
    show("spike-revision", String(adoptedRevision));
    rpc.send.spikeReady({ mountId });
    show("spike-ready", "準備完了を通知した");
  } catch (error: unknown) {
    console.log(`[bridge-gui] 初期取得に失敗した: ${String(error)}`);
    show("spike-error", "初期取得に失敗した。main 側の記録を見ること。");
  }

  void view;
}
