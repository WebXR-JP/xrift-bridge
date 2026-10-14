/**
 * 管理画面の表示状態・限定操作の Angular 向け保持者。
 *
 * RPC 送受信は `ManagementRpcClient` に任せ、ここでは signals による表示状態の
 * 採用（`selectNewer`）・初期同期・共通操作処理だけを行う。DTO・操作・採用規約の
 * 再定義はしない。契約型（`ManagementRpc`・`ManagementSnapshot`・`selectNewer`）
 * は `bridge-gui-contract` の公開 subpath から再利用する（循環が無いことを
 * `tsc` で確かめる）。子画面タグの配置は所有表の発行する配置用 DTO
 * （実プラグインは snapshot の `pluginMounts`、段0は `spikeList` の結果）と
 * だけ結び付け、任意 URL・HTML・preload は付けない。
 *
 * 比較コード本文・業務 payload・テキスト本文は signals・ログに残さない。
 * 比較コードの表示用取得結果だけを保留行の一時状態（`pairingViews`）に保持し、
 * 保留が消えたら破棄する。
 */
import { Injectable, isDevMode, signal } from "@angular/core";
import type {
  ManagementSnapshot,
  NgDebugProbeResult,
  NgDevObserveResult,
  PairingViewResult,
} from "bridge-gui-contract/management";
import { selectNewer } from "bridge-gui-contract/management";
import type { PluginUiMountPlacement } from "bridge-gui-contract/plugin-instance";
import { SPIKE_NAVIGATION_RULES_ATTRIBUTE } from "bridge-gui-contract/plugin-spike";
import type { SpikeMountSummary } from "bridge-gui-contract/plugin-spike";
import { ManagementRpcClient } from "./rpc.ts";
import { buildNgDebugProbeResult } from "../ng-probe.ts";
import { buildNgDevObserveResult, DEV_OBSERVE_TARGETS } from "../dev-observe.ts";
import type { DevObserveElementInput } from "../dev-observe.ts";

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

/** 操作失敗の説明を作る。本文は含めない（失敗理由だけである）。 */
function describeActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 受信記録の1行（管理画面の表示用構造）。
 *
 * `time` は描画時に作らず、`appendLog` の時点で一度だけ付ける（再描画で
 * 変わらない）。同時刻の行があっても `id` で区別する。
 */
export interface EventLogEntry {
  /** ローカル連番。行の安定キーであり、同時刻でも衝突しない。 */
  readonly id: number;
  /** 記録した時刻（`HH:mm:ss`）。 */
  readonly time: string;
  /** 安全な要約。比較コード本文・業務 payload・DTO 全文・生の例外文字列は載せない。 */
  readonly message: string;
}

/** 記録時刻の表示（`HH:mm:ss`）を作る。 */
function formatLogTime(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 子画面タグの `toggleHidden` 初期化待ちの上限（フレーム数）。
 *
 * append 直後は `webviewId` が `null` で `toggleHidden` が何もしないため、
 * rAF で再試行する。無制限ループにしないための上限であり、超えたら諦めて
 * 記録を残す。
 */
const PLUGIN_HIDDEN_RETRY_LIMIT = 120;

/** `toggleHidden` と初期化標識を持つ子画面タグの最小形（試験の fake を含む）。 */
interface PluginVisibilityTag {
  /** 初期化済みの場合に数値。未初期化は `null` 等である。 */
  readonly webviewId?: unknown;
  /** 初期化済みの場合に native 表示を切り替える。未初期化は何もしない。 */
  toggleHidden?: (hidden?: boolean) => void;
}

@Injectable({ providedIn: "root" })
export class ManagementService {
  private readonly current = signal<ManagementSnapshot | null>(null);

  private readonly pushRevision = signal<number | null>(null);

  // ADR: 比較コードの表示用取得結果は保留行の一時状態であり、snapshot の一部に
  // しない。表示のためだけに保持し、保留が消えたら破棄する（再送基盤は作らない）。
  // signal の値は読取り専用の写しとして公開し、呼び出し側の書換えを受けない。
  private readonly views = signal<ReadonlyMap<string, PairingViewResult>>(new Map());

  // ADR: 受信記録は管理画面で受信・記録した時刻を載せる。backend の発生時刻
  // ではないため、snapshot や push の時刻欄から写さず、`appendLog` の時点で
  // ローカル時計を一度だけ読む。時刻付与のために新しい業務データは取得せず、
  // 採用／無視の符号と操作結果の要約だけを載せる（比較コード本文・payload は
  // 載せない）。小規模利用前提のため件数上限や履歴保存は追加しない。
  // 描画側は `time` をそのまま示し、時刻を生成しない（再描画で変わらない）。
  // `id` はローカル連番の行キーであり、同時刻でも衝突しない。
  private readonly log = signal<readonly EventLogEntry[]>([]);

  // 受信記録の次の行番号。`log` とは別に持ち、行の安定キーに使う。
  private nextLogId = 0;

  /** テキスト操作の失敗表示。本文は含めない（失敗理由だけである）。 */
  private readonly textFailure = signal("");

  /** 現在採用中の表示状態。未取得の間は null である。 */
  readonly snapshot = this.current.asReadonly();

  /** 最後に受信した `stateChanged` の改訂番号。push 到達の確認用である。 */
  readonly lastPushRevision = this.pushRevision.asReadonly();

  /** 保留行の一時状態（表示用の比較コード取得結果）。消滅後は破棄する。 */
  readonly pairingViews = this.views.asReadonly();

  /** 受信記録。採用／無視と操作結果の要約だけを載せる。 */
  readonly eventLog = this.log.asReadonly();

  /** テキスト操作の失敗表示。本文は含めない（失敗理由だけである）。 */
  readonly textError = this.textFailure.asReadonly();

  // 段0スパイクの所有一覧の表示状態。タグ配置の照合元であり、
  // `spikeList` の結果だけを載せる（履歴は持たない）。
  private readonly spikeSummaries = signal<readonly SpikeMountSummary[]>([]);

  /** 段0スパイクの所有一覧の表示状態。 */
  readonly spikeMounts = this.spikeSummaries.asReadonly();

  // ADR: 二重押下での重複送信を避けるため、実行中の操作を識別子で覚える。
  // 汎用 store は作らず、この集合だけを重複抑止に使う。失敗・成功のいずれでも
  // 実行後は外す。
  private readonly inflight = new Set<string>();

  // ADR: 子画面タグは Angular テンプレートで宣言的に描画せず、安定した host
  // 要素へ命令的に追加／削除する。表示状態の更新（revision 進行）で `src` の
  // 再設定・タグの再生成・DOM の移動をしない。同一性は mountId 単位の所有表
  // （実プラグインは snapshot の `pluginMounts`、段0は `spikeList` の結果）で
  // 保ち、一度置いた要素は作り直さない。消えた mountId の要素だけを外す。
  // 配置先の host は入れ物が `registerMountHosts` で渡す（`ViewChild` の要素）。
  private readonly spikeTags = new Map<string, HTMLElement>();
  private readonly pluginTags = new Map<string, HTMLElement>();
  private spikeHost: HTMLElement | null = null;
  private pluginHost: HTMLElement | null = null;

  // ADR: native 子画面の表示は `toggleHidden` でのみ切り替える。HTML の
  // `hidden` 属性は観測されず、CSS の `display:none` は native 子ビューの
  // 非表示を保証しない。`OverlaySync` の矩形 0x0 停止も非表示にはならない。
  // 表示対象は mountId 単位の所有表の `instanceId` で決め、タグの再生成・
  // DOM 移動・`src` 再設定はしない。切替は業務 RPC を送らない。
  // 状態は operations 画面の選択と選択中インスタンスだけであり、段0は対象外
  // （開発用に常時表示のままにする）。
  private pluginViewVisible = false;
  private activePluginInstanceId: string | null = null;
  private readonly pluginInstanceIds = new Map<string, string>();
  private readonly pluginDesiredHidden = new Map<string, boolean>();
  private readonly pluginHiddenRetries = new Map<string, number>();
  private readonly pluginHiddenScheduled = new Set<string>();

  // 採用中 snapshot の遷移規則。backend が登録済み companion の解決済み
  // view パス集合から生成した値の写しであり、タグ属性に載せる正本である。
  // 未採用の間は `null` であり、規則欠落時は旧固定値や全面許可へ
  // fallback せず、タグを置かない。静的登録のため backend 生存期間中は不変であり、
  // 改訂進行で既存タグを作り直さない。
  private pluginNavigationRules: readonly string[] | null = null;

  constructor(private readonly rpc: ManagementRpcClient) {
    this.rpc.setProbeHandler(() => this.buildProbe());
    this.rpc.setDevObserveHandler(() => this.buildDevObservation());
    this.rpc.onStateChanged(({ revision, snapshot }) => {
      // push の到達自体を記録する。採用規約で無視される場合も到達は残る。
      this.pushRevision.set(revision);
      this.adopt(snapshot, "stateChanged");
    });
  }

  /** 受信記録へ1行追加する。時刻はこの時点で一度だけ付け、本文・payload は載せない。 */
  private appendLog(message: string): void {
    const entry: EventLogEntry = {
      id: this.nextLogId,
      time: formatLogTime(new Date()),
      message,
    };
    this.nextLogId += 1;
    this.log.update((entries) => [...entries, entry]);
  }

  /** 受信した表示状態を revision 規約で採用し、採用時のみ反映する。 */
  private adopt(incoming: ManagementSnapshot, via: "getSnapshot" | "stateChanged"): void {
    const previous = this.current();
    const next = selectNewer(previous, incoming);
    if (next !== previous) {
      this.current.set(next);
      // 消えた保留の表示用コードは捨てる（再送基盤は作らない）。
      const kept = new Map<string, PairingViewResult>();
      for (const [requestId, view] of this.views()) {
        if (next.pending.some((entry) => entry.requestId === requestId)) {
          kept.set(requestId, view);
        }
      }
      this.views.set(kept);
      // 改訂番号を文書題にも反映する。画面での表示確認用である。
      document.title = `XRift Bridge 管理画面（Angular） — rev ${next.revision}`;
      console.log(`[bridge-gui-ng] 状態を更新した: via=${via} revision=${next.revision}`);
      this.appendLog(`更新 via=${via} revision=${next.revision}`);
      // 実プラグイン子画面の配置は snapshot 由来であり、採用時に合わせる。
      // 遷移規則も採用中 snapshot の値を正本とし、以後のタグ配置に使う。
      // 段0は `spikeList` 由来であり、ここでは触らない。
      this.pluginNavigationRules = [...next.pluginNavigationRules];
      this.reconcilePluginTags(next.pluginMounts);
    } else {
      console.log(`[bridge-gui-ng] 古い状態を無視した: via=${via} incoming=${incoming.revision}`);
      this.appendLog(`無視 via=${via} incoming=${incoming.revision} current=${previous?.revision}`);
    }
  }

  /** 操作後に最新状態を読み直す。履歴・再送基盤は作らない。 */
  private async refresh(via: string): Promise<void> {
    try {
      this.adopt(await this.rpc.getSnapshot(), "getSnapshot");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] ${via}後の再取得に失敗した: ${String(error)}`);
      this.appendLog(`${via}後の再取得に失敗した`);
    }
  }

  /**
   * 重複する操作の二重実行を抑止する。
   *
   * @param key - 操作の識別子（操作名＋対象識別子）。
   * @returns 実行してよい場合に真。実行中なら偽である。
   */
  private beginOperation(key: string): boolean {
    if (this.inflight.has(key)) {
      return false;
    }
    this.inflight.add(key);
    return true;
  }

  /** 操作の実行記録を外す。成功・失敗のいずれでも呼ぶ。 */
  private endOperation(key: string): void {
    this.inflight.delete(key);
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
      spikeTagKept: this.isSpikeTagKept(),
      execMark: readExecMark(),
      hasGetComponent: component.hasGetComponent,
      resolvedComponent: component.resolvedComponent,
      getFailed: component.getFailed,
    });
  }

  /**
   * 固定要素表の1要素を観測する。入力値・本文は読まない。
   *
   * 測定の失敗は不在・非表示として扱い、観測自体は止めない。
   *
   * @param key - 固定要素キー。
   * @param selector - 文書内の Angular 要素の選択子。
   * @returns 許可項目だけの要素観測。
   */
  private readObserveElement(key: string, selector: string): DevObserveElementInput {
    const element = document.querySelector(selector);
    if (element === null) {
      return { key, present: false, visible: false, disabled: false, rect: null };
    }
    let rect: DevObserveElementInput["rect"] = null;
    let visible = false;
    try {
      const box = element.getBoundingClientRect();
      rect = {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
      const style = getComputedStyle(element);
      visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden";
    } catch {
      // 測定不能なら不在に準じて扱う（観測自体は続ける）。
      rect = null;
      visible = false;
    }
    let disabled = false;
    try {
      disabled = element.querySelector(":disabled") !== null;
    } catch {
      // 選択子の評価に失敗しても観測自体は続ける。
      disabled = false;
    }
    return { key, present: true, visible, disabled, rect };
  }

  /**
   * 焦点要素の固定キーを求める。表外・不在なら `null` とする。
   *
   * 要素名・識別子・入力値は返さず、固定表に載るキーだけを返す。
   *
   * @returns 焦点要素の固定キー。表外・不在なら `null`。
   */
  private readActiveKey(): string | null {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return null;
    }
    try {
      for (const target of DEV_OBSERVE_TARGETS) {
        if (active.closest(target.selector) !== null) {
          return target.key;
        }
      }
    } catch {
      // 照合の失敗は表外として扱う。
    }
    return null;
  }

  /**
   * 開発専用の段階観測（DOM 反映）の応答を組み立てる。許可 DTO だけを返す。
   *
   * 要求の改訂番号との照合は呼び出し側（開発接続口）が行い、ここでは
   * 採用中の改訂番号を載せるだけである。RPC 成功を描画完了とは呼ばず、
   * この応答の到達を DOM 反映の観測とする。
   *
   * @returns 固定要素キー・矩形・表示/disabled・焦点だけの観測応答。
   */
  buildDevObservation(): NgDevObserveResult {
    const ng = (globalThis as unknown as Record<string, unknown>)["ng"];
    const component = this.readComponentProbe();
    return buildNgDevObserveResult({
      devMode: isDevMode(),
      hasNg: ng !== undefined,
      componentMounted: document.querySelector("app-root") !== null,
      resolvedComponent: component.resolvedComponent,
      adoptedRevision: this.current()?.revision ?? null,
      focus: document.hasFocus(),
      activeKey: this.readActiveKey(),
      elements: DEV_OBSERVE_TARGETS.map((target) =>
        this.readObserveElement(target.key, target.selector),
      ),
    });
  }

  /** 初回取得し、revision が新しいときだけ採用する。 */
  async fetchInitial(): Promise<void> {
    try {
      this.adopt(await this.rpc.getSnapshot(), "getSnapshot");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 初回取得・表示に失敗した: ${String(error)}`);
      this.appendLog("初回取得に失敗した");
    }
  }

  /** 準備完了を通知する。 */
  notifyReady(): void {
    try {
      this.rpc.notifyViewReady(document.title);
      console.log("[bridge-gui-ng] 準備完了を通知した");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 準備完了の通知に失敗した: ${String(error)}`);
    }
  }

  /** 所有一覧の残存を掃除する。vanilla 再読込み時と同様である。 */
  async resetSpike(via: string): Promise<void> {
    try {
      await this.rpc.resetSpike();
      console.log("[bridge-gui-ng] 子画面の残存を掃除した");
      await this.refreshSpike("子画面の掃除");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の掃除に失敗した: ${via} ${String(error)}`);
    }
  }

  /**
   * 子画面タグの配置先を登録する。入れ物の安定した host 要素を受ける。
   *
   * 登録時に採用中の表示状態・所有一覧と合わせ、以後は採用・読直しで
   * 自動的に足し引きする。host 要素自体は作り替えない。
   *
   * @param spike - 段0スパイク子画面の配置先。
   * @param plugin - 実プラグイン子画面の配置先。
   */
  registerMountHosts(spike: HTMLElement, plugin: HTMLElement): void {
    this.spikeHost = spike;
    this.pluginHost = plugin;
    const current = this.current();
    if (current !== null) {
      // 遅延 host 登録時も採用中 snapshot の規則を使う。
      this.pluginNavigationRules = [...current.pluginNavigationRules];
      this.reconcilePluginTags(current.pluginMounts);
    }
    this.reconcileSpikeTags(this.spikeSummaries());
    this.applyPluginVisibility();
  }

  /** 子画面タグを1つ作る。属性は所有表の発行値だけを載せる。 */
  private buildMountTag(
    kind: "spike" | "plugin",
    mountId: string,
    initialUrl: string,
    navigationRules: string,
  ): HTMLElement {
    const tag = document.createElement("electrobun-webview");
    // 初期 URL は main 発行の DTO をそのまま載せる。任意 URL・HTML・preload は付けない。
    // 属性設定を先に行い、配置（append）の後に属性を変えない。
    tag.setAttribute("src", initialUrl);
    tag.setAttribute("renderer", "native");
    tag.setAttribute("navigation-rules", navigationRules);
    // `sandbox` 属性は付けない（main が照合する）。
    tag.id = `${kind}-${mountId}`;
    return tag;
  }

  /**
   * 段0スパイクの配置用 DTO に従ってタグを一度だけ置く。既存は作り直さない。
   *
   * @param mountId - 所有表が発行したマウント識別子。
   * @param initialUrl - 所有表が発行した初期 URL。
   */
  private placeSpikeTag(mountId: string, initialUrl: string): void {
    if (this.spikeTags.has(mountId) || this.spikeHost === null) {
      return;
    }
    const tag = this.buildMountTag("spike", mountId, initialUrl, SPIKE_NAVIGATION_RULES_ATTRIBUTE);
    this.spikeHost.append(tag);
    this.spikeTags.set(mountId, tag);
  }

  /** 配置中の段0タグを外す。表示の破棄は main の所有表が行う。 */
  private dropSpikeTag(mountId: string): void {
    const tag = this.spikeTags.get(mountId);
    if (tag === undefined) {
      return;
    }
    tag.remove();
    this.spikeTags.delete(mountId);
  }

  /**
   * 段0の所有一覧に合わせてタグを足し引きする。既存は触らない。
   *
   * @param mounts - `spikeList` の結果。
   */
  reconcileSpikeTags(mounts: readonly SpikeMountSummary[]): void {
    const live = new Set(mounts.map((mount) => mount.mountId));
    // 巡回中の削除は当該項目だけであり、仕様上安全である（未訪問の削除は起きない）。
    for (const mountId of this.spikeTags.keys()) {
      if (!live.has(mountId)) {
        this.dropSpikeTag(mountId);
        this.appendLog(`子画面を外した mountId=${mountId}`);
      }
    }
    for (const mount of mounts) {
      if (!this.spikeTags.has(mount.mountId)) {
        this.placeSpikeTag(mount.mountId, mount.initialUrl);
        // host 未登録で置けなかった場合は記録しない（次回の登録・読直しで置く）。
        if (this.spikeTags.has(mount.mountId)) {
          this.appendLog(`子画面を置いた mountId=${mount.mountId}`);
        }
      }
    }
  }

  /**
   * 実プラグインの配置用 DTO に従ってタグを一度だけ置く。既存は作り直さない。
   *
   * 遷移規則は採用中 snapshot の値を載せる。規則欠落時は旧固定値や全面許可へ
   * fallback せず、置かずに次回の採用・登録に任せる。
   *
   * @param mountId - 所有表が発行したマウント識別子。
   * @param initialUrl - 所有表が発行した初期 URL。
   * @param instanceId - 束縛した実インスタンスの識別子。表示対象の判定に使う。
   */
  private placePluginTag(mountId: string, initialUrl: string, instanceId: string): void {
    if (this.pluginTags.has(mountId) || this.pluginHost === null) {
      return;
    }
    const rules = this.pluginNavigationRules;
    if (rules === null) {
      return;
    }
    const tag = this.buildMountTag("plugin", mountId, initialUrl, JSON.stringify(rules));
    this.pluginHost.append(tag);
    this.pluginTags.set(mountId, tag);
    this.pluginInstanceIds.set(mountId, instanceId);
    this.pluginDesiredHidden.set(mountId, this.desiredPluginHidden(mountId));
    this.pluginHiddenRetries.set(mountId, 0);
    this.applyPluginHidden(mountId);
  }

  /** 配置中の実プラグイン用タグを外す。表示の破棄は main の対応付けが行う。 */
  private dropPluginTag(mountId: string): void {
    const tag = this.pluginTags.get(mountId);
    if (tag === undefined) {
      return;
    }
    tag.remove();
    this.pluginTags.delete(mountId);
    this.pluginInstanceIds.delete(mountId);
    this.pluginDesiredHidden.delete(mountId);
    this.pluginHiddenRetries.delete(mountId);
    this.pluginHiddenScheduled.delete(mountId);
  }

  /**
   * 実プラグインの配置一覧に合わせてタグを足し引きする。既存は触らない。
   *
   * @param mounts - snapshot の配置一覧。
   */
  reconcilePluginTags(mounts: readonly PluginUiMountPlacement[]): void {
    const live = new Set(mounts.map((mount) => mount.mountId));
    // 巡回中の削除は当該項目だけであり、仕様上安全である（未訪問の削除は起きない）。
    for (const mountId of this.pluginTags.keys()) {
      if (!live.has(mountId)) {
        this.dropPluginTag(mountId);
        this.appendLog(`実プラグイン子画面を外した mountId=${mountId}`);
      }
    }
    for (const mount of mounts) {
      if (!this.pluginTags.has(mount.mountId)) {
        this.placePluginTag(mount.mountId, mount.initialUrl, mount.instanceId);
        // host 未登録で置けなかった場合は記録しない（次回の登録・採用で置く）。
        if (this.pluginTags.has(mount.mountId)) {
          this.appendLog(`実プラグイン子画面を置いた mountId=${mount.mountId}`);
        }
      }
    }
    this.applyPluginVisibility();
  }

  /**
   * 子画面の表示対象を切り替える。表示切替だけであり、業務 RPC は送らない。
   *
   * 各タグの desired hidden は `!(可視 && そのタグの instanceId === 選択中)`
   * であり、`toggleHidden` で適用する。未初期化のタグは rAF で上限付き
   * 再試行し、desired を保持して初期化後に適用する。
   *
   * @param visible - operations 画面が選択されている場合に真。
   * @param activeInstanceId - 表示対象のインスタンス識別子。無ければ `null`。
   */
  setPluginViewState(visible: boolean, activeInstanceId: string | null): void {
    this.pluginViewVisible = visible;
    this.activePluginInstanceId = activeInstanceId;
    this.applyPluginVisibility();
  }

  /**
   * タグの desired hidden を求める。可視かつ対象個体に一致する場合だけ偽である。
   *
   * @param mountId - 対象のマウント識別子。
   * @returns 隠す場合に真。
   */
  private desiredPluginHidden(mountId: string): boolean {
    if (!this.pluginViewVisible) {
      return true;
    }
    if (this.activePluginInstanceId === null) {
      return true;
    }
    return this.pluginInstanceIds.get(mountId) !== this.activePluginInstanceId;
  }

  /** 全タグの desired を求め直し、変わったものだけ再試行回数を捨てて適用する。 */
  private applyPluginVisibility(): void {
    for (const mountId of this.pluginTags.keys()) {
      const desired = this.desiredPluginHidden(mountId);
      if (this.pluginDesiredHidden.get(mountId) !== desired) {
        this.pluginDesiredHidden.set(mountId, desired);
        this.pluginHiddenRetries.set(mountId, 0);
      }
      this.applyPluginHidden(mountId);
    }
  }

  /**
   * 1つのタグへ desired を適用する。未初期化なら rAF で上限付き再試行する。
   *
   * `toggleHidden` が関数でない要素（happy-dom の未知要素）は no-op とし、
   * タグの再生成・DOM 移動・`src` 再設定はしない。
   *
   * @param mountId - 対象のマウント識別子。
   */
  private applyPluginHidden(mountId: string): void {
    const tag = this.pluginTags.get(mountId);
    if (tag === undefined) {
      return;
    }
    const desired = this.pluginDesiredHidden.get(mountId) ?? this.desiredPluginHidden(mountId);
    this.pluginDesiredHidden.set(mountId, desired);
    const candidate = tag as HTMLElement & PluginVisibilityTag;
    if (typeof candidate.toggleHidden !== "function") {
      return;
    }
    if (typeof candidate.webviewId !== "number") {
      const retries = this.pluginHiddenRetries.get(mountId) ?? 0;
      if (retries >= PLUGIN_HIDDEN_RETRY_LIMIT) {
        this.pluginHiddenScheduled.delete(mountId);
        this.appendLog(`実プラグイン子画面の表示切替を諦めた mountId=${mountId}`);
        return;
      }
      this.pluginHiddenRetries.set(mountId, retries + 1);
      if (this.pluginHiddenScheduled.has(mountId)) {
        return;
      }
      const scheduler = (globalThis as { readonly requestAnimationFrame?: unknown })[
        "requestAnimationFrame"
      ];
      if (typeof scheduler !== "function") {
        this.pluginHiddenScheduled.delete(mountId);
        this.appendLog(`実プラグイン子画面の表示切替を諦めた mountId=${mountId}`);
        return;
      }
      this.pluginHiddenScheduled.add(mountId);
      (scheduler as typeof requestAnimationFrame)(() => {
        this.pluginHiddenScheduled.delete(mountId);
        if (!this.pluginTags.has(mountId)) {
          return;
        }
        this.applyPluginHidden(mountId);
      });
      return;
    }
    this.pluginHiddenScheduled.delete(mountId);
    this.pluginHiddenRetries.set(mountId, 0);
    candidate.toggleHidden(desired);
  }

  /** 所有一覧を読み直し、タグと表示を合わせる。 */
  async refreshSpike(via: string): Promise<void> {
    try {
      const mounts = await this.rpc.listSpikes();
      this.spikeSummaries.set(mounts);
      this.reconcileSpikeTags(mounts);
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の再取得に失敗した: ${via} ${String(error)}`);
    }
  }

  /** 受付を有効化し、採用中の表示状態を返す。 */
  async enableAcceptance(): Promise<void> {
    if (!this.beginOperation("enable-acceptance")) {
      return;
    }
    try {
      await this.rpc.enableAcceptance();
      console.log("[bridge-gui-ng] 受付を有効化した");
      this.appendLog("受付を有効化した");
      await this.refresh("受付の有効化");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 受付の有効化に失敗した: ${String(error)}`);
      this.appendLog("受付の有効化に失敗した");
    } finally {
      this.endOperation("enable-acceptance");
    }
  }

  /** 受付を無効化し、採用中の表示状態を返す。 */
  async disableAcceptance(): Promise<void> {
    if (!this.beginOperation("disable-acceptance")) {
      return;
    }
    try {
      await this.rpc.disableAcceptance();
      console.log("[bridge-gui-ng] 受付を無効化した");
      this.appendLog("受付を無効化した");
      await this.refresh("受付の無効化");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 受付の無効化に失敗した: ${String(error)}`);
      this.appendLog("受付の無効化に失敗した");
    } finally {
      this.endOperation("disable-acceptance");
    }
  }

  /**
   * 選択した保留の比較コードを表示用に取得する。承認はしない。
   *
   * 保留が消えた後に遅延応答が返っても再表示しない。本文はログに残さない。
   *
   * @param requestId - 照合対象の要求識別子。
   */
  async showPairingView(requestId: string): Promise<void> {
    const key = `show-code:${requestId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.getPairingView(requestId);
      // 応答待ちの間に保留が消えたら捨てる（再表示しない）。
      const live = this.current()?.pending.some((entry) => entry.requestId === requestId) ?? false;
      if (!live) {
        console.log(`[bridge-gui-ng] 消滅した保留の表示を破棄した: requestId=${requestId}`);
        this.appendLog(`比較コード表示を破棄した requestId=${requestId}`);
        return;
      }
      const kept = new Map(this.views());
      kept.set(requestId, result);
      this.views.set(kept);
      // 成否の符号だけを残す。本文・表示形はログに載せない。
      if (result.available) {
        console.log(`[bridge-gui-ng] 比較コード表示を取得した: requestId=${requestId}`);
        this.appendLog(`比較コード表示を取得した requestId=${requestId}`);
      } else {
        console.log(
          `[bridge-gui-ng] 比較コード表示を取得できない: requestId=${requestId} reason=${result.reason}`,
        );
        this.appendLog(
          `比較コード表示を取得できない requestId=${requestId} reason=${result.reason}`,
        );
      }
    } catch {
      console.log(`[bridge-gui-ng] 比較コード表示の取得に失敗した: requestId=${requestId}`);
      this.appendLog(`比較コード表示の取得に失敗した requestId=${requestId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /**
   * 保留を比較コード照合で承認する。承認可否は server が決める。
   *
   * 入力コードでの自動承認はしない。明示の操作だけが承認する。
   *
   * @param requestId - 照合対象の要求識別子。
   * @param code - 入力欄の比較コード（整形しない）。
   */
  async approvePairing(requestId: string, code: string): Promise<void> {
    const key = `approve:${requestId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      // 入力コードは送るだけで記録しない。本文はログに載せない。
      const result = await this.rpc.approvePairing(requestId, code);
      console.log(`[bridge-gui-ng] 承認の結果: requestId=${requestId} status=${result.status}`);
      this.appendLog(`承認の結果 requestId=${requestId} status=${result.status}`);
      await this.refresh("承認");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 承認に失敗した: requestId=${requestId} ${String(error)}`);
      this.appendLog(`承認に失敗した requestId=${requestId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /**
   * 保留を取り下げ、対象の接続を終了する。
   *
   * @param requestId - 照合対象の要求識別子。
   */
  async rejectPairing(requestId: string): Promise<void> {
    const key = `reject:${requestId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.rejectPairing(requestId);
      console.log(`[bridge-gui-ng] 取り下げの結果: requestId=${requestId} status=${result.status}`);
      this.appendLog(`取り下げの結果 requestId=${requestId} status=${result.status}`);
      await this.refresh("取り下げ");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 取り下げに失敗した: requestId=${requestId} ${String(error)}`);
      this.appendLog(`取り下げに失敗した requestId=${requestId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /**
   * 指定接続だけを切断する。待ち受けと他接続は維持する。
   *
   * @param connectionId - 切断する接続の識別子。
   */
  async disconnectConnection(connectionId: string): Promise<void> {
    const key = `disconnect:${connectionId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      await this.rpc.disconnectConnection(connectionId);
      console.log(`[bridge-gui-ng] 接続を切断した: connectionId=${connectionId}`);
      this.appendLog(`接続を切断した connectionId=${connectionId}`);
      await this.refresh("切断");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 切断に失敗した: connectionId=${connectionId} ${String(error)}`);
      this.appendLog(`切断に失敗した connectionId=${connectionId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /**
   * 汎用プラグインを割り当てる。
   *
   * @param pluginKind - 割り当てる種別トークン。
   * @param localSessionId - 割り当てる生存セッションのローカル識別子。省略時は方針に従い選ぶ。
   */
  async assignPlugin(pluginKind: string, localSessionId?: string): Promise<void> {
    const key =
      localSessionId === undefined
        ? `assign-plugin:${pluginKind}`
        : `assign-plugin:${pluginKind}:${localSessionId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.assignPlugin(pluginKind, localSessionId);
      console.log(
        `[bridge-gui-ng] プラグインを割り当てた: kind=${result.pluginKind} localSessionId=${result.localSessionId} instanceId=${result.instanceId}`,
      );
      this.appendLog(`プラグインを割り当てた kind=${result.pluginKind}`);
      this.textFailure.set("");
      await this.refresh("プラグイン割当て");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] プラグイン割当てに失敗した: ${String(error)}`);
      this.appendLog("プラグイン割当てに失敗した");
      this.textFailure.set(`操作に失敗した: ${describeActionError(error)}`);
    } finally {
      this.endOperation(key);
    }
  }

  /**
   * 汎用プラグインの割当てを外す。描画した所有記録の三識別子で照合する。
   *
   * `released:false`・issues 非空は「解除成功」と記録しない。
   * クリック後に引き直さず、描画時の識別子を使う。
   *
   * @param instanceId - 描画した所有記録のインスタンス識別子。
   * @param localSessionId - 描画した所有記録のローカル識別子。
   * @param portId - 描画した所有記録の接続口識別子。
   */
  async unassignPlugin(instanceId: string, localSessionId: string, portId: string): Promise<void> {
    const key = `unassign-plugin:${instanceId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.unassignPlugin(instanceId, localSessionId, portId);
      if (!result.released || result.issues.length > 0) {
        console.log(
          `[bridge-gui-ng] プラグイン割当て解除が不完全である: released=${result.released} issues=${result.issues.length}`,
        );
        this.appendLog("プラグイン割当て解除が不完全である");
        this.textFailure.set(
          `解除が不完全である: released=${result.released} issues=${result.issues.length}`,
        );
      } else {
        console.log("[bridge-gui-ng] プラグインの割当てを外した");
        this.appendLog("プラグインの割当てを外した");
        this.textFailure.set("");
      }
      await this.refresh("プラグイン割当て解除");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] プラグイン割当て解除に失敗した: ${String(error)}`);
      this.appendLog("プラグイン割当て解除に失敗した");
      this.textFailure.set(`操作に失敗した: ${describeActionError(error)}`);
    } finally {
      this.endOperation(key);
    }
  }

  /** アプリ終了を要求する。後始末完了後に終了する。 */
  async quit(): Promise<void> {
    if (!this.beginOperation("quit")) {
      return;
    }
    try {
      await this.rpc.quit();
      console.log("[bridge-gui-ng] アプリの終了を要求した");
      this.appendLog("アプリの終了を要求した");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] アプリの終了要求に失敗した: ${String(error)}`);
      this.appendLog("アプリの終了要求に失敗した");
    } finally {
      this.endOperation("quit");
    }
  }

  /**
   * 子画面を1つ作り、所有一覧の読直しでタグを置く。
   *
   * 作った直後の `spikeCreate` の応答だけでは置かず、`spikeList` の結果に
   * 合わせて置く（vanilla の `refreshSpike` と同様）。
   */
  async createSpike(): Promise<void> {
    if (!this.beginOperation("spike-create")) {
      return;
    }
    try {
      const created = await this.rpc.createSpike();
      console.log(`[bridge-gui-ng] 子画面を作った: mountId=${created.mountId}`);
      this.appendLog(`子画面を作った mountId=${created.mountId}`);
      await this.refreshSpike("子画面作成");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の作成に失敗した: ${String(error)}`);
      this.appendLog("子画面の作成に失敗した");
    } finally {
      this.endOperation("spike-create");
    }
  }

  /**
   * 子画面へ push を送り、所有一覧を読み直す。混線の確認用である。
   *
   * @param mountId - 送り先マウントの識別子。
   */
  async pushSpike(mountId: string): Promise<void> {
    const key = `spike-push:${mountId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const pushed = await this.rpc.pushSpike(mountId);
      console.log(`[bridge-gui-ng] 子画面へ送った: mountId=${mountId} revision=${pushed.revision}`);
      this.appendLog(`子画面へ送った mountId=${mountId}`);
      await this.refreshSpike("子画面送信");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面への送信に失敗した: mountId=${mountId} ${String(error)}`);
      this.appendLog(`子画面への送信に失敗した mountId=${mountId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /**
   * 子画面を1つ外し、所有一覧を読み直す。
   *
   * @param mountId - 外す子画面のマウント識別子。
   */
  async destroySpike(mountId: string): Promise<void> {
    const key = `spike-destroy:${mountId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      await this.rpc.destroySpike(mountId);
      console.log(`[bridge-gui-ng] 子画面を外した: mountId=${mountId}`);
      this.appendLog(`子画面を外した mountId=${mountId}`);
      await this.refreshSpike("子画面破棄");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の破棄に失敗した: mountId=${mountId} ${String(error)}`);
      this.appendLog(`子画面の破棄に失敗した mountId=${mountId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /** 子画面を全て外し、所有一覧を読み直す。 */
  async resetSpikes(): Promise<void> {
    if (!this.beginOperation("spike-reset")) {
      return;
    }
    try {
      await this.rpc.resetSpike();
      console.log("[bridge-gui-ng] 子画面を全て外した");
      this.appendLog("子画面を全て外した");
      await this.refreshSpike("子画面全破棄");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の全破棄に失敗した: ${String(error)}`);
      this.appendLog("子画面の全破棄に失敗した");
    } finally {
      this.endOperation("spike-reset");
    }
  }

  /**
   * 実プラグイン子画面の失敗消去と現割当てへの再配置を要求する。
   *
   * 失敗表示を消し、現在の割当てに配置が無いものを作り直す。
   * 既存の配置・割当て・送信には触らない。
   */
  async retryPluginMounts(): Promise<void> {
    if (!this.beginOperation("retry-plugin-mounts")) {
      return;
    }
    try {
      await this.rpc.retryPluginMounts();
      console.log("[bridge-gui-ng] 実プラグイン子画面の再試行を要求した");
      this.appendLog("実プラグイン子画面の再試行を要求した");
      await this.refresh("実プラグイン再試行");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 実プラグイン子画面の再試行に失敗した: ${String(error)}`);
      this.appendLog("実プラグイン子画面の再試行に失敗した");
    } finally {
      this.endOperation("retry-plugin-mounts");
    }
  }

  /** 配置した段0子画面タグが文書に残っているか。同一性保持の確認用である。 */
  isSpikeTagKept(): boolean {
    if (this.spikeTags.size === 0) {
      return false;
    }
    for (const tag of this.spikeTags.values()) {
      if (!document.contains(tag)) {
        return false;
      }
    }
    return true;
  }
}
