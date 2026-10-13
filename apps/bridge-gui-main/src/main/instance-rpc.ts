/**
 * 段1の SDK 適合層。`BrowserView` への依存はこの小さな層に隔離する。
 *
 * 段0（`spike-rpc.ts`）とは別の RPC 定義で結線し、検証専用のスパイクと
 * 混線させない。要求処理の表は各 companion のアダプターが組み立て、
 * ここでは登録表の記述子を使った汎用の transport 結線と push 口の適合だけを
 * 担う。型検査で確認できた形だけを採用する。
 *
 * @packageDocumentation
 */
import { BrowserView } from "electrobun/main";
import {
  defaultPluginCompanionRegistry,
  type CompanionRequestEnv,
  type PluginCompanionRegistry,
} from "./plugin-companions.ts";
import type {
  PluginUiChannel,
  PluginUiChannelFactory,
  PluginUiChildView,
} from "./plugin-ui-mounts.ts";

/**
 * 種別を問わない個体別 RPC の汎用スキーマ。要求・通知の表は
 * 各 companion の記述子が作り、ここでは素朴に素通りさせる。
 */
type GenericCompanionRpc = {
  bun: {
    requests: Record<string, { params: unknown; response: unknown }>;
    messages: Record<string, unknown>;
  };
  webview: {
    requests: Record<string, { params: unknown; response: unknown }>;
    messages: Record<string, unknown>;
  };
};

/** 汎用スキーマの main 側ハンドラ表。実行時の振る舞いは素朴な表渡しである。 */

/**
 * 当該マウントに束縛した個体専用のチャネルを作る。
 *
 * 登録表の記述子が作った要求処理の表で既定 RPC を置き換え、transport を
 * 結線する。子からの識別子指定は受け付けず、結線時に束縛した個体だけを使う。
 *
 * @param view - 照合済みの `BrowserView`。
 * @param mountId - 結び付けるマウント識別子。
 * @param kind - 束縛する個体の種別トークン。登録済みであること。
 * @param env - main 側の汎用口。
 * @param registry - 種別トークンから記述子を引く登録表。省略時は既定の共有表。
 * @returns 当該マウント専用の push 口。
 * @throws `RangeError` — 未登録種別の場合。
 */
export function createCompanionChannel(
  view: BrowserView,
  mountId: string,
  kind: string,
  env: CompanionRequestEnv,
  registry: PluginCompanionRegistry = defaultPluginCompanionRegistry,
): PluginUiChannel {
  const companion = registry.get(kind);
  if (companion === undefined) {
    throw new RangeError("未登録の種別である。");
  }
  const requestHandlers = companion.buildRequestHandlers(mountId, env);
  // ADR: 汎用表の受け渡しに `as never` を使う理由は、`defineRPC` の
  // ハンドラ型付けが具象スキーマごとであり、種別を問わない表を静的に
  // 証明できないためである。根拠は、`defineElectrobunRPC` がハンドラ表を
  // 実行時に素朴に束ねるだけで表の不足・余剰を検査しないこと、要求名ごとの
  // 型付けは companion の組み立て側（具象の表リテラル）と子画面側（具象の
  // RPC 型）で行うことである。
  const rpc = BrowserView.defineRPC<GenericCompanionRpc>({
    handlers: {
      requests: requestHandlers as never,
      messages: {},
    },
  });
  // ADR: `initializeRpcTransport()` は `view.rpc` が未設定の場合だけ既定 RPC を
  // 作るため、専用定義を先に代入してから呼び出す。推測の結線口は使わない。
  view.rpc = rpc;
  view.initializeRpcTransport();
  const messageName = companion.pushMessageName;
  return {
    push(message: unknown): void {
      // ADR: `as` を使う理由は上記と同様であり、通知名は記述子が固定する。
      // 根拠は、対応付けが同一種別の記述子で結線・送信を対にすることである。
      const send = rpc.send as unknown as Record<string, (payload: unknown) => void>;
      send[messageName](message);
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
 * 登録表の記述子を使って種別を問わず個体別チャネルを結線する。
 * 子からの識別子指定は受け付けず、結線時に束縛した個体だけを使う。
 *
 * @param registry - 種別トークンから記述子を引く登録表。省略時は既定の共有表。
 * @returns `ElectrobunPluginUiChildView` 専用の工場。偽ハンドルには使わない。
 */
export function createPluginUiChannelFactory(
  registry: PluginCompanionRegistry = defaultPluginCompanionRegistry,
): PluginUiChannelFactory {
  return (view: PluginUiChildView, mountId: string, kind: string, env: CompanionRequestEnv) => {
    if (!(view instanceof ElectrobunPluginUiChildView)) {
      throw new Error("適合層の子画面ではない。");
    }
    return createCompanionChannel(view.unwrap(), mountId, kind, env, registry);
  };
}
