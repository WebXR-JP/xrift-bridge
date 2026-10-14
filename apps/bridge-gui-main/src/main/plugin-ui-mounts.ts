/**
 * 実プラグイン子画面と実インスタンスの対応付け・配置・回収。
 *
 * backend の現割当てを読み、マウント識別子ごとに所有する。Electrobun の
 * SDK 呼び出しは持たない。生成・破棄・結線の実体は `src/main/instance-rpc.ts`
 * の適合層が `BrowserView` に結び付け、ここでは対応付けと照合・退役だけを担う。
 * 単体検証は偽の子画面・偽チャネル・偽 backend で行える。
 *
 * 現割当ての要望読み・子画面 URL・限定射影への到達は backend ごとに生成した
 * 登録表（`plugin-companions.ts`）の記述子に委譲し、ここに種別分岐を持たない。
 * 新しい companion の追加は登録だけで行い、この層の分岐追加は要らない。
 *
 * 対応付けの方針は以下である。
 * - 配置は backend の現割当てへの追随だけが作る。子からの識別子指定は
 *   受け付けず、main が束縛した個体の現割当てだけを使う。
 * - マウント識別子は単調な連番で発行し、破棄後も使い回さない。
 * - タグ生成の照合は main が発行した初期 URL の完全一致で行い、
 *   画面の申告（任意 URL・HTML・preload）は受け付けない。
 * - 破棄は対応付けの削除（unbind）と表示の破棄で行い、DOM 削除だけに
 *   依存しない。初期化前 DOM 削除でも native 生成が止まらない場合に備え、
 *   退役集合・遅延生成回収で残存を残さない。
 * - 失敗はそのマウントに局所化する。生成・読込み・初期 RPC の失敗と
 *   生成待ち・準備完了待ちの期限超過は対応付けを回収して失敗表示に回し、
 *   インスタンスや Session を自動解除せず、送信も自動再実行しない。再生成は明示の
 *   再試行だけが行う。
 * - 全工程は同期的であり、event loop 上で直列化される。
 *   退役と遅延生成のどちらが先でも残存を残さない。
 *
 * @packageDocumentation
 */
import type {
  PluginUiMountFailure,
  PluginUiMountKind,
  PluginUiMountPhase,
  PluginUiMountPlacement,
} from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginViewUrl,
  parsePluginMountId,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";
import { PluginInstanceBinder } from "./plugin-instances.ts";
import type { CompanionRequestEnv } from "bridge-gui-plugin-sdk/companion";
import type { PluginCompanionRegistry } from "./plugin-companions.ts";

/**
 * 子画面配置の対応付けが読む backend の最小口。
 *
 * 外部変化の通知だけを型で求める。現割当て・個体別射影への到達は
 * companion が factory で capture した限定口で行い、backend 経由では
 * 扱わない。管理 snapshot 全体・他個体の情報・候補一覧・保留情報は返さない。
 */
export interface PluginUiBindingBackend {
  /**
   * 外部状態（子画面配置など）の変化を状態通知に載せる。
   *
   * 配置の有無自体は snapshot に含めず、通知予約だけを行う。
   */
  notifyExternalChange(): void;
}

/**
 * SDK 非依存の子画面ハンドル。実体は適合層が `BrowserView` に結び付ける。
 *
 * 読み取りは生成時の照合専用であり、画面側が後から書き換える口はない。
 */
export interface PluginUiChildView {
  /** native 側の表示識別子。 */
  readonly viewId: number;
  /** 親 Webview の識別子。タグ生成元と照合する。 */
  readonly hostWebviewId: number | undefined;
  /** 描画方式。`native` のみ受け付ける。 */
  readonly renderer: string;
  /** 隔離指定の有無。付けた生成は受け付けない。 */
  readonly sandbox: boolean;
  /** preload 指定。付けた生成は受け付けない。 */
  readonly preload: string | null;
  /** 作成時の遷移規則。記録用に読む。 */
  readonly navigationRules: string | null;
  /** 生成時の URL。発行済み初期 URL と完全一致で照合する。 */
  readonly currentUrl: string | null;
  /**
   * 個体別 RPC の結線後に子画面を読み込む。
   *
   * @param url - main の静的登録表から作った子画面 URL。
   */
  loadPluginUrl(url: string): void;
  /** 対応付けからの破棄。冪等であること。 */
  removeView(): void;
}

/** 当該マウントの push 口。結線済みの対応付けだけに送る。 */
export interface PluginUiChannel {
  /**
   * 状態 push を送る。
   *
   * @param message - 送り先の改訂番号と snapshot。本文は含めない。
   */
  push(message: unknown): void;
}

/**
 * 個体別チャネルを作る。SDK 依存の実体は適合層が差し込む。
 *
 * @param view - 照合済みの子画面ハンドル。
 * @param mountId - 結び付けるマウント識別子。
 * @param kind - 束縛する個体の種別トークン。登録済みであること。
 * @param hooks - main 側の汎用口。
 * @returns 当該マウント専用の push 口。
 */
export type PluginUiChannelFactory = (
  view: PluginUiChildView,
  mountId: string,
  kind: string,
  hooks: CompanionRequestEnv,
) => PluginUiChannel;

/** 生成待ちの走査間隔（ミリ秒）。期限超過の回収用である。 */
const SWEEP_INTERVAL_MS = 2_000;

/** 対応付けの1行。 */
interface PluginUiMountRecord {
  /** 再利用しないマウント識別子。 */
  readonly mountId: string;
  /** 束縛する個体の種別トークン。登録表の companion を指す。 */
  readonly kind: PluginUiMountKind;
  /** 発行した初期 URL。生成照合の鍵である。 */
  readonly initialUrl: string;
  /** 結線後に読み込む子画面 URL。 */
  readonly viewUrl: string;
  /** 束縛した実インスタンスの識別子。 */
  readonly instanceId: string;
  /** 現割当ての生存セッションのローカル識別子。 */
  readonly localSessionId: string;
  /** 束縛した接続口の識別子。 */
  readonly portId: string;
  /** 結線段階。 */
  phase: PluginUiMountPhase;
  /** 結線済みの子画面。未結線なら `null`。 */
  view: PluginUiChildView | null;
  /** 初期状態取得を受けた場合に真。 */
  ready: boolean;
  /** 配置を受け付けた時刻（単調時計ではない）。生成待ち・準備完了待ちの期限用である。 */
  createdAt: number;
}

/**
 * 失敗の理由文を作る。識別子・本文は含めない。
 *
 * @param error - 失敗の原因。
 * @returns 表示用の短い理由。
 */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 実プラグイン子画面と実インスタンスの対応付け。所有表の操作はすべて同期で
 * あり、backend の射影呼び出し自体も同期的である（送信の解決は約束で返す）。
 *
 * 子画面が呼べる要求は汎用の `readSnapshot`・`send`・`markReady` だけであり、
 * 種別トークンは companion が決め打ちで渡す。受付・保留・承認・接続断・
 * 割当て等の管理操作は持たない。
 */
export class PluginUiCoordinator implements CompanionRequestEnv {
  private readonly binder: PluginInstanceBinder;
  private sequence = 0;
  private readonly mounts = new Map<string, PluginUiMountRecord>();
  /** 破棄済みの識別子。遅延生成の回収と使い回し防止に使う。 */
  private readonly retired = new Set<string>();
  /** 失敗表示の一覧。局所化した失敗だけを持ち、本文は含めない。 */
  private readonly failures: PluginUiMountFailure[] = [];
  /** 失敗した実インスタンスの識別子。明示の再試行まで再配置しない。 */
  private readonly failedInstances = new Set<string>();
  /** 生成待ち・準備完了待ちの走査タイマー。待ちが無ければ `null`。 */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /**
   * @param parentWebviewId - 管理画面 Webview の識別子。親の照合に使う。
   * @param backend - 外部変化の通知口。
   * @param createChannel - 個体別チャネルの工場。SDK 依存はここに閉じる。
   * @param now - 時刻取得。生成待ち・準備完了待ちの期限用であり、試験で差し替える。
   * @param registry - 種別トークンから記述子を引く登録表。backend ごとに生成して渡す。
   */
  constructor(
    private readonly parentWebviewId: number,
    private readonly backend: PluginUiBindingBackend,
    private readonly createChannel: PluginUiChannelFactory,
    private readonly now: () => number = Date.now,
    private readonly registry: PluginCompanionRegistry,
  ) {
    this.binder = new PluginInstanceBinder({ isLive: (mountId) => this.isLive(mountId) }, registry);
  }

  /** 対応付け中の件数。記録用である。 */
  get size(): number {
    return this.mounts.size;
  }

  /** 失敗表示の件数。記録用である。 */
  get failureCount(): number {
    return this.failures.length;
  }

  /**
   * 子画面が結線済みで利用できるか。
   *
   * @param mountId - 照合するマウント識別子。
   * @returns 結線済みで所有中なら真。
   */
  isLive(mountId: string): boolean {
    const record = this.mounts.get(mountId);
    return record !== undefined && record.phase === "bound";
  }

  /**
   * 現割当てへ対応付けを追随させる。
   *
   * 終了した割当ての対応付けを回収し、新しい現割当てに配置を作り、
   * 生成待ち・準備完了待ちの期限超過を失敗表示に回す。変化があれば backend の
   * 共有時計へ通知を予約する。backend の取得失敗では何も変えない。
   * 要望読みに失敗した種別は不明として扱い、その種別の既存対応付けの
   * 解放も新規配置も行わない（不明と終了を区別する）。
   *
   * @returns 対応付け・失敗表示を変えた場合に真。
   */
  syncNow(): boolean {
    if (this.disposed) {
      return false;
    }
    let changed = false;
    const read = this.readDesired();
    if (read === null) {
      return false;
    }
    const { desired, failedKinds } = read;
    for (const record of this.mounts.values()) {
      // ADR: 走査中の削除は当該の1行だけであり、`Map` の反復は壊さない。
      // 取得に失敗した種別は要望不明であり、割当て終了とみなさない。
      if (failedKinds.has(record.kind)) {
        continue;
      }
      const want = desired.get(record.instanceId);
      if (
        want === undefined ||
        want.localSessionId !== record.localSessionId ||
        want.kind !== record.kind
      ) {
        this.releaseMount(record, "割当て終了");
        changed = true;
      } else {
        desired.delete(record.instanceId);
      }
    }
    const nowMs = this.now();
    // ADR: 走査中の削除は当該の1行だけであり、`Map` の反復は壊さない。
    // 予約の追加は走査後に行い、反復中の追加はしない。
    // ADR: 期限は配置からの総予算とし、生成待ちと準備完了待ちで分けない。
    // タグ生成自体に時間を要した配置は子画面側も含めて不調とみなし、
    // 黙って採用待ちに残さず失敗表示に回す。
    for (const record of this.mounts.values()) {
      if (record.phase === "pending" && nowMs - record.createdAt > PLUGIN_PENDING_TIMEOUT_MS) {
        this.failMount(
          record,
          "子画面の生成待ちが期限切れになった。管理画面の配置を確認すること。",
        );
        changed = true;
      } else if (
        record.phase === "bound" &&
        !record.ready &&
        nowMs - record.createdAt > PLUGIN_PENDING_TIMEOUT_MS
      ) {
        this.failMount(
          record,
          "子画面の初期化が時間内に完了しませんでした。ウィンドウが操作対象になっていないと初期化が進まない場合があります。このウィンドウをクリックしてから「再試行」を押してください。",
        );
        changed = true;
      }
    }
    for (const want of desired.values()) {
      // 失敗した実インスタンスは明示の再試行まで再配置しない。
      // 同一識別子の使い回しは無く、新規割当ては新しい識別子で来る。
      if (this.failedInstances.has(want.instanceId)) {
        continue;
      }
      // ADR: 要望読みに失敗した種別は要望不明であり、新規配置も行わない。
      // 失敗種別は要望に載らないため通常は到達しないが、終了との区別を
      // 解放側と対称に保つ。
      if (failedKinds.has(want.kind)) {
        continue;
      }
      this.createPending(want);
      changed = true;
    }
    if (changed) {
      this.backend.notifyExternalChange();
    }
    this.maintainSweepTimer();
    return changed;
  }

  /**
   * タグ生成を照合し、当該マウントの個体別チャネルを結線する。
   *
   * `BrowserView.on("created")` から呼ぶ。親 Webview・初期 URL・
   * 生成条件（native・sandbox 無し・preload 無し）を照合し、
   * 個体別 RPC を結線してから子画面を読み込む。照合に失敗した生成は
   * 回収する。退役済み・重複・由来不明の遅延生成もここで回収する。
   * タグ方式の二重生成はしない（native 生成はタグ内部）。
   *
   * @param view - 生成された子画面ハンドル。
   * @returns 消費（結線・回収）した場合に真。親違い・他名前空間なら偽。
   */
  handleTagCreated(view: PluginUiChildView): boolean {
    if (this.disposed) {
      return false;
    }
    // 親の照合。他者の所有物には触らず無視する。
    if (view.hostWebviewId !== this.parentWebviewId) {
      return false;
    }
    const url = view.currentUrl;
    let target: PluginUiMountRecord | undefined;
    for (const record of this.mounts.values()) {
      // 照合は発行済み初期 URL の完全一致である。画面の申告は読まない。
      if (record.phase === "pending" && record.initialUrl === url) {
        target = record;
        break;
      }
    }
    if (target === undefined) {
      return this.reclaimOrphan(view);
    }
    this.bind(target, view);
    return true;
  }

  /**
   * 結線済みの対応付けへ最新状態を送る。
   *
   * 失効した対応付けは失敗表示に回して回収し、走査を止めない。
   * 送信の解決待ちは作らず、購読・タイマーを残さない。
   */
  pushBound(): void {
    if (this.disposed) {
      return;
    }
    // ADR: 走査中の削除は当該の1行だけであり、`Map` の反復は壊さない。
    // 送り先の種別は対応付けの記録から記述子を引く。種別分岐は持たない。
    for (const record of this.mounts.values()) {
      if (record.phase !== "bound") {
        continue;
      }
      try {
        this.binder.push(record.mountId);
      } catch (error: unknown) {
        this.failMount(record, `状態の送信に失敗したため回収した: ${describeFailure(error)}`);
      }
    }
  }

  /**
   * 束縛個体の限定表示を改訂番号付きで読む。読み取りは改訂を進めない。
   * 種別ごとの射影は登録表の記述子に委譲し、ここに種別分岐を持たない。
   *
   * 現割当てが失効していれば対応付けを回収し、失敗表示に回す。
   *
   * @param kind - companion の種別トークン。対応付けの記録と照合する。
   * @param mountId - 照合済みのマウント識別子。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合。
   */
  readSnapshot(kind: string, mountId: string): unknown {
    try {
      return this.binder.readSnapshot(kind, mountId);
    } catch (error: unknown) {
      this.reclaimStaleOnRequest(mountId, error, this.labelOf(kind));
      throw error;
    }
  }

  /**
   * 束縛個体の操作へ委譲する。子からの割当て識別子の指定は受け付けず、
   * main が束縛した個体の現割当てに委譲する。
   *
   * 送信の検証失敗では対応付けを回収しない（入力の問題であり、
   * 結線の失効ではない）。失効は状態取得と送信 push の経路で回収する。
   *
   * @param kind - companion の種別トークン。対応付けの記録と照合する。
   * @param mountId - 照合済みのマウント識別子。
   * @param params - 操作の引数。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合（同期的）。
   */
  send(kind: string, mountId: string, params: unknown): Promise<unknown> {
    return this.binder.send(kind, mountId, params);
  }

  /** 配置中の対応付け一覧を返す。表示用である。 */
  listPlacements(): PluginUiMountPlacement[] {
    const revisions = new Map(
      this.binder.listBindings().map((binding) => [binding.mountId, binding.revision] as const),
    );
    return [...this.mounts.values()].map((record) => ({
      mountId: record.mountId,
      kind: record.kind,
      initialUrl: record.initialUrl,
      phase: record.phase,
      ready: record.ready,
      revision: revisions.get(record.mountId) ?? 0,
      instanceId: record.instanceId,
      localSessionId: record.localSessionId,
      portId: record.portId,
    }));
  }

  /** 失敗表示の一覧を返す。表示用である。 */
  listFailures(): PluginUiMountFailure[] {
    return [...this.failures];
  }

  /**
   * 失敗表示を消し、現割当てへ再配置する（個体限定）。
   *
   * 指定した実インスタンスの失敗記録だけを消し、その個体が現割当てに
   * あれば配置を作り直す。他個体の失敗・既存の配置・割当て・送信には
   * 触らない。対象が現所有・失敗のいずれにも無い場合は作用なしとする。
   * 再配置の成否は後続の状態通知で受け取る（受付であり準備完了を保証しない）。
   *
   * @param instanceId - 再試行する実インスタンスの識別子。
   * @returns 受付応答。
   */
  retryFailed(instanceId: unknown): { ok: true } {
    if (this.disposed) {
      return { ok: true };
    }
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      return { ok: true };
    }
    const target = instanceId;
    for (let index = this.failures.length - 1; index >= 0; index -= 1) {
      if (this.failures[index]?.instanceId === target) {
        this.failures.splice(index, 1);
      }
    }
    this.failedInstances.delete(target);
    console.log("[bridge-gui] 実プラグイン子画面の再試行を受け付けた");
    this.syncNow();
    return { ok: true };
  }

  /**
   * 全対応付けを破棄する。管理画面の再読込み掃除と終了処理に使う。
   *
   * 対応付けの削除（unbind）と表示の破棄を行い、購読・タイマー・タグ・
   * BrowserView を残さない。識別子の連番は巻き戻さず、使い回しを避ける。
   * 失敗表示も消し、次回の配置は現割当てから作り直す。
   *
   * @param reason - 記録用の理由（表示名のみ）。
   */
  resetAll(reason: string): { ok: true } {
    const ids = [...this.mounts.keys()];
    for (const id of ids) {
      const record = this.mounts.get(id);
      if (record === undefined) {
        continue;
      }
      const view = record.view;
      this.retireRecord(record);
      this.binder.unbindMount(id);
      this.removeSilently(view);
    }
    this.failures.length = 0;
    this.failedInstances.clear();
    this.stopSweepTimer();
    console.log(
      `[bridge-gui] 実プラグイン子画面を全て外した: reason=${reason} count=${ids.length}`,
    );
    return { ok: true };
  }

  /** 後始末。対応付け・失敗表示・走査タイマーを残さない。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resetAll("破棄");
  }

  /**
   * 現割当ての要望一覧を読む。backend の取得失敗では `null` とし、
   * 対応付けを変えない。
   *
   * 要望は登録済み companion から集め、種別分岐を持たない。取得に失敗した
   * companion はその種別だけ置き、他に波及させない。失敗した種別は集合で
   * 返し、呼び出し側はその種別の解放・新規作成の対象外にする（不明と
   * 終了を区別する）。全種別で失敗した場合は `null` とし、何も変えない。
   *
   * @returns 要望の写像と取得に失敗した種別の集合。何も読めなければ `null`。
   */
  private readDesired(): {
    desired: Map<
      string,
      { kind: PluginUiMountKind; instanceId: string; localSessionId: string; portId: string }
    >;
    failedKinds: Set<string>;
  } | null {
    const desired = new Map<
      string,
      { kind: PluginUiMountKind; instanceId: string; localSessionId: string; portId: string }
    >();
    const failedKinds = new Set<string>();
    let listed = false;
    for (const companion of this.registry.list()) {
      let bindings: Array<{ instanceId: string; localSessionId: string; portId: string }>;
      try {
        bindings = companion.listDesired();
      } catch {
        // 取得の失敗はその種別だけ置き、対応付けの整理を止めない。
        // 呼び出し側がこの種別を対象外にするため、ここで記録する。
        failedKinds.add(companion.kind);
        continue;
      }
      listed = true;
      for (const binding of bindings) {
        if (!desired.has(binding.instanceId)) {
          desired.set(binding.instanceId, { kind: companion.kind, ...binding });
        }
      }
    }
    if (!listed) {
      return null;
    }
    return { desired, failedKinds };
  }

  /**
   * 現割当てに配置を作る。識別子は単調な連番で発行し、使い回さない。
   * 子画面 URL は登録表の解決済み view パスから汎用の組み立てで作り、
   * 種別分岐を持たない。
   *
   * @param want - 配置する現割当ての要望。
   */
  private createPending(want: {
    kind: PluginUiMountKind;
    instanceId: string;
    localSessionId: string;
    portId: string;
  }): void {
    // ADR: 識別子の単調性を `sequence` の破棄をしないことで保つ。
    // `resetAll`・`dispose` でも巻き戻さず、古い割当てとの混線を避ける。
    this.sequence += 1;
    const mountId = `plugin-${want.kind}-${this.sequence}`;
    // 要望は登録表の記述子から作るため、記述子は必ずある。
    // 無ければ実装の不備であり、黙って配置を作らない。到達不能の前提であり、
    // 束縛側の拒否（`requireCompanion`）と例外の種類を揃える。
    const companion = this.registry.get(want.kind);
    if (companion === undefined) {
      throw new RangeError(`未登録の種別への配置である: ${want.kind}`);
    }
    const initialUrl = buildPluginBlankUrl(mountId);
    const viewUrl = buildPluginViewUrl(companion.viewPath, mountId);
    this.mounts.set(mountId, {
      mountId,
      kind: want.kind,
      initialUrl,
      viewUrl,
      instanceId: want.instanceId,
      localSessionId: want.localSessionId,
      portId: want.portId,
      phase: "pending",
      view: null,
      ready: false,
      createdAt: this.now(),
    });
    console.log(
      `[bridge-gui] 実プラグイン子画面の配置を受け付けた: mountId=${mountId} instanceId=${want.instanceId}`,
    );
  }

  /**
   * 配置待ちの1行を結線する。生成条件の照合後に個体別 RPC を結線し、
   * 子画面を読み込む。画面から任意 URL・HTML・preload は受け付けない。
   * タグ方式の二重生成はしない（native 生成はタグ内部）。
   *
   * @param record - 結線する配置待ちの記録。
   * @param view - 生成された子画面ハンドル。
   */
  private bind(record: PluginUiMountRecord, view: PluginUiChildView): void {
    record.view = view;
    if (view.renderer !== "native" || view.sandbox || view.preload !== null) {
      this.failMount(
        record,
        "子画面の生成条件に合わない（native・非sandbox・preload無しであること）。",
      );
      return;
    }
    let channel: PluginUiChannel;
    try {
      channel = this.createChannel(view, record.mountId, record.kind, this);
    } catch (error: unknown) {
      this.failMount(record, `子画面の結線に失敗した: ${describeFailure(error)}`);
      return;
    }
    record.phase = "bound";
    try {
      this.binder.bindMount(record.mountId, record.kind, record.instanceId);
      this.binder.setSink(record.mountId, record.kind, (message: unknown) => {
        channel.push(message);
      });
    } catch (error: unknown) {
      this.failMount(record, `個体の束縛に失敗した: ${describeFailure(error)}`);
      return;
    }
    try {
      // 結線の後に子画面を読み込む。初期 URL は静的登録表から選ぶ。
      view.loadPluginUrl(record.viewUrl);
    } catch (error: unknown) {
      this.failMount(record, `子画面の読込みに失敗した: ${describeFailure(error)}`);
      return;
    }
    console.log(
      `[bridge-gui] 実プラグイン子画面を結線した: mountId=${record.mountId} viewId=${view.viewId}`,
    );
    this.backend.notifyExternalChange();
  }

  /**
   * 対応付けに結び付かない生成を回収する。
   *
   * 初期化完了前の DOM 削除が native 生成を止めない SDK 挙動があるため、
   * 退役済み・重複の遅延生成は main が回収する。他名前空間の生成と
   * 未登録種別・由来不明の生成には触らず、`false` を返して呼び出し側が処理する。
   *
   * @param view - 生成された子画面ハンドル。
   * @returns 回収した場合に真。他名前空間・未登録種別なら偽。
   */
  private reclaimOrphan(view: PluginUiChildView): boolean {
    const claimed = parsePluginMountId(view.currentUrl);
    if (claimed === null) {
      return false;
    }
    if (this.retired.has(claimed)) {
      console.log(
        `[bridge-gui] 失効済みマウントの遅延生成を回収した: mountId=${claimed} viewId=${view.viewId}`,
      );
    } else if (this.mounts.has(claimed)) {
      console.log(`[bridge-gui] 重複する生成を回収した: mountId=${claimed} viewId=${view.viewId}`);
    } else {
      console.log(`[bridge-gui] 由来不明の生成を呼び出し側へ返した: viewId=${view.viewId}`);
      return false;
    }
    this.removeSilently(view);
    return true;
  }

  /**
   * 初期取得の失敗で失効した対応付けを回収する。
   *
   * 入力検証などの失敗（`RangeError` 以外）では回収しない。
   * 対応付けが既に無い場合は何もしない。
   *
   * @param mountId - 要求対象のマウント識別子。
   * @param error - 要求処理の失敗。
   * @param label - 記録用の種別名（表示名のみ）。
   */
  private reclaimStaleOnRequest(mountId: string, error: unknown, label: string): void {
    if (!(error instanceof RangeError)) {
      return;
    }
    const record = this.mounts.get(mountId);
    if (record === undefined) {
      return;
    }
    this.failMount(record, `${label}の初期取得に失敗したため回収した。割当てを確認すること。`);
  }

  /** 失敗表示用の種別名を引く。未登録なら種別トークン自体を使う。 */
  private labelOf(kind: string): string {
    return this.registry.get(kind)?.label ?? kind;
  }

  /** 初期状態取得を受けた記録。変化があれば通知を予約する。 */
  markReady(mountId: string): void {
    const record = this.mounts.get(mountId);
    if (record === undefined || record.ready) {
      return;
    }
    record.ready = true;
    console.log(`[bridge-gui] 実プラグイン子画面の準備ができた: mountId=${mountId}`);
    this.backend.notifyExternalChange();
  }

  /**
   * 終了した割当ての対応付けを外す。失敗表示には回さない。
   *
   * @param record - 外す対応付けの記録。
   * @param reason - 記録用の理由（表示名のみ）。
   */
  private releaseMount(record: PluginUiMountRecord, reason: string): void {
    const view = record.view;
    this.retireRecord(record);
    this.binder.unbindMount(record.mountId);
    this.removeSilently(view);
    console.log(
      `[bridge-gui] 実プラグイン子画面を外した: mountId=${record.mountId} reason=${reason}`,
    );
  }

  /**
   * 失敗した対応付けを回収し、失敗表示に回す。
   *
   * インスタンスや Session を自動解除せず、送信も自動再実行しない。
   * 同一実インスタンスの再配置は明示の再試行まで行わない。
   *
   * @param record - 回収する対応付けの記録。
   * @param reason - 人間向けの短い理由。
   */
  private failMount(record: PluginUiMountRecord, reason: string): void {
    const view = record.view;
    this.retireRecord(record);
    this.binder.unbindMount(record.mountId);
    this.removeSilently(view);
    this.failures.push({
      kind: record.kind,
      reason,
      instanceId: record.instanceId,
      localSessionId: record.localSessionId,
    });
    this.failedInstances.add(record.instanceId);
    console.log(
      `[bridge-gui] 実プラグイン子画面を回収した: mountId=${record.mountId} reason=${reason}`,
    );
    this.backend.notifyExternalChange();
    this.maintainSweepTimer();
  }

  /** 所有表から外し、退役に回す。購読の参照もここで離す。 */
  private retireRecord(record: PluginUiMountRecord): void {
    this.mounts.delete(record.mountId);
    this.retired.add(record.mountId);
    record.view = null;
  }

  /** 表示の破棄。失敗しても所有表の整理を止めない。 */
  private removeSilently(view: PluginUiChildView | null): void {
    if (view === null) {
      return;
    }
    try {
      view.removeView();
    } catch {
      // 破棄の失敗は記録の整理を止めない。
    }
  }

  /**
   * 生成待ち・準備完了待ちの走査タイマーを保つ。待ちがある間だけ動かし、
   * 無ければ止める。終了・破棄では残さない。
   */
  private maintainSweepTimer(): void {
    const needsSweep = [...this.mounts.values()].some(
      (record) => record.phase === "pending" || (record.phase === "bound" && !record.ready),
    );
    if (this.disposed || !needsSweep) {
      this.stopSweepTimer();
      return;
    }
    if (this.sweepTimer !== null) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.syncNow();
    }, SWEEP_INTERVAL_MS);
    // ADR: 待機の維持には使わず、単独滞留での固着を避けるために
    // 外せる場合だけ外す。無い環境では何もしない。
    const timer = this.sweepTimer as unknown as { unref?: () => void };
    try {
      timer.unref?.();
    } catch {
      // 解除の失敗は走査を止めない。
    }
  }

  /** 生成待ち・準備完了待ちの走査タイマーを止める。 */
  private stopSweepTimer(): void {
    const timer = this.sweepTimer;
    this.sweepTimer = null;
    if (timer === null) {
      return;
    }
    clearInterval(timer);
  }
}
