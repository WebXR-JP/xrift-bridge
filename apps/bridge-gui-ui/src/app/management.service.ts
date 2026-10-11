/**
 * 管理画面 RPC の Angular 向け薄い包み。
 *
 * DTO・操作・採用規約の再定義はしない。契約型（`ManagementRpc`・
 * `ManagementSnapshot`・`selectNewer`）は bridge-gui の共有型を相対
 * import で再利用する（スパイク段階の境界。循環が無いことを `tsc` で確かめる）。
 * 子画面タグの配置は既存の所有表（`spikeCreate` 発行の DTO）とだけ結び付け、
 * 実プラグインの対応付けには触らない。
 */
import { Injectable, isDevMode, signal } from "@angular/core";
import { Electroview } from "electrobun/view";
import type {
  ManagementRpc,
  ManagementSnapshot,
  NgDebugProbeResult,
} from "../../../bridge-gui/src/shared/management.ts";
import { selectNewer } from "../../../bridge-gui/src/shared/management.ts";
import { SPIKE_NAVIGATION_RULES_ATTRIBUTE } from "../../../bridge-gui/src/shared/plugin-spike.ts";
import { buildNgDebugProbeResult } from "./ng-probe.ts";

/**
 * main の JS 実行標識の合言葉。本文・payload ではなく到達確認用の固定値である。
 *
 * main が開発観測（`BRIDGE_GUI_NG_DEBUG=1`）で
 * `window.__ngExecMark="ng-exec-ok"` を書き込み、観測口が有無だけを返す。
 */
const EXEC_MARK_VALUE = "ng-exec-ok";

/** main の JS 実行標識を検出する。到達の有無だけを返す。 */
function readExecMark(): boolean {
  const marker = (window as unknown as Record<string, unknown>)["__ngExecMark"];
  return marker === EXEC_MARK_VALUE;
}

@Injectable({ providedIn: "root" })
export class ManagementService {
  private readonly current = signal<ManagementSnapshot | null>(null);

  private readonly pushRevision = signal<number | null>(null);

  /** 現在採用中の表示状態。未取得の間は null である。 */
  readonly snapshot = this.current.asReadonly();

  /** 最後に受信した `stateChanged` の改訂番号。push 到達の確認用である。 */
  readonly lastPushRevision = this.pushRevision.asReadonly();

  /** 配置した子画面タグ。更新ごとの作り直しはしない。 */
  private spikeTag: HTMLElement | null = null;

  private readonly rpc = Electroview.defineRPC<ManagementRpc>({
    handlers: {
      requests: {
        ngDebugProbe: () => this.buildProbe(),
      },
      messages: {
        stateChanged: ({ revision, snapshot }) => {
          // push の到達自体を記録する。採用規約で無視される場合も到達は残る。
          this.pushRevision.set(revision);
          this.adopt(snapshot, "stateChanged");
        },
      },
    },
  });

  /** RPC 接続の保持。購読の破棄はしない（画面の寿命と同じ）。 */
  private readonly view = new Electroview({ rpc: this.rpc });

  constructor() {
    // 接続の保持だけが目的であり、以後は `rpc` 経由で使う。
    void this.view;
  }

  /** 受信した表示状態を revision 規約で採用し、採用時のみ反映する。 */
  private adopt(incoming: ManagementSnapshot, via: "getSnapshot" | "stateChanged"): void {
    const previous = this.current();
    const next = selectNewer(previous, incoming);
    if (next !== previous) {
      this.current.set(next);
      // 改訂番号を文書題にも反映する。画面での表示確認用である。
      document.title = `XRift Bridge 管理画面（Angular） — rev ${next.revision}`;
      console.log(`[bridge-gui-ng] 状態を更新した: via=${via} revision=${next.revision}`);
    } else {
      console.log(`[bridge-gui-ng] 古い状態を無視した: via=${via} incoming=${incoming.revision}`);
    }
  }

  /**
   * Angular 開発 API（`ng.getComponent` 系）の観測。
   *
   * `ng.getComponent`（無ければ `ng.getOwningComponent`）が関数として
   * 使えるか、ルート要素からコンポーネント実体が取得できるかを真偽で
   * 返す。実体・injector は返さず有無だけを見る。呼び出しの例外は内容を
   * 載せず失敗として返す（応答組み立てが定型の理由に落とす）。
   *
   * @returns 取得関数の有無・実体の有無・呼び出し失敗の真偽。
   */
  private readComponentProbe(): {
    hasGetComponent: boolean;
    resolvedComponent: boolean;
    getFailed: boolean;
  } {
    const ng = (globalThis as unknown as Record<string, unknown>)["ng"];
    if (typeof ng !== "object" || ng === null) {
      return { hasGetComponent: false, resolvedComponent: false, getFailed: false };
    }
    // `as` は実行時の検証にならないため、関数の有無は `typeof` で確かめる。
    // `ng` の形は Angular の版で変わるため、表引きで読む。
    const table = ng as Record<string, unknown>;
    const getter =
      typeof table["getComponent"] === "function"
        ? (table["getComponent"] as (element: Element) => unknown)
        : typeof table["getOwningComponent"] === "function"
          ? (table["getOwningComponent"] as (element: Element) => unknown)
          : null;
    if (getter === null) {
      return { hasGetComponent: false, resolvedComponent: false, getFailed: false };
    }
    const root = document.querySelector("app-root");
    if (root === null) {
      return { hasGetComponent: true, resolvedComponent: false, getFailed: false };
    }
    try {
      const instance = getter(root);
      return {
        hasGetComponent: true,
        resolvedComponent: instance !== null && instance !== undefined,
        getFailed: false,
      };
    } catch {
      return { hasGetComponent: true, resolvedComponent: false, getFailed: true };
    }
  }

  /** 開発専用観測口の応答を組み立てる。許可 DTO だけを返す。 */
  private buildProbe(): NgDebugProbeResult {
    const ng = (globalThis as unknown as Record<string, unknown>)["ng"];
    const component = this.readComponentProbe();
    return buildNgDebugProbeResult({
      devMode: isDevMode(),
      hasNg: ng !== undefined,
      componentMounted: document.querySelector("app-root") !== null,
      revision: this.current()?.revision ?? null,
      webviewTagCount: document.querySelectorAll("electrobun-webview").length,
      spikeTagKept: this.spikeTag !== null && document.contains(this.spikeTag),
      execMark: readExecMark(),
      hasGetComponent: component.hasGetComponent,
      resolvedComponent: component.resolvedComponent,
      getFailed: component.getFailed,
    });
  }

  /** 初回取得し、revision が新しいときだけ採用する。 */
  async fetchInitial(): Promise<void> {
    try {
      this.adopt(await this.rpc.request.getSnapshot({}), "getSnapshot");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 初回取得・表示に失敗した: ${String(error)}`);
    }
  }

  /** 準備完了を通知する。 */
  notifyReady(): void {
    try {
      this.rpc.send.viewReady({ title: document.title });
      console.log("[bridge-gui-ng] 準備完了を通知した");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 準備完了の通知に失敗した: ${String(error)}`);
    }
  }

  /** 所有一覧の残存を掃除する。vanilla 再読込み時と同様である。 */
  async resetSpike(via: string): Promise<void> {
    try {
      await this.rpc.request.spikeReset({});
      console.log("[bridge-gui-ng] 子画面の残存を掃除した");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の掃除に失敗した: ${via} ${String(error)}`);
    }
  }

  /** 受付を有効化し、採用中の表示状態を返す。 */
  async enableAcceptance(): Promise<void> {
    try {
      await this.rpc.request.enableAcceptance({});
      console.log("[bridge-gui-ng] 受付を有効化した");
      await this.fetchInitial();
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 受付の有効化に失敗した: ${String(error)}`);
    }
  }

  /** 受付を無効化し、採用中の表示状態を返す。 */
  async disableAcceptance(): Promise<void> {
    try {
      await this.rpc.request.disableAcceptance({});
      console.log("[bridge-gui-ng] 受付を無効化した");
      await this.fetchInitial();
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 受付の無効化に失敗した: ${String(error)}`);
    }
  }

  /**
   * 子画面を1つ作り、配置用 DTO に従ってタグを一度だけ置く。
   *
   * @param host - 配置先の要素。
   */
  async createSpike(host: HTMLElement): Promise<void> {
    try {
      const created = await this.rpc.request.spikeCreate({});
      console.log(`[bridge-gui-ng] 子画面を作った: mountId=${created.mountId}`);
      this.placeSpikeTag(created.mountId, created.initialUrl, host);
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の作成に失敗した: ${String(error)}`);
    }
  }

  /**
   * 配置用 DTO に従ってタグを一度だけ置く。既存は作り直さない。
   *
   * @param mountId - 所有表が発行したマウント識別子。
   * @param initialUrl - 所有表が発行した初期 URL。
   * @param host - 配置先の要素。
   */
  placeSpikeTag(mountId: string, initialUrl: string, host: HTMLElement): void {
    if (this.spikeTag !== null) {
      return;
    }
    const tag = document.createElement("electrobun-webview");
    // 初期 URL は main 発行の DTO をそのまま載せる。任意 URL・HTML・preload は付けない。
    tag.setAttribute("src", initialUrl);
    tag.setAttribute("renderer", "native");
    tag.setAttribute("navigation-rules", SPIKE_NAVIGATION_RULES_ATTRIBUTE);
    tag.id = `ng-spike-${mountId}`;
    host.append(tag);
    this.spikeTag = tag;
    console.log(`[bridge-gui-ng] 子画面を置いた mountId=${mountId}`);
  }

  /** 配置した子画面タグが文書に残っているか。同一性保持の確認用である。 */
  isSpikeTagKept(): boolean {
    return this.spikeTag !== null && document.contains(this.spikeTag);
  }
}
