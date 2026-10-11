/**
 * 段0スパイクの SDK 適合層。`BrowserView` への依存はこの小さな層に隔離する。
 *
 * 型検査と実往復で確認できた形だけを採用する。`BrowserView.on("created")`
 * の直後に当該マウント専用の RPC 定義で `view.rpc` を置き換え、
 * `initializeRpcTransport()` で結線してから `loadURL()` で読み込む。
 * 推測の結線は採用しない。
 *
 * @packageDocumentation
 */
import { BrowserView } from "electrobun/main";
import type { SpikePushMessage, SpikeRpc } from "../shared/plugin-spike.ts";
import type {
  MountChannel,
  MountChildView,
  SpikeChannelFactory,
  SpikeChannelHooks,
} from "./plugin-mounts.ts";

/**
 * `BrowserView` への `MountChildView` 適合。
 *
 * 生成時の照合に必要な読み取りと、所有表からの破棄だけを公開する。
 */
export class ElectrobunMountChildView implements MountChildView {
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

  loadSpikeUrl(url: string): void {
    this.inner.loadURL(url);
  }

  removeView(): void {
    this.inner.remove();
  }
}

/**
 * 当該マウント専用のチャネルを作る。
 *
 * 生成直後の既定 RPC を専用定義で置き換え、transport を結線する。
 * `BrowserView` の生成処理は既定 RPC で transport を開いているため、
 * 置換後の `initializeRpcTransport()` で作り直す。
 * 子画面の申告識別子は結線済み識別子と照合し、不一致は拒否する。
 *
 * @param view - 照合済みの `BrowserView`。
 * @param mountId - 結び付けるマウント識別子。
 * @param hooks - main 側の応答処理。
 * @returns 当該マウント専用の push 口。
 */
export function createMountChannel(
  view: BrowserView,
  mountId: string,
  hooks: SpikeChannelHooks,
): MountChannel {
  const rpc = BrowserView.defineRPC<SpikeRpc>({
    handlers: {
      requests: {
        getSpikeState: ({ mountId: claimed }) => {
          if (claimed !== mountId) {
            throw new RangeError("結線したマウントと識別子が一致しない。");
          }
          return hooks.handleGetState(mountId);
        },
      },
      messages: {
        spikeReady: ({ mountId: claimed }) => {
          if (claimed !== mountId) {
            console.log(`[bridge-gui] 別マウントの採用通知を無視した: viewId=${view.id}`);
            return;
          }
          hooks.handleReady(mountId);
        },
      },
    },
  });
  // ADR: `initializeRpcTransport()` は `view.rpc` が未設定の場合だけ既定 RPC を
  // 作るため、専用定義を先に代入してから呼び出す。推測の結線口は使わない。
  view.rpc = rpc;
  view.initializeRpcTransport();
  return {
    pushState(message: SpikePushMessage): void {
      rpc.send.spikeStateChanged(message);
    },
  };
}

/**
 * 所有表が使うチャネル工場。適合層の取り出し専用である。
 *
 * @returns `ElectrobunMountChildView` 専用の工場。偽ハンドルには使わない。
 */
export function createChannelFactory(): SpikeChannelFactory {
  return (view: MountChildView, mountId: string, hooks: SpikeChannelHooks) => {
    if (!(view instanceof ElectrobunMountChildView)) {
      throw new Error("適合層の子画面ではない。");
    }
    return createMountChannel(view.unwrap(), mountId, hooks);
  };
}
