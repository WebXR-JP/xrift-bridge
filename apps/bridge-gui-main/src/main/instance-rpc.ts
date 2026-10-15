/**
 * 個体別チャネルの Electrobun 適合層。`BrowserView` への依存はこの小さな層に隔離する。
 *
 * main が持つ Electrobun RPC スキーマは固定の中継要求 `relay` 一つ＋中継通知
 * `emitted` 一つ（`CompanionChannelRpc`）である。子は `relay` だけを呼べ、
 * アプリ本体への専用 ready・ping・状態取得口は持たない。要求相関・応答待ちは
 * 既存 Electrobun RPC を使い、独自 RPC 基盤を追加しない。各マウントの接続は
 * 独立とし、文字列で配送先を選ぶ共有 dispatcher は作らない。
 *
 * 中継の共通形は子→プラグイン `{method, params}`、プラグイン→子
 * `{event, payload}` である。main は中継だけを担い、要求・通知の中身を
 * 解釈しない。未知 method・params の検証は endpoint が行い、main は外形だけを
 * 見る。
 *
 * @packageDocumentation
 */
import { BrowserView } from "electrobun/main";
import type {
  CompanionChannelRpc,
  PluginRelayEvent,
  PluginRelayResult,
} from "bridge-gui-contract/plugin-instance";
import type {
  PluginRelayHandler,
  PluginUiChannel,
  PluginUiChannelFactory,
  PluginUiChildView,
} from "./plugin-ui-mounts.ts";

/**
 * 当該マウントに束縛した個体専用のチャネルを作る。
 *
 * 固定の中継要求 `relay` を当該マウントに閉じ込めた処理へ素通しし、通知は
 * `emitted` で送る。子からの識別子指定は受け付けず、結線時に束縛した個体だけを
 * 使う。
 *
 * @param view - 照合済みの `BrowserView`。
 * @param mountId - 結び付けるマウント識別子。記録用である。
 * @param onRelay - 当該マウントに閉じ込めた中継処理。
 * @returns 当該マウント専用の push 口。
 */
export function createCompanionChannel(
  view: BrowserView,
  mountId: string,
  onRelay: PluginRelayHandler,
): PluginUiChannel {
  void mountId;
  const rpc = BrowserView.defineRPC<CompanionChannelRpc>({
    handlers: {
      requests: {
        relay: (params): Promise<PluginRelayResult> | PluginRelayResult => onRelay(params),
      },
      messages: {},
    },
  });
  // ADR: `initializeRpcTransport()` は `view.rpc` が未設定の場合だけ既定 RPC を
  // 作るため、専用定義を先に代入してから呼び出す。推測の結線口は使わない。
  view.rpc = rpc;
  view.initializeRpcTransport();
  return {
    push(event: PluginRelayEvent): void {
      rpc.send.emitted(event);
    },
  };
}

/**
 * `BrowserView` への `PluginUiChildView` 適合。
 *
 * 生成時の照合に必要な読み取りと、対応付けからの破棄だけを公開する。
 */
export class ElectrobunPluginUiChildView implements PluginUiChildView {
  private readonly inner: BrowserView;

  constructor(view: BrowserView) {
    this.inner = view;
  }

  /** 適合元の `BrowserView`。工場での取り出し専用である。 */
  unwrap(): BrowserView {
    return this.inner;
  }

  get viewId(): number {
    return this.inner.id;
  }

  get hostWebviewId(): number | undefined {
    return this.inner.hostWebviewId;
  }

  get renderer(): string {
    return this.inner.renderer;
  }

  get sandbox(): boolean {
    return this.inner.sandbox;
  }

  get preload(): string | null {
    return this.inner.preload;
  }

  get navigationRules(): string | null {
    return this.inner.navigationRules;
  }

  get currentUrl(): string | null {
    return this.inner.url;
  }

  loadPluginUrl(url: string): void {
    this.inner.loadURL(url);
  }

  removeView(): void {
    this.inner.remove();
  }
}

/**
 * 対応付けが使うチャネル工場。適合層の取り出し専用である。
 *
 * 当該マウントに閉じ込めた中継処理で種別を問わず個体別チャネルを結線する。
 * 子からの識別子指定は受け付けず、結線時に束縛した個体だけを使う。
 *
 * @returns `ElectrobunPluginUiChildView` 専用の工場。偽ハンドルには使わない。
 */
export function createPluginUiChannelFactory(): PluginUiChannelFactory {
  return (view: PluginUiChildView, mountId: string, onRelay: PluginRelayHandler) => {
    if (!(view instanceof ElectrobunPluginUiChildView)) {
      throw new Error("適合層の子画面ではない。");
    }
    return createCompanionChannel(view.unwrap(), mountId, onRelay);
  };
}
