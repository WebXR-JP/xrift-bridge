/**
 * 管理画面の表示状態・限定操作の Angular 向け保持者。
 *
 * RPC 送受信は `ManagementRpcClient` に任せ、ここでは signals による表示状態の
 * 採用（`selectNewer`）・初期同期・共通操作処理だけを行う。DTO・操作・採用規約の
 * 再定義はしない。契約型（`ManagementRpc`・`ManagementSnapshot`・`selectNewer`）
 * は `bridge-gui-contract` の公開 subpath から再利用する（循環が無いことを
 * `tsc` で確かめる）。子画面タグの配置は既存の所有表（`spikeCreate` 発行の
 * DTO）とだけ結び付け、実プラグインの対応付けには触らない。
 *
 * 比較コード本文・業務 payload・テキスト本文は signals・ログに残さない。
 * 比較コードの表示用取得結果だけを保留行の一時状態（`pairingViews`）に保持し、
 * 保留が消えたら破棄する。
 */
import { Injectable, isDevMode, signal } from "@angular/core";
import type {
  ManagementSnapshot,
  NgDebugProbeResult,
  PairingViewResult,
} from "bridge-gui-contract/management";
import { selectNewer } from "bridge-gui-contract/management";
import { SPIKE_NAVIGATION_RULES_ATTRIBUTE } from "bridge-gui-contract/plugin-spike";
import { ManagementRpcClient } from "./rpc.ts";
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

/** 操作失敗の説明を作る。本文は含めない（失敗理由だけである）。 */
function describeActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable({ providedIn: "root" })
export class ManagementService {
  private readonly current = signal<ManagementSnapshot | null>(null);

  private readonly pushRevision = signal<number | null>(null);

  // ADR: 比較コードの表示用取得結果は保留行の一時状態であり、snapshot の一部に
  // しない。表示のためだけに保持し、保留が消えたら破棄する（再送基盤は作らない）。
  // signal の値は読取り専用の写しとして公開し、呼び出し側の書換えを受けない。
  private readonly views = signal<ReadonlyMap<string, PairingViewResult>>(new Map());

  // 受信記録（イベントログ）。採用／無視の符号と操作結果の要約だけを載せ、
  // 比較コード本文・payload は載せない。小規模利用前提のため上限は設けない。
  private readonly log = signal<readonly string[]>([]);

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

  /** テキスト操作の失敗表示。空なら失敗は無い。 */
  readonly textError = this.textFailure.asReadonly();

  // ADR: 二重押下での重複送信を避けるため、実行中の操作を識別子で覚える。
  // 汎用 store は作らず、この集合だけを重複抑止に使う。失敗・成功のいずれでも
  // 実行後は外す。
  private readonly inflight = new Set<string>();

  /** 配置した子画面タグ。更新ごとの作り直しはしない。 */
  private spikeTag: HTMLElement | null = null;

  constructor(private readonly rpc: ManagementRpcClient) {
    this.rpc.setProbeHandler(() => this.buildProbe());
    this.rpc.onStateChanged(({ revision, snapshot }) => {
      // push の到達自体を記録する。採用規約で無視される場合も到達は残る。
      this.pushRevision.set(revision);
      this.adopt(snapshot, "stateChanged");
    });
  }

  /** 受信記録へ1行追加する。本文・payload は載せない。 */
  private appendLog(message: string): void {
    this.log.update((entries) => [...entries, message]);
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
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] 子画面の掃除に失敗した: ${via} ${String(error)}`);
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
   * 診断インスタンスを割り当てる。
   *
   * @param localSessionId - 割り当てる生存セッションのローカル識別子。
   */
  async assignDiagnostics(localSessionId: string): Promise<void> {
    const key = `assign:${localSessionId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.assignDiagnostics(localSessionId);
      console.log(
        `[bridge-gui-ng] 診断を割り当てた: localSessionId=${localSessionId} instanceId=${result.instanceId}`,
      );
      this.appendLog(`診断を割り当てた localSessionId=${localSessionId}`);
      await this.refresh("診断割当て");
    } catch {
      console.log(`[bridge-gui-ng] 診断割当てに失敗した: localSessionId=${localSessionId}`);
      this.appendLog(`診断割当てに失敗した localSessionId=${localSessionId}`);
    } finally {
      this.endOperation(key);
    }
  }

  /** 固定テキスト表示を明示割当てする。 */
  async assignText(): Promise<void> {
    if (!this.beginOperation("assign-text")) {
      return;
    }
    try {
      const result = await this.rpc.assignText();
      console.log(
        `[bridge-gui-ng] テキストを割り当てた: localSessionId=${result.localSessionId} instanceId=${result.instanceId}`,
      );
      this.appendLog(`テキストを割り当てた localSessionId=${result.localSessionId}`);
      this.textFailure.set("");
      await this.refresh("テキスト割当て");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] テキスト割当てに失敗した: ${String(error)}`);
      this.appendLog("テキスト割当てに失敗した");
      this.textFailure.set(`操作に失敗した: ${describeActionError(error)}`);
    } finally {
      this.endOperation("assign-text");
    }
  }

  /**
   * 固定テキストを送信する。本文は送信時のみ扱い、記録に残さない。
   *
   * 管理画面のカード操作では使わず、RPC 配線の契約確認用に残す。
   * 本文の入力と送信は子画面が行う。
   *
   * @param localSessionId - 画面が認識している割当て先のローカル識別子。
   * @param instanceId - 画面が認識している割当て先のインスタンス識別子。
   * @param text - 送信する本文。
   */
  async sendText(localSessionId: string, instanceId: string, text: string): Promise<void> {
    const key = `send-text:${localSessionId}`;
    if (!this.beginOperation(key)) {
      return;
    }
    try {
      const result = await this.rpc.sendText(localSessionId, instanceId, text);
      // 決着の符号だけを残す。本文は載せない。
      if (result.status === "acknowledged") {
        this.appendLog("テキスト送信を反映確認した");
      } else {
        this.appendLog(`テキスト送信の結果不明 reason=${result.reason}`);
      }
      this.textFailure.set("");
      await this.refresh("テキスト送信");
    } catch (error: unknown) {
      this.appendLog("テキスト送信に失敗した");
      this.textFailure.set(`操作に失敗した: ${describeActionError(error)}`);
    } finally {
      this.endOperation(key);
    }
  }

  /** 固定テキストの割当てを外す。 */
  async unassignText(): Promise<void> {
    if (!this.beginOperation("unassign-text")) {
      return;
    }
    try {
      await this.rpc.unassignText();
      console.log("[bridge-gui-ng] テキストの割当てを外した");
      this.appendLog("テキストの割当てを外した");
      this.textFailure.set("");
      await this.refresh("テキスト割当て解除");
    } catch (error: unknown) {
      console.log(`[bridge-gui-ng] テキスト割当て解除に失敗した: ${String(error)}`);
      this.appendLog("テキスト割当て解除に失敗した");
      this.textFailure.set(`操作に失敗した: ${describeActionError(error)}`);
    } finally {
      this.endOperation("unassign-text");
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
   * 子画面を1つ作り、配置用 DTO に従ってタグを一度だけ置く。
   *
   * @param host - 配置先の要素。
   */
  async createSpike(host: HTMLElement): Promise<void> {
    try {
      const created = await this.rpc.createSpike();
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
