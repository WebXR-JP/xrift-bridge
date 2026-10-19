/**
 * 管理画面の表示状態・限定操作の Angular 向け保持者。
 *
 * RPC 送受信は `ManagementRpcClient` に任せ、ここでは signals による表示状態の
 * 採用（`selectNewer`）・初期同期・共通操作処理だけを行う。DTO・操作・採用規約の
 * 再定義はしない。契約型（`ManagementRpc`・`ManagementSnapshot`・`selectNewer`）
 * は `bridge-gui-contract` の公開 subpath から再利用する（循環が無いことを
 * `tsc` で確かめる）。子画面タグの配置は所有表の発行する配置用 DTO
 * （snapshot の `pluginMounts`）とだけ結び付け、任意 URL・HTML・preload は付けない。
 *
 * 比較コード本文・業務 payload・テキスト本文は signals・ログに残さない。
 * 比較コードの表示用取得結果だけを保留行の一時状態（`pairingViews`）に保持し、
 * 保留が消えたら破棄する。
 */
import { Injectable, isDevMode, signal } from "@angular/core";
import type {
  LocalMcpStatus,
  ManagementSnapshot,
  NgDebugProbeResult,
  NgDevObserveResult,
  PairingViewResult,
} from "bridge-gui-contract/management";
import { selectNewer } from "bridge-gui-contract/management";
import type {
  PluginUiMountPlacement,
  PluginViewRequest,
  SetPluginViewResult,
} from "bridge-gui-contract/plugin-instance";
import { ManagementRpcClient } from "./rpc.ts";
import { buildNgDebugProbeResult } from "../ng-probe.ts";
import { buildNgDevObserveResult, DEV_OBSERVE_TARGETS } from "../dev-observe.ts";
import type { DevObserveElementInput } from "../dev-observe.ts";
import type { PluginViewState } from "../plugin-view-state.ts";
import { derivePluginViewState } from "../plugin-view-state.ts";

/**
 * 比較コードの取得状態（保留行の表示分岐用）。
 *
 * `ready` は表示できるコードがある場合、`failed` は取得 RPC の失敗または
 * 取得不能（`available:false`）の場合、`fetching` は取得中の場合、
 * `unfetched` は自動取得前の瞬間的な未取得の場合である。未取得と取得中は
 * いずれも「取得しています…」を示す。
 */
export type PairingCodeState = "unfetched" | "fetching" | "failed" | "ready";

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

  /** プラグイン操作の失敗表示。本文は含めない（失敗理由だけである）。 */
  private readonly pluginFailure = signal("");

  // ADR: 初回取得の成否は代替表示の分岐に要るため保持する。snapshot の複製では
  // なく、未取得の間の読込み中と取得失敗の書分けだけに使う。採用後は偽に戻す。
  private readonly initialFailed = signal(false);

  // ADR: 個体限定の再試行の局所状態は二つの集合で持つ。要求中は失敗表示を残し
  // ボタンだけを「再試行中…」で無効化し、要求自体の失敗は元の失敗表示に注記を
  // 足す。snapshot の複製は作らず、対象個体の識別子だけを載せる。本文は載せない。
  private readonly retryPendingIds = signal<readonly string[]>([]);
  private readonly retryFailedIds = signal<readonly string[]>([]);

  // ADR: 比較コードの自動取得の局所状態は二つの集合で持つ。保留 ID ごとに
  // 一度だけ自動取得し、同じ ID の snapshot 更新・画面切替では再取得しない。
  // 取得中は「取得しています…」を示し、RPC 失敗時は再試行付きの失敗表示に
  // 使う。自動リトライループは作らず、再試行は明示操作だけである。
  // snapshot の複製は作らず、対象の要求識別子だけを載せる。本文は載せない。
  private readonly pairingFetchingIds = signal<readonly string[]>([]);
  private readonly pairingFetchFailedIds = signal<readonly string[]>([]);

  // ADR: 製品向け MCP の公開状態の採用は main が所有する単調な改訂番号だけで
  // 行い、push と状態取得・操作応答のすべてで同じ規則を使う。新しい版だけを
  // 採用し、古い版と 同じ版は捨てる。到着順が交差しても大きい版を正とし、
  // 同じ要求の応答の識別には使わない。要求ごとの自前世代で同じ操作の応答を
  // 捨てない。操作の完了・失敗の表示は版の採用とは別に、当該操作の識別で
  // 行う。失敗表示は新しい公開状態の到達では消さず、当該操作の成功でのみ
  // 消す。有効化の成功は応答の成否ではなく採用した状態の内容（有効であること）
  // で決め、開始失敗の状態（無効・開始失敗あり）は失敗として扱う。有効化の成功は操作失敗の表示を消し、停止の完了（未完了でない応答）
  // は停止の未完了・失敗の表示を消す。停止の未完了・操作の失敗は再試行まで
  // 残す。main は状態を公開してから操作応答を返すため、push が先に着くのが
  // 通常であり、先着の push で版が進んでいても当該操作の完了・失敗は反映する。
  private mcpOpSeq = 0;
  private readonly mcpState = signal<LocalMcpStatus | null>(null);
  private readonly mcpError = signal("");
  // ADR: 実行中の操作はボタンに無効として見せるため、操作ごとの実行中旗を
  // signal で持つ。二重押下の抑止（`inflight`）とは別に、描画の判定
  // （`canEnable`・`canDisable`）に使う。応答の成功・失敗・古さによらず
  // 実行終了で戻す。種類の異なる操作（有効化と停止）は互いを止めない。
  private readonly mcpEnablePending = signal(false);
  private readonly mcpDisablePending = signal(false);
  /** 製品向け MCP の公開状態。未取得の間は null である。 */
  readonly localMcpStatus = this.mcpState.asReadonly();
  /** 製品向け MCP の操作の失敗・未完了表示。本文は含めない（理由だけである）。 */
  readonly localMcpError = this.mcpError.asReadonly();
  /** 製品向け MCP の有効化の実行中旗。実行中は有効化ボタンを無効にする。 */
  readonly localMcpEnablePending = this.mcpEnablePending.asReadonly();
  /** 製品向け MCP の停止の実行中旗。実行中は停止ボタンを無効にする。 */
  readonly localMcpDisablePending = this.mcpDisablePending.asReadonly();

  /** 現在採用中の表示状態。未取得の間は null である。 */
  readonly snapshot = this.current.asReadonly();

  /** 最後に受信した `stateChanged` の改訂番号。push 到達の確認用である。 */
  readonly lastPushRevision = this.pushRevision.asReadonly();

  /** 保留行の一時状態（表示用の比較コード取得結果）。消滅後は破棄する。 */
  readonly pairingViews = this.views.asReadonly();

  /** 受信記録。採用／無視と操作結果の要約だけを載せる。 */
  readonly eventLog = this.log.asReadonly();

  /** プラグイン操作の失敗表示。本文は含めない（失敗理由だけである）。 */
  readonly pluginError = this.pluginFailure.asReadonly();

  /** 初回取得に失敗し採用済み snapshot が無い場合に真。 */
  readonly initialFetchFailed = this.initialFailed.asReadonly();

  /** 再試行要求中の対象個体の識別子一覧。 */
  readonly retryPending = this.retryPendingIds.asReadonly();

  /** 再試行要求自体が失敗した対象個体の識別子一覧。 */
  readonly retryRequestFailed = this.retryFailedIds.asReadonly();

  /** 比較コードを取得中の保留の要求識別子一覧。 */
  readonly pairingFetchPending = this.pairingFetchingIds.asReadonly();

  /** 比較コードの取得 RPC に失敗した保留の要求識別子一覧。 */
  readonly pairingFetchFailed = this.pairingFetchFailedIds.asReadonly();

  // ADR: 二重押下での重複送信を避けるため、実行中の操作を識別子で覚える。
  // 汎用 store は作らず、この集合だけを重複抑止に使う。失敗・成功のいずれでも
  // 実行後は外す。
  private readonly inflight = new Set<string>();

  // ADR: 子画面タグは Angular テンプレートで宣言的に描画せず、安定した host
  // 要素へ命令的に追加／削除する。子画面の寿命は表示期間ごとの作り直しであり、
  // 同一表示期間中の管理 snapshot 更新では再生成しない。同一性は mountId 単位の
  // 所有表（snapshot の `pluginMounts`）で保ち、一度置いた要素は作り直さない。
  // 消えた mountId の要素だけを外す。非選択個体のタグを保持して隠す方式は
  // 持たない（表示期間が替われば破棄する）。
  // 配置先の host は入れ物が `registerPluginHost` で渡す（`ViewChild` の要素）。
  private readonly pluginTags = new Map<string, HTMLElement>();
  private pluginHost: HTMLElement | null = null;

  // ADR: 子画面タグの有無がそのまま表示である。HTML の `hidden` 属性・CSS の
  // `display:none`・native の表示切替（`toggleHidden`）による隠し置きはしない。
  // 可視条件は `操作画面が選択中 && 選択個体 && 所有段階 active` であり、
  // 表示要求（`setPluginView`）の送出とタグ配置の両方に使う。切替で業務 RPC は
  // 送らず、選択・生成で送信・UDP 開始・割当て操作を自動実行しない。
  private pluginViewVisible = false;
  private activePluginInstanceId: string | null = null;
  private readonly pluginInstanceIds = new Map<string, string>();

  // ADR: 表示要求の世代は main が所有・採番する採用済み世代であり、Angular は
  // 採番しない（表示意図と観測した基準世代を送り、採用された世代を使う）。
  // 送る基準世代は採用中 snapshot の `pluginView`（`AdoptedPluginView`）から
  // 取り、main が照合する。送出済みの要求を覚え、採用済み一致・同一基準の
  // 送出済みでは送らない。応答の `current` を正とし、stale でも送出済みを
  // 巻き戻さない。表示期間の切替（対象変更・無しへの終了・画面離脱）は
  // 採用の推移で区別し、A→無し→A／A→B→A を「対象が同じ」として省略しない。
  // 古い世代の配置・応答・失敗表示では子を復活させない。
  private lastSentView: PluginViewRequest | null = null;

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
    // 製品向け MCP の公開状態の push は、そのまま採用口へ渡す。新しい改訂番号
    // だけ採用し、同じ版と古い版は捨てる（到着順優先にしない）。
    this.rpc.onLocalMcpChanged((status) => {
      this.adoptLocalMcpStatus(status);
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
      // 採用に成功したため初回取得失敗の表示は消す。
      this.initialFailed.set(false);
      // 消えた保留の表示用コードは捨てる（再送基盤は作らない）。
      const kept = new Map<string, PairingViewResult>();
      for (const [requestId, view] of this.views()) {
        if (next.pending.some((entry) => entry.requestId === requestId)) {
          kept.set(requestId, view);
        }
      }
      this.views.set(kept);
      // 消えた保留の取得失敗表示も捨てる（再送基盤は作らない）。
      const livePending = new Set(next.pending.map((entry) => entry.requestId));
      this.pairingFetchFailedIds.update((ids) => ids.filter((id) => livePending.has(id)));
      // 採用中 snapshot から失敗が消えた個体の再試行要求失敗の注記も消す。
      // 次回再試行の成功まで残すと、別原因の再失敗に古い注記が載る。
      const liveFailures = new Set(next.pluginMountFailures.map((failure) => failure.instanceId));
      this.retryFailedIds.update((ids) => ids.filter((id) => liveFailures.has(id)));
      // 改訂番号を文書題にも反映する。画面での表示確認用である。
      document.title = `XRift Bridge 管理画面（Angular） — rev ${next.revision}`;
      console.log(`[bridge-gui-ng] 状態を更新した: via=${via} revision=${next.revision}`);
      this.appendLog(`更新 via=${via} revision=${next.revision}`);
      // 実プラグイン子画面の配置は snapshot 由来であり、採用時に合わせる。
      // 遷移規則も採用中 snapshot の値を正本とし、以後のタグ配置に使う。
      // 配置・失敗表示は表示要求の世代だけを正とし、古い世代では復活させない。
      this.pluginNavigationRules = [...next.pluginNavigationRules];
      this.reconcilePluginTags(next);
      // 所有段階の進行（`initializing`→`active` 等）で表示対象が変わるため、
      // 採用ごとに表示要求を合わせる。同一表示期間では再送しない。
      void this.syncViewRequest();
      // 新しい保留の比較コードだけを一度だけ自動取得する。同じ ID の
      // snapshot 更新・画面切替では再取得せず、承認 RPC は送らない。
      // 取得済み・取得中・取得失敗済みは飛ばし、自動リトライはしない。
      for (const entry of next.pending) {
        const requestId = entry.requestId;
        if (this.views().has(requestId)) {
          continue;
        }
        if (this.pairingFetchFailedIds().includes(requestId)) {
          continue;
        }
        if (this.pairingFetchingIds().includes(requestId)) {
          continue;
        }
        void this.fetchPairingView(requestId);
      }
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
   * 製品向け MCP の公開状態を改訂番号の規則で採用する。唯一の採用口であり、
   * push と状態取得・操作応答のすべてがここを通る。
   *
   * @param incoming - 受信した公開状態。
   * @returns 採用した場合に真。古い版・同じ版では偽である。
   */
  private adoptLocalMcpStatus(incoming: LocalMcpStatus): boolean {
    const current = this.mcpState();
    if (current === null || incoming.revision > current.revision) {
      this.mcpState.set(incoming);
      return true;
    }
    return false;
  }

  /**
   * 操作の識別子を発行する。有効化・停止の完了・失敗の表示だけに使い、
   * 版の採用には使わない。新しい操作が始まると古い操作の結果は捨てる。
   *
   * @returns 発行した操作識別子。
   */
  private nextMcpOperation(): number {
    this.mcpOpSeq += 1;
    return this.mcpOpSeq;
  }

  /**
   * 当該操作の結果を反映してよいか判定する。新しい操作が始まっていたら偽であり、
   * 古い操作の完了・失敗で表示を上書きしない。
   *
   * @param operation - 開始時に発行した操作識別子。
   * @returns 反映してよい場合に真。
   */
  private isCurrentMcpOperation(operation: number): boolean {
    return operation === this.mcpOpSeq;
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

  /**
   * 選択個体のスロット状態を導出する。代替表示と可視制御で同じ判定を使う。
   *
   * snapshot の複製は作らず、採用中 snapshot と初回取得失敗・局所再試行の
   * 旗だけから都度導出する。
   *
   * @param selectedInstanceId - 選択中のインスタンス識別子。所有が無い間は `null`。
   * @returns スロットの状態。
   */
  pluginViewStateFor(selectedInstanceId: string | null): PluginViewState {
    const current = this.current();
    return derivePluginViewState(current, selectedInstanceId, {
      initialFetchFailed: this.initialFailed(),
      retryPending: this.retryPendingIds().includes(selectedInstanceId ?? ""),
      retryRequestFailed: this.retryFailedIds().includes(selectedInstanceId ?? ""),
    });
  }

  /** 初回取得し、revision が新しいときだけ採用する。 */
  async fetchInitial(): Promise<void> {
    try {
      this.adopt(await this.rpc.getSnapshot(), "getSnapshot");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 初回取得・表示に失敗した: ${String(error)}`);
      this.appendLog("初回取得に失敗した");
      // 採用済みが無い間の失敗だけ代替表示の分岐に使う。
      if (this.current() === null) {
        this.initialFailed.set(true);
      }
    }
  }

  /** 表示状態を読み直す。代替表示の「再読み込み」が使う。 */
  async reloadSnapshot(): Promise<void> {
    await this.fetchInitial();
  }

  /**
   * 子画面タグの配置先を登録する。入れ物の安定した host 要素を受ける。
   *
   * 登録時に採用中の表示状態と合わせ、以後は採用で自動的に足し引きする。
   * host 要素自体は作り替えない。
   *
   * @param plugin - 実プラグイン子画面の配置先。
   */
  registerPluginHost(plugin: HTMLElement): void {
    this.pluginHost = plugin;
    const current = this.current();
    if (current !== null) {
      // 遅延 host 登録時も採用中 snapshot の規則を使う。
      this.pluginNavigationRules = [...current.pluginNavigationRules];
      this.reconcilePluginTags(current);
    }
  }

  /** 子画面タグを1つ作る。属性は所有表の発行値だけを載せる。 */
  private buildMountTag(mountId: string, initialUrl: string, navigationRules: string): HTMLElement {
    const tag = document.createElement("electrobun-webview");
    // 初期 URL は main 発行の DTO をそのまま載せる。任意 URL・HTML・preload は付けない。
    // 属性設定を先に行い、配置（append）の後に属性を変えない。
    tag.setAttribute("src", initialUrl);
    tag.setAttribute("renderer", "native");
    tag.setAttribute("navigation-rules", navigationRules);
    // `sandbox` 属性は付けない（main が照合する）。
    tag.id = `plugin-${mountId}`;
    return tag;
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
    const tag = this.buildMountTag(mountId, initialUrl, JSON.stringify(rules));
    this.pluginHost.append(tag);
    this.pluginTags.set(mountId, tag);
    this.pluginInstanceIds.set(mountId, instanceId);
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
  }

  /**
   * 採用中 snapshot の表示要求の世代に合わせてタグを足し引きする。既存は触らない。
   *
   * 置くのは、表示対象（操作画面の選択中かつ選択個体かつ所有段階 `active`）に
   * 一致し、かつ表示要求の世代に一致する配置だけである。古い世代の配置では
   * 子を復活させない。同一表示期間中の snapshot 更新では再生成しない。
   *
   * @param snapshot - 採用中の表示状態。
   */
  reconcilePluginTags(snapshot: ManagementSnapshot): void {
    const target = this.desiredViewInstance(snapshot);
    const live = new Map<string, PluginUiMountPlacement>();
    if (target !== null && snapshot.pluginView.instanceId === target) {
      for (const mount of snapshot.pluginMounts) {
        if (
          mount.instanceId === target &&
          mount.viewGeneration === snapshot.pluginView.viewGeneration
        ) {
          live.set(mount.mountId, mount);
        }
      }
    }
    // 巡回中の削除は当該項目だけであり、仕様上安全である（未訪問の削除は起きない）。
    for (const mountId of this.pluginTags.keys()) {
      if (!live.has(mountId)) {
        this.dropPluginTag(mountId);
        this.appendLog(`実プラグイン子画面を外した mountId=${mountId}`);
      }
    }
    for (const mount of live.values()) {
      if (!this.pluginTags.has(mount.mountId)) {
        this.placePluginTag(mount.mountId, mount.initialUrl, mount.instanceId);
        // host 未登録で置けなかった場合は記録しない（次回の登録・採用で置く）。
        if (this.pluginTags.has(mount.mountId)) {
          this.appendLog(`実プラグイン子画面を置いた mountId=${mount.mountId}`);
        }
      }
    }
  }

  /**
   * 子画面の表示要求の対象を求める。表示切替だけであり、業務 RPC は送らない。
   *
   * 可視条件は `操作画面が選択中 && 選択個体 && 所有段階 active` である。
   * `ready` は条件にしない。割当てだけでは対象にしない。
   *
   * @param snapshot - 採用中の表示状態。未取得なら表示対象は無い。
   * @returns 表示対象のインスタンス識別子。無ければ `null`。
   */
  private desiredViewInstance(snapshot: ManagementSnapshot | null): string | null {
    if (!this.pluginViewVisible) {
      return null;
    }
    const target = this.activePluginInstanceId;
    if (target === null || snapshot === null) {
      return null;
    }
    const selected = snapshot.plugins.instances.find((item) => item.instanceId === target);
    return selected?.phase === "active" ? target : null;
  }

  /**
   * 子画面の表示対象を切り替え、表示要求を基準世代付きで送る。
   *
   * 操作画面への出入り・個体タブ切替で表示意図が変わるため、採用中 snapshot
   * の基準世代とともに送る（採番は main が行う）。同一表示意図（対象が
   * 変わらない snapshot 更新・再描画・採用済みの追認）では再送しない。
   * 表示終了（別画面・対象無し・非 `active`）では無しを現基準で送り、表示期間
   * を終了する。対象外になったタグは応答待ちせず外す。
   * 選択・生成で送信・UDP 開始・割当て操作を自動実行しない。
   *
   * @param visible - operations 画面が選択されている場合に真。
   * @param activeInstanceId - 表示対象のインスタンス識別子。無ければ `null`。
   */
  async setPluginViewState(visible: boolean, activeInstanceId: string | null): Promise<void> {
    this.pluginViewVisible = visible;
    this.activePluginInstanceId = activeInstanceId;
    // 対象外になったタグは古い世代の配置で復活させず、直ちに外す。
    const desired = this.desiredViewInstance(this.current());
    for (const [mountId, instanceId] of this.pluginInstanceIds) {
      if (instanceId !== desired) {
        this.dropPluginTag(mountId);
        this.appendLog(`実プラグイン子画面を外した mountId=${mountId}`);
      }
    }
    await this.syncViewRequest();
  }

  /**
   * 表示要求の送出を表示意図に合わせる。送る必要がある場合だけ、採用中
   * snapshot の基準世代とともに送る。
   *
   * 送らないのは、採用済みが表示意図と一致する場合（同表示期間の更新・採用後の
   * 追認）と、同一基準で送出済みの場合（応答・採用待ち）である。A→無し→A／
   * A→B→A は採用の推移で差が出るため省略されない。同時多重送出はせず、
   * 送出中の切替は完了時の追随で拾う。同一表示期間の再試行は世代に触れない
   * （再試行は `retryPluginMount` が担う）。送出自体の失敗は送出済みにせず、
   * 次回の表示切替・採用で送り直す（再表示まで永久抑止しない）。
   */
  private async syncViewRequest(): Promise<void> {
    const snapshot = this.current();
    if (snapshot === null) {
      return;
    }
    const desired = this.desiredViewInstance(snapshot);
    const adopted = snapshot.pluginView;
    // 採用済みが表示意図と一致すれば送らない。
    if (adopted.instanceId === desired) {
      return;
    }
    // 同一基準で送出済みなら応答・採用待ちであり重ねて送らない。
    if (
      this.lastSentView !== null &&
      this.lastSentView.instanceId === desired &&
      this.lastSentView.baseViewGeneration === adopted.viewGeneration
    ) {
      return;
    }
    // 二重押下での重複送信を抑える汎用の仕組みで多重送出を抑止する。
    if (!this.beginOperation("set-plugin-view")) {
      return;
    }
    try {
      await this.sendViewRequest(desired, adopted.viewGeneration);
    } finally {
      this.endOperation("set-plugin-view");
      // 送出中に表示意図が変わっていれば直列で追随する。変わっていなければ
      // 送らない。送出の失敗時は次回の表示切替・採用に任せ、ここでは追送しない。
      if (this.desiredViewInstance(this.current()) !== desired) {
        void this.syncViewRequest();
      }
    }
  }

  /**
   * 表示要求を一度送り、応答の `current` を正として送出済みを更新する。
   *
   * `adopted:true` なら採用であり、`adopted:false`（stale）でも送出済みを
   * 巻き戻さない。stale で現在の採用対象が最新の表示意図と異なるときだけ、
   * `current` の世代を基準に一度だけ送り直す（追送の連鎖はしない）。
   * 送出自体の失敗は記録に残し、送出済みにしない。
   *
   * @param desired - 送る表示意図。無し（表示期間の終了）の場合は `null`。
   * @param base - 基準世代。採用中 snapshot の採用済み世代である。
   */
  private async sendViewRequest(desired: string | null, base: number): Promise<void> {
    let result: SetPluginViewResult;
    try {
      result = await this.rpc.setPluginView({ instanceId: desired, baseViewGeneration: base });
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 表示要求に失敗した: ${String(error)}`);
      this.appendLog("表示要求に失敗した");
      return;
    }
    // 送った事実を残す。stale でも巻き戻さない。
    this.lastSentView = { instanceId: desired, baseViewGeneration: base };
    const targetLabel = desired ?? "なし";
    if (result.adopted) {
      console.log(
        `[bridge-gui-ng] 表示要求が採用された instanceId=${targetLabel} generation=${result.current.viewGeneration}`,
      );
      this.appendLog(`表示要求が採用された generation=${result.current.viewGeneration}`);
      return;
    }
    console.log(
      `[bridge-gui-ng] 表示要求が古いため採用されなかった instanceId=${targetLabel} current=${result.current.viewGeneration}`,
    );
    this.appendLog("表示要求が古いため採用されなかった");
    const nowDesired = this.desiredViewInstance(this.current());
    if (result.current.instanceId === nowDesired) {
      // 最新の表示意図は既に採用済み。再送しない。
      return;
    }
    // 最新の表示意図で `current` 世代を基準に一度だけ送り直す。
    // 再送応答が stale でも追送しない（次回の表示切替・採用で合わせる）。
    try {
      const retried = await this.rpc.setPluginView({
        instanceId: nowDesired,
        baseViewGeneration: result.current.viewGeneration,
      });
      this.lastSentView = {
        instanceId: nowDesired,
        baseViewGeneration: result.current.viewGeneration,
      };
      if (retried.adopted) {
        console.log(
          `[bridge-gui-ng] 表示要求の送り直しが採用された generation=${retried.current.viewGeneration}`,
        );
        this.appendLog(
          `表示要求の送り直しが採用された generation=${retried.current.viewGeneration}`,
        );
      } else {
        console.log("[bridge-gui-ng] 表示要求の送り直しも古いため採用されなかった");
        this.appendLog("表示要求の送り直しも古いため採用されなかった");
      }
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 表示要求の送り直しに失敗した: ${String(error)}`);
      this.appendLog("表示要求の送り直しに失敗した");
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
   * 指定した保留の比較コードの取得状態を返す。表示分岐だけに使う。
   *
   * snapshot の複製は作らず、採用中の一時状態（取得結果・取得中・取得失敗）
   * だけから都度導出する。
   *
   * @param requestId - 照合対象の要求識別子。
   * @returns 取得状態。表示できるコードがある場合だけ `ready` である。
   */
  pairingCodeStateFor(requestId: string): PairingCodeState {
    const view = this.views().get(requestId);
    if (view?.available === true) {
      return "ready";
    }
    if (this.pairingFetchingIds().includes(requestId)) {
      return "fetching";
    }
    if (this.pairingFetchFailedIds().includes(requestId) || view !== undefined) {
      return "failed";
    }
    return "unfetched";
  }

  /**
   * 保留の比較コードを表示用に取得する。承認はしない。
   *
   * 採用経路の自動取得と明示の再試行で共有する。実行中の重複取得は抑止し、
   * 遅延応答は応答の要求識別子が取得対象と一致し、かつ現在も保留が生存する
   * 場合だけ表示し、消滅後は破棄する。本文はログに残さない。
   * 承認 RPC は送らない。
   *
   * @param requestId - 照合対象の要求識別子。
   */
  private async fetchPairingView(requestId: string): Promise<void> {
    const key = `pairing-view:${requestId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    // 取得開始時点で保留が無ければ送らない（消滅後の再表示を防ぐ）。
    const aliveBefore =
      this.current()?.pending.some((entry) => entry.requestId === requestId) ?? false;
    if (!aliveBefore) {
      this.endOperation(key);
      return;
    }
    this.pairingFetchingIds.update((ids) => (ids.includes(requestId) ? ids : [...ids, requestId]));
    try {
      const result = await this.rpc.getPairingView(requestId);
      // 応答の要求識別子が取得対象と一致しない場合は破棄する。
      // 応答待ちの間に保留が消えたら捨てる（再表示しない）。
      if (result.available && result.requestId !== requestId) {
        console.log(`[bridge-gui-ng] 別保留の表示を破棄した: requestId=${requestId}`);
        this.appendLog(`比較コード表示を破棄した requestId=${requestId}`);
        return;
      }
      const live = this.current()?.pending.some((entry) => entry.requestId === requestId) ?? false;
      if (!live) {
        console.log(`[bridge-gui-ng] 消滅した保留の表示を破棄した: requestId=${requestId}`);
        this.appendLog(`比較コード表示を破棄した requestId=${requestId}`);
        return;
      }
      const kept = new Map(this.views());
      kept.set(requestId, result);
      this.views.set(kept);
      // 取得できたため失敗表示は消す。自動リトライはしない。
      this.pairingFetchFailedIds.update((ids) => ids.filter((id) => id !== requestId));
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
      // 保留が消えた後の失敗は残さない（行が無いため）。
      const live = this.current()?.pending.some((entry) => entry.requestId === requestId) ?? false;
      if (!live) {
        console.log(`[bridge-gui-ng] 消滅した保留の表示を破棄した: requestId=${requestId}`);
        this.appendLog(`比較コード表示を破棄した requestId=${requestId}`);
        return;
      }
      this.pairingFetchFailedIds.update((ids) =>
        ids.includes(requestId) ? ids : [...ids, requestId],
      );
      console.log(`[bridge-gui-ng] 比較コード表示の取得に失敗した: requestId=${requestId}`);
      this.appendLog(`比較コード表示の取得に失敗した requestId=${requestId}`);
    } finally {
      this.pairingFetchingIds.update((ids) => ids.filter((id) => id !== requestId));
      this.endOperation(key);
    }
  }

  /**
   * 比較コードの取得を明示に再試行する。承認はしない。
   *
   * 自動取得で失敗・取得不能になった場合の再試行だけに使い、自動リトライ
   * ループは作らない。取得中は抑止し、承認 RPC は送らない。
   *
   * @param requestId - 照合対象の要求識別子。
   */
  async retryPairingView(requestId: string): Promise<void> {
    // 再試行中は取得中表示にするため、失敗表示を先に消す。
    // 取得自体の重複抑止は取得処理が行う。
    this.pairingFetchFailedIds.update((ids) => ids.filter((id) => id !== requestId));
    await this.fetchPairingView(requestId);
  }

  /**
   * 保留を要求 ID だけで承認する。承認可否は server が決める。
   *
   * 比較コードの取得とは独立し、取得から承認 RPC は自動で送らない。
   * 明示の操作だけが承認する。承認・取り下げの実行中は対象行の重複送信を
   * 抑止する。本文はログに載せない。
   *
   * @param requestId - 承認対象の要求識別子。
   */
  async approvePairing(requestId: string): Promise<void> {
    const key = `approve:${requestId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.approvePairing(requestId);
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
      this.pluginFailure.set("");
      await this.refresh("プラグイン割当て");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] プラグイン割当てに失敗した: ${String(error)}`);
      this.appendLog("プラグイン割当てに失敗した");
      this.pluginFailure.set(`操作に失敗した: ${describeActionError(error)}`);
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
        this.pluginFailure.set(
          `解除が不完全である: released=${result.released} issues=${result.issues.length}`,
        );
      } else {
        console.log("[bridge-gui-ng] プラグインの割当てを外した");
        this.appendLog("プラグインの割当てを外した");
        this.pluginFailure.set("");
      }
      await this.refresh("プラグイン割当て解除");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] プラグイン割当て解除に失敗した: ${String(error)}`);
      this.appendLog("プラグイン割当て解除に失敗した");
      this.pluginFailure.set(`操作に失敗した: ${describeActionError(error)}`);
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
   * 製品向け MCP の公開状態を取得する。起動時の取得と表示の読直しに使う。
   */
  async fetchLocalMcpStatus(): Promise<void> {
    try {
      const status = await this.rpc.getLocalMcpStatus();
      this.adoptLocalMcpStatus(status);
    } catch {
      // 失敗理由は定型文だけにし、例外内容は載せない。
      console.log("[bridge-gui-ng] 製品向け MCP の状態取得に失敗した");
      this.appendLog("製品向け MCP の状態取得に失敗した");
    }
  }

  /**
   * 製品向け MCP を有効化する（人間の操作用）。待受けを開く／作り直す。
   *
   * 公開状態の URL に有効化直後の接続先が含まれるため、別の取得要求は要らない。
   */
  async enableLocalMcp(): Promise<void> {
    if (!this.beginOperation("enable-local-mcp")) {
      return;
    }
    this.mcpEnablePending.set(true);
    const operation = this.nextMcpOperation();
    try {
      const status = await this.rpc.enableLocalMcp();
      // 版の採用は到着順によらず改訂番号だけで行う。先着の push で進んでいても
      // 同じ版は捨て、新しい版だけ採用する。当該操作の完了表示は版の採否とは
      // 別に、自分の操作の結果として反映する。記録・失敗表示の消去は採用した
      // 状態の内容で決める（有効になったときだけ成功とする）。
      this.adoptLocalMcpStatus(status);
      if (!this.isCurrentMcpOperation(operation)) {
        return;
      }
      if (status.enabled) {
        this.mcpError.set("");
        console.log("[bridge-gui-ng] 製品向け MCP を有効化した");
        this.appendLog("製品向け MCP を有効化した");
        return;
      }
      // 開始失敗は例外ではなく公開状態（無効・開始失敗あり）の正常応答で届く。
      // RPC 成功を理由に成功と記録せず、失敗表示を残す。
      console.log("[bridge-gui-ng] 製品向け MCP の有効化に失敗した");
      this.appendLog("製品向け MCP の有効化に失敗した");
      this.mcpError.set("操作に失敗した。もう一度試すか、起動記録を確認する。");
    } catch {
      if (!this.isCurrentMcpOperation(operation)) {
        return;
      }
      // 失敗理由は定型文だけにし、例外内容は載せない。
      console.log("[bridge-gui-ng] 製品向け MCP の有効化に失敗した");
      this.appendLog("製品向け MCP の有効化に失敗した");
      this.mcpError.set("操作に失敗した。もう一度試すか、起動記録を確認する。");
    } finally {
      this.mcpEnablePending.set(false);
      this.endOperation("enable-local-mcp");
    }
  }

  /**
   * 製品向け MCP を停止する（人間の操作用）。個体の受付を失効し、待受けを止める。
   *
   * 停止は公開状態を返す。解放を確認したあとだけ「停止した」と記録し、
   * 未完了の場合は未完了を示して再試行を促す。版の採用は到着順によらず
   * 改訂番号だけで行い、先着の push で進んでいても当該操作の完了・失敗は
   * 自分の操作の結果として反映する。新しい操作が始まっていたら古い結果は
   * 捨て、新しい方に任せる。
   */
  async disableLocalMcp(): Promise<void> {
    if (!this.beginOperation("disable-local-mcp")) {
      return;
    }
    this.mcpDisablePending.set(true);
    const operation = this.nextMcpOperation();
    try {
      const status = await this.rpc.disableLocalMcp();
      this.adoptLocalMcpStatus(status);
      if (!this.isCurrentMcpOperation(operation)) {
        return;
      }
      if (status.cleanupPending) {
        console.log("[bridge-gui-ng] 製品向け MCP の停止が未完了である");
        this.appendLog("製品向け MCP の停止が未完了である。もう一度停止する。");
        this.mcpError.set("停止が未完了である。もう一度停止する。");
        return;
      }
      this.mcpError.set("");
      console.log("[bridge-gui-ng] 製品向け MCP を停止した");
      this.appendLog("製品向け MCP を停止した");
    } catch {
      if (!this.isCurrentMcpOperation(operation)) {
        return;
      }
      // 失敗理由は定型文だけにし、例外内容は載せない。
      console.log("[bridge-gui-ng] 製品向け MCP の停止に失敗した");
      this.appendLog("製品向け MCP の停止に失敗した");
      this.mcpError.set("操作に失敗した。もう一度試すか、起動記録を確認する。");
    } finally {
      this.mcpDisablePending.set(false);
      this.endOperation("disable-local-mcp");
    }
  }

  /**
   * 対象個体の実プラグイン子画面の失敗消去と再配置を要求する。
   *
   * 指定した実インスタンスの失敗表示だけを消し、その個体が現割当てに
   * あれば配置を作り直す。他個体の失敗・既存の配置・割当て・送信には
   * 触らない。同一表示期間の再試行は世代を維持し、表示要求は送り直さない。
   * 応答は受付であり plugin の応答を保証しない。
   *
   * @param instanceId - 再試行する対象のインスタンス識別子。
   */
  async retryPluginMount(instanceId: string): Promise<void> {
    const key = `retry-plugin-mount:${instanceId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    this.retryPendingIds.update((ids) => (ids.includes(instanceId) ? ids : [...ids, instanceId]));
    try {
      await this.rpc.retryPluginMount(instanceId);
      console.log(`[bridge-gui-ng] 実プラグイン子画面の再試行を要求した instanceId=${instanceId}`);
      this.appendLog("実プラグイン子画面の再試行を要求した");
      // 要求自体の失敗注記は消し、以後は snapshot の成否に任せる。
      this.retryFailedIds.update((ids) => ids.filter((id) => id !== instanceId));
      await this.refresh("実プラグイン再試行");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 実プラグイン子画面の再試行に失敗した: ${String(error)}`);
      this.appendLog("実プラグイン子画面の再試行に失敗した");
      this.retryFailedIds.update((ids) => (ids.includes(instanceId) ? ids : [...ids, instanceId]));
    } finally {
      this.retryPendingIds.update((ids) => ids.filter((id) => id !== instanceId));
      this.endOperation(key);
    }
  }
}
