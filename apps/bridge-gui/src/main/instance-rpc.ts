/**
 * 段1の SDK 適合層。`BrowserView` への依存はこの小さな層に隔離する。
 *
 * 段0（`spike-rpc.ts`）とは別の RPC 定義（`plugin-instance.ts`）で結線し、
 * 検証専用のスパイクと混線させない。要求処理の表は SDK 非依存の
 * `src/main/plugin-instances.ts` が組み立て、ここでは transport の結線と
 * push 口の適合だけを担う。型検査で確認できた形だけを採用する。
 *
 * @packageDocumentation
 */
import { BrowserView } from "electrobun/main";
import type {
  DiagnosticInstanceChangedMessage,
  DiagnosticInstanceRpc,
  PluginUiMountKind,
  TextInstanceChangedMessage,
  TextInstanceRpc,
} from "../shared/plugin-instance.ts";
import {
  buildDiagnosticRequestHandlers,
  buildTextRequestHandlers,
  type InstanceChannelHooks,
} from "./plugin-instances.ts";
import type {
  PluginUiChannel,
  PluginUiChannelFactory,
  PluginUiChildView,
} from "./plugin-ui-mounts.ts";

/** テキスト個体専用の push 口。当該マウントの結線だけに送る。 */
export interface TextInstanceChannel {
  /**
   * 状態 push を送る。
   *
   * @param message - 送り先の改訂番号と snapshot。本文は含めない。
   */
  pushText(message: TextInstanceChangedMessage): void;
}

/** 診断個体専用の push 口。当該マウントの結線だけに送る。 */
export interface DiagnosticInstanceChannel {
  /**
   * 状態 push を送る。
   *
   * @param message - 送り先の改訂番号と snapshot。本文は含めない。
   */
  pushDiagnostic(message: DiagnosticInstanceChangedMessage): void;
}

/**
 * 当該マウントに束縛したテキスト個体専用のチャネルを作る。
 *
 * 生成直後の既定 RPC を専用定義で置き換え、transport を結線する。
 * 子からの識別子指定は受け付けず、結線時に束縛した個体だけを使う。
 *
 * @param view - 照合済みの `BrowserView`。
 * @param mountId - 結び付けるマウント識別子。
 * @param hooks - main 側の応答処理。
 * @returns 当該マウント専用の push 口。
 */
export function createTextInstanceChannel(
  view: BrowserView,
  mountId: string,
  hooks: InstanceChannelHooks,
): TextInstanceChannel {
  const rpc = BrowserView.defineRPC<TextInstanceRpc>({
    handlers: {
      requests: buildTextRequestHandlers(mountId, hooks),
      messages: {},
    },
  });
  // ADR: `initializeRpcTransport()` は `view.rpc` が未設定の場合だけ既定 RPC を
  // 作るため、専用定義を先に代入してから呼び出す。推測の結線口は使わない。
  view.rpc = rpc;
  view.initializeRpcTransport();
  return {
    pushText(message: TextInstanceChangedMessage): void {
      rpc.send.textStateChanged(message);
    },
  };
}

/**
 * 当該マウントに束縛した診断個体専用のチャネルを作る。
 *
 * @param view - 照合済みの `BrowserView`。
 * @param mountId - 結び付けるマウント識別子。
 * @param hooks - main 側の応答処理。
 * @returns 当該マウント専用の push 口。
 */
export function createDiagnosticInstanceChannel(
  view: BrowserView,
  mountId: string,
  hooks: InstanceChannelHooks,
): DiagnosticInstanceChannel {
  const rpc = BrowserView.defineRPC<DiagnosticInstanceRpc>({
    handlers: {
      requests: buildDiagnosticRequestHandlers(mountId, hooks),
      messages: {},
    },
  });
  view.rpc = rpc;
  view.initializeRpcTransport();
  return {
    pushDiagnostic(message: DiagnosticInstanceChangedMessage): void {
      rpc.send.diagnosticStateChanged(message);
    },
  };
}

/**
 * `BrowserView` への `PluginUiChildView` 適合。
 *
 * 生成時の照合に必要な読み取りと、対応付けからの破棄だけを公開する。
 * 段0の適合層（`spike-rpc.ts`）とは別の型であり、取り違えない。
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
 * 種別に応じてテキスト・診断のいずれかの個体別チャネルを結線する。
 * 子からの識別子指定は受け付けず、結線時に束縛した個体だけを使う。
 *
 * @returns `ElectrobunPluginUiChildView` 専用の工場。偽ハンドルには使わない。
 */
export function createPluginUiChannelFactory(): PluginUiChannelFactory {
  return (
    view: PluginUiChildView,
    mountId: string,
    kind: PluginUiMountKind,
    hooks: InstanceChannelHooks,
  ) => {
    if (!(view instanceof ElectrobunPluginUiChildView)) {
      throw new Error("適合層の子画面ではない。");
    }
    const raw = view.unwrap();
    if (kind === "text") {
      const channel = createTextInstanceChannel(raw, mountId, hooks);
      const pushText: PluginUiChannel = {
        pushText: (message) => channel.pushText(message),
      };
      return pushText;
    }
    const channel = createDiagnosticInstanceChannel(raw, mountId, hooks);
    const pushDiagnostic: PluginUiChannel = {
      pushDiagnostic: (message) => channel.pushDiagnostic(message),
    };
    return pushDiagnostic;
  };
}
