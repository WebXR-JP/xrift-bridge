import Electrobun, { BrowserView, BrowserWindow, type ElectrobunEvent } from "electrobun/main";
import { PRODUCTION_ORIGIN } from "bridge-server";
import { parsePluginMountId } from "bridge-gui-contract/plugin-instance";
import { GuiBackend } from "./backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../composition/bundled-plugins.ts";
import {
  DEV_CONSOLE_OPT_IN_ENV,
  shouldStartDevConsole,
  startDevConsole,
  type DevConsole,
} from "./dev-console.ts";
import { LocalMcpController } from "./mcp.ts";
import { createManagementRpc } from "./rpc.ts";
import type { PluginUiOperations } from "./rpc.ts";
import { ElectrobunPluginUiChildView, createPluginUiChannelFactory } from "./instance-rpc.ts";
import { PluginUiCoordinator } from "./plugin-ui-mounts.ts";

/**
 * 同梱ページだけを許可する遷移規則。全面拒否を先に置き、
 * 同梱の管理画面だけを後に許可する（後に一致した規則が勝つ）。
 */
const NAVIGATION_RULES = JSON.stringify(["^*", "views://mainview/*"]);

/**
 * 管理画面の URL。Angular を唯一の管理画面とし、`views://mainview/` に固定する。
 */
const GUI_VIEW_URL = "views://mainview/index.html";

/**
 * Angular 画面の開発観測の有効化。既定無効・明示 opt-in である。
 *
 * `BRIDGE_GUI_NG_DEBUG=1` の場合だけ、文書読込み後に JS 実行標識を書き込み、
 * 開発専用口（`ngDebugProbe`）で観測して記録する。待受 port（3100）の
 * 管理操作には混ぜない。
 */
const ngDebugEnabled = process.env.BRIDGE_GUI_NG_DEBUG === "1";

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
// 同梱プラグインの選択と登録順は composition root が宣言し、
// backend は受け取った登録関数と view パス解決口だけを使う。
const backendPromise: Promise<GuiBackend> = GuiBackend.create(backendOptions, {
  registerPlugins: registerBundledPlugins,
  resolvePluginViewPath: resolveBundledPluginViewPath,
});
// 終了手順の共有。二度目以降は同じ終了を待つ（冪等）。
let shutdownTask: Promise<void> | null = null;
// 開発専用の AI 操作・観測口（loopback 接続口）。有効条件（三つ）を
// 満たすときだけ起動し、終了処理で必ず閉じる。stable は環境変数を
// 設定しても開かない。
let devConsole: DevConsole | null = null;
// 製品向けローカル業務操作 MCP の実行単位の寿命。起動時の環境変数と
// 管理画面の設定操作を同じゲートの二つの入口として扱い、有効状態を
// 次回起動へ保存しない。開発用の接続口とはゲート・待受けを混ぜない（製品向けに
// 資格情報は持たない）。
let mcpController: LocalMcpController | null = null;
// 実プラグイン子画面の対応付け。窓の生成後に結び付け、終了処理で破棄する。
let pluginUi: PluginUiCoordinator | null = null;
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
        // 開発接続口を先に閉じ、新規の外部操作を止める。
        if (devConsole !== null) {
          await devConsole.close();
          devConsole = null;
        }
        // 製品向け MCP を閉じ、新規の業務操作を止める。個体の受付は失効する。
        if (mcpController !== null) {
          await mcpController.close();
        }
        // 子画面の対応付けを先に破棄し、BrowserView・購読を残さない。
        // 実プラグイン子画面も対応付けの削除と表示の破棄を行い残さない。
        pluginUi?.resetAll("終了");
        pluginUi = null;
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

/**
 * 実プラグイン子画面の管理が無い状態での書込み要求拒否。窓の生成前には到達しない。
 *
 * @throws `Error` — 常に投げる。
 */
function failPluginUi(): never {
  throw new Error("実プラグイン子画面の管理が無い。");
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

void backendPromise.then(async (ready) => {
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

  // 実プラグイン子画面の配置操作口。読み取りは管理が無ければ空とし、
  // 書込み（再試行）は結線の不備として拒否する。開発接続口と共有する。
  const pluginUiOps: PluginUiOperations = {
    syncPluginUi: () => {
      pluginUi?.syncNow();
    },
    listPluginUiMounts: () => pluginUi?.listPlacements() ?? [],
    listPluginUiFailures: () => pluginUi?.listFailures() ?? [],
    retryPluginUiMount: (instanceId: unknown) =>
      pluginUi?.retryFailed(instanceId) ?? failPluginUi(),
  };

  // 製品向けローカル業務操作 MCP の寿命。起動時の環境変数と管理画面の
  // 設定操作を同じゲートの二つの入口として扱い、有効状態を次回起動へ
  // 保存しない。画面から停止した後は、環境変数を理由に同一実行内で
  // 自動再開しない。待受けを開けない場合も通常の GUI と backend は
  // 起動を継続し、開始失敗は公開状態に載せて管理画面から分かるようにする。
  mcpController = new LocalMcpController(ready);
  const mcp = mcpController;
  // 起動時の env 入口。完了を待ってから窓を作り、開始の記録を残す。
  await mcp.startFromEnv();
  if (mcp.getStatus().enabled) {
    console.log("[bridge-gui] MCPを開始した");
  }

  const rpc = createManagementRpc(
    ready,
    {
      onSnapshotRequested: () => {
        snapshotRequestCount += 1;
        console.log(`[bridge-gui] 表示状態の要求を受信した: count=${snapshotRequestCount}`);
      },
      onQuitRequested: () => {
        if (shutdownFinished) {
          Electrobun.Utils.quit();
          return;
        }
        console.log("[bridge-gui] 管理画面から終了要求を受け付けた");
        quitAfterShutdown();
      },
    },
    pluginUiOps,
    mcp,
  );
  // 製品向け MCP の公開状態の変化を Webview へ送る。接続先 URL を含む公開状態そのものであり、資格情報は含まない。
  mcp.onChanged((state) => {
    rpc.send.localMcpChanged(state);
  });

  // 開発専用の AI 操作・観測口。有効条件（三つ）を満たすときだけ
  // loopback に開き、終了処理で閉じる。許可操作は既存操作への委譲であり、
  // DOM 反映の観測は限定 Webview RPC（`ngDevObserve`）で行う。
  if (shouldStartDevConsole()) {
    devConsole = startDevConsole(ready, pluginUiOps, {
      observeDom: (revision) => rpc.request.ngDevObserve({ revision }),
    });
    console.log(
      `[bridge-gui] 開発口を開始した: host=127.0.0.1 port=${devConsole.port} token=${devConsole.token}`,
    );
  } else if (process.env[DEV_CONSOLE_OPT_IN_ENV] === "1") {
    console.log("[bridge-gui] 開発口を開かない（開発ビルドではない）。");
  }

  // バックエンドの状態変化を Webview へ送る購読は、対応付けの用意後に
  // 登録する。対応付けの追随を先に行い、配置の現在値を載せて送る。

  const mainWindow = new BrowserWindow({
    title: "XRift Bridge",
    url: GUI_VIEW_URL,
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

  // 実プラグイン子画面の対応付け。表示要求への追随と個体別チャネルの結線を担う。
  // companion 登録表・個体管理層は backend が生成したものを注入する
  // （共有 singleton は使わない）。表示要求は backend の `pluginView` を正とする。
  const registry = ready.companionRegistry;
  const manager = ready.instanceManager;
  if (manager !== null) {
    pluginUi = new PluginUiCoordinator(
      mainWindow.webview.id,
      ready,
      createPluginUiChannelFactory(),
      Date.now,
      registry,
      manager,
      () => ready.getPluginView(),
    );
  }
  // バックエンドの状態変化への追随を先に登録し、Webview への通知を後に
  // 登録する。対応付けの整理を先に行い、配置の現在値を載せて送る。
  // 購読者の例外はバックエンド側で隔離する。
  ready.onStateChanged(() => {
    pluginUi?.syncNow();
  });
  // バックエンドの状態変化を Webview へ送る唯一の通知である。
  ready.onStateChanged(({ revision, snapshot }) => {
    // 比較コード本文・業務 payload・テキスト本文はここに含まれない。
    console.log(`[bridge-gui] 状態を通知する: revision=${revision}`);
    rpc.send.stateChanged({
      revision,
      snapshot: {
        ...snapshot,
        pluginMounts: pluginUi?.listPlacements() ?? [],
        pluginMountFailures: pluginUi?.listFailures() ?? [],
      },
    });
  });

  BrowserView.on("created", (view) => {
    // 実プラグインの生成だけを対応付けが消費・回収する。
    // 他名前空間の生成には触らず無視する。
    const pluginCandidate = new ElectrobunPluginUiChildView(view);
    if (parsePluginMountId(pluginCandidate.currentUrl) !== null) {
      if (pluginUi === null) {
        console.log("[bridge-gui] 実プラグイン子画面の管理が無いため回収した");
        try {
          pluginCandidate.removeView();
        } catch {
          // 破棄の失敗は生成の照合を止めない。
        }
        return;
      }
      const consumed = pluginUi.handleTagCreated(pluginCandidate);
      if (!consumed && pluginCandidate.hostWebviewId === mainWindow.webview.id) {
        console.log("[bridge-gui] 由来不明の実プラグイン生成を回収した");
        try {
          pluginCandidate.removeView();
        } catch {
          // 破棄の失敗は生成の照合を止めない。
        }
      }
      return;
    }
  });

  mainWindow.webview.on("did-navigate", (event: unknown) => {
    console.log(`[bridge-gui] Webview が遷移した: ${describeNavigation(event)}`);
    // 表示期間を先に終了させて旧要求を失効させ、その後で子を回収する。
    // 順序を逆にすると旧世代の配置が残り、新子と混線する。
    // 現表示要求への再配置は次回の状態通知・取得で作り直す。
    ready.endPluginViewForNavigation();
    pluginUi?.resetAll("管理画面の遷移");
  });

  mainWindow.webview.on("dom-ready", () => {
    console.log("[bridge-gui] Webview の文書を読み込んだ");
    if (ngDebugEnabled) {
      // 開発観測は Angular の起動を待ってから行う。失敗しても起動を止めない。
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        mainWindow.webview.executeJavascript(`window.__ngExecMark="ng-exec-ok";`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const result = await rpc.request.ngDebugProbe({});
          // 許可 DTO の要点だけを残す。
          console.log(
            `[bridge-gui] 開発口の観測結果: available=${result.available} hasNg=${result.hasNg} mounted=${result.componentMounted} getFn=${result.hasGetComponent} got=${result.resolvedComponent} revision=${result.revision} tags=${result.webviewTagCount} exec=${result.execMark} reason=${result.reason}`,
          );
        } catch (error: unknown) {
          console.log(`[bridge-gui] 開発口の観測に失敗した: ${String(error)}`);
        }
      })();
    }
  });

  console.log("[bridge-gui] 主処理を開始した");
});
