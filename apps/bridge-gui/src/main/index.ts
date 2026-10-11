import Electrobun, { BrowserWindow, type ElectrobunEvent } from "electrobun/main";
import { PRODUCTION_ORIGIN } from "bridge-server";
import { GuiBackend } from "./backend.ts";
import { createManagementRpc } from "./rpc.ts";

/**
 * 同梱ページだけを許可する遷移規則。全面拒否を先に置き、
 * 同梱の管理画面だけを後に許可する（後に一致した規則が勝つ）。
 */
const NAVIGATION_RULES = JSON.stringify(["^*", "views://mainview/*"]);

/**
 * 明示的な開発設定として追加する許可 `Origin`（カンマ区切り）。
 *
 * 開発ワールドを `http://localhost:5173` で動かす場合は
 * `BRIDGE_GUI_DEV_ORIGINS=http://localhost:5173` を設定する。既定は空であり、
 * 本番の許可 `Origin` は `PRODUCTION_ORIGIN` のみである。管理操作として
 * `Origin` を編集する口は公開しない。
 */
const devOrigins = (process.env.BRIDGE_GUI_DEV_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const backendOptions =
  devOrigins.length === 0 ? undefined : { allowedOrigins: [PRODUCTION_ORIGIN, ...devOrigins] };

// GUI バックエンドの生成は非同期であるため、到達前から共有する。
const backendPromise: Promise<GuiBackend> = GuiBackend.create(backendOptions);
// 終了手順の共有。二度目以降は同じ終了を待つ（冪等）。
let shutdownTask: Promise<void> | null = null;
// 後始末が終わり、終了・閉鎖の再要求を許可できるか。
let shutdownFinished = false;
// 終了の再要求は一度だけ行う。
let quitReRequested = false;

/**
 * 終了処理。受付終了→基盤終了→待受停止の順で後始末し、完了標識を立てる。
 *
 * 生成前の終了要求にも対応できるよう、生成の完了を待ってから閉じる。
 * 失敗しても再要求まで進め、終了手順自体は止めない。
 */
function shutdown(): Promise<void> {
  if (shutdownTask === null) {
    shutdownTask = (async () => {
      try {
        const target = await backendPromise;
        await target.close();
      } catch (error: unknown) {
        console.log(`[bridge-gui] 後始末に失敗した: ${String(error)}`);
      } finally {
        shutdownFinished = true;
      }
    })();
  }
  return shutdownTask;
}

/**
 * 後始末完了後にアプリ終了を再要求する。一度だけ行う。
 *
 * `before-quit` は Promise を待たないため、同期的な取消しと
 * 後始末完了後の再要求に分ける。
 */
function quitAfterShutdown(): void {
  void shutdown().then(() => {
    if (!quitReRequested) {
      quitReRequested = true;
      Electrobun.Utils.quit();
    }
  });
}

// 段2の観測点。終了要求の受付と再要求だけを残し、待機はしない。
Electrobun.events.on("before-quit", (raw: unknown) => {
  if (shutdownFinished) {
    return;
  }
  // 同期的に終了を取消し、後始末完了後に終了を再要求する。
  const event = raw as ElectrobunEvent<{}, { allow: boolean }>;
  event.response = { allow: false };
  console.log("[bridge-gui] 終了要求を受け付け、後始末を開始する");
  quitAfterShutdown();
});

void backendPromise.then((ready) => {
  if (ready.startupError !== null) {
    console.log(`[bridge-gui] バックエンドの起動に失敗した: ${String(ready.startupError)}`);
  } else {
    console.log("[bridge-gui] バックエンドが稼働した");
  }
  if (shutdownTask !== null) {
    // 生成待ちの間に終了要求が来ていた。窓を作らず後始末へ回す。
    void ready.close();
    return;
  }

  // RPC 接続は `BrowserWindow` 生成より先に用意し、生成時に渡す。
  /** 要求の到達回数。Webview 側の到達証明用に数える（内容は残さない）。 */
  let snapshotRequestCount = 0;

  const rpc = createManagementRpc(ready, {
    onSnapshotRequested: () => {
      snapshotRequestCount += 1;
      console.log(`[bridge-gui] 表示状態の要求を受信した: count=${snapshotRequestCount}`);
    },
    onViewReady: (title) => {
      console.log(`[bridge-gui] 管理画面の準備ができた: ${title}`);
    },
    onQuitRequested: () => {
      if (shutdownFinished) {
        Electrobun.Utils.quit();
        return;
      }
      console.log("[bridge-gui] 管理画面から終了要求を受け付けた");
      quitAfterShutdown();
    },
  });

  // バックエンドの状態変化を Webview へ送る唯一の通知である。
  // 購読者の例外はバックエンド側で隔離する。
  ready.onStateChanged(({ revision, snapshot }) => {
    // 比較コード本文・業務 payload はここに含まれない。
    console.log(`[bridge-gui] 状態を通知する: revision=${revision}`);
    rpc.send.stateChanged({ revision, snapshot });
  });

  const mainWindow = new BrowserWindow({
    title: "XRift Bridge",
    url: "views://mainview/index.html",
    frame: {
      width: 960,
      height: 640,
    },
    // 管理 Webview は同梱ページに限定し、外部遷移を拒否する。
    // `appdata://` は有効にしない。
    navigationRules: NAVIGATION_RULES,
    allowedProtocols: {
      views: true,
      appData: false,
    },
    rpc,
  });

  // 最後の窓を閉じる際も非同期後始末を素通りさせない。同期的に閉鎖を
  // 取消し、後始末完了後に閉鎖を再要求する（二度目は通す）。
  mainWindow.on("will-close", (raw: unknown) => {
    if (shutdownFinished) {
      return;
    }
    const event = raw as ElectrobunEvent<{ id: number }, { allow: boolean }>;
    event.response = { allow: false };
    console.log("[bridge-gui] 窓を閉じる要求を受け付け、後始末を開始する");
    void shutdown().then(() => {
      mainWindow.requestClose();
    });
  });

  // 段2の観測点。Webview の読み込みと RPC 到達を区別するための記録である。
  // payload は残さず、遷移先の有無と文書準備の事実だけを残す。
  function describeNavigation(event: unknown): string {
    if (typeof event === "object" && event !== null && "data" in event) {
      const data = (event as { data: unknown }).data;
      if (typeof data === "string") {
        return data;
      }
      // 遷移イベントの payload は { detail: URL } の形で届く。
      if (typeof data === "object" && data !== null && "detail" in data) {
        const detail = (data as { detail: unknown }).detail;
        if (typeof detail === "string") {
          return detail;
        }
      }
    }
    return "詳細不明";
  }

  mainWindow.webview.on("did-navigate", (event: unknown) => {
    console.log(`[bridge-gui] Webview が遷移した: ${describeNavigation(event)}`);
  });

  mainWindow.webview.on("dom-ready", () => {
    console.log("[bridge-gui] Webview の文書を読み込んだ");
  });

  console.log("[bridge-gui] 主処理を開始した");
});
