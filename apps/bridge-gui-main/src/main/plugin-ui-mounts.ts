/**
 * 実プラグイン子画面の表示要求駆動の対応付け・配置・回収。
 *
 * Angular の表示要求 `setPluginView`（`{instanceId|null, baseViewGeneration}`）が
 * 「操作画面が選択中かつ対象個体が選択中かつ所有段階 active」を満たすときに
 * 選ばれた一個体の子を新規 mountId で生成し、個体切替で旧子破棄・新子生成、
 * 無し要求・画面遷移で破棄する。再表示は新 mountId・新世代で行う。同一表示
 * 期間中の管理 snapshot 更新では再生成しない。古い世代の要求・応答・配置で
 * 子を復活させない。選択・生成で送信・UDP 開始・割当て操作を自動実行しない。
 * 表示対象と世代の SSoT は backend の `pluginView` であり、ここでは採用済み
 * の値だけを読み、世代の採番は行わない。
 *
 * 子 WebView とプラグイン本体は起動時の静的登録で決めた不透明な RPC でだけ
 * 通信する。main は中継だけを担い、要求・通知の中身を解釈しない。中継の共通形は
 * 子→プラグイン `{method, params}`、プラグイン→子 `{event, payload}` である。
 * 応答 `PluginRelayResult` の正常値・業務エラーは不透明値として扱う。
 * 各マウントの接続は独立とし、文字列で配送先を選ぶ共有 dispatcher は作らない。
 *
 * 通知経路はプラグイン本体の変更通知 → endpoint が表示用 DTO を作り
 * `emission.emit` → main は同一マウント生存時のみ子へ `emitted` で素通しする。
 * main にキュー・再配信・最新状態キャッシュを置かない。
 *
 * 破棄手順はマウント失効（要求・emit の到達停止）→ endpoint dispose（購読・
 * タイマー・参照解放）→ native WebView とタグ回収 → 遅延生成実体の回収の順に
 * 行う。既存の退役識別子・遅延生成回収は維持する。子の破棄でプラグイン本体・
 * Session・UDP ソケットを終了しない。旧子への応答を新子へ付け替えず自動再送も
 * しない。失効・インスタンス削除・Session 終了時は表示中の子も破棄する。
 *
 * 期限は配置受付から最初の正常な plugin 応答までの総予算
 * `PLUGIN_PENDING_TIMEOUT_MS` である。要求到達だけでは判定しない。最初の正常
 * 応答で配置の `pluginResponded=true` とする。期限超過は回収して失敗表示に回し
 * 自動で作り直さない（明示 `retryPluginMount` に委ねる）。子→main の専用
 * ready・ping・状態取得 RPC は作らない。
 *
 * 失効は main 自身の照合（マウントの束縛個体・所有段階・現割当ての一致）で
 * 決める。プラグインが投げた `RangeError` を失効と解釈する方式は持たない。
 * 業務エラーはプラグインの結果（不透明値）として扱う。
 *
 * 安全境界として子の payload の instanceId・kind 等で配送先を変えない。接続に
 * 閉じ込めたマウントから束縛個体を引く。初期 URL 完全一致＋親 Webview 一致で
 * 生成照合する。静的 manifest・`views://`・navigationRules 許可、native・非
 * sandbox・preload なし・同梱限定、生 Session・BridgeServer・管理 backend の
 * 非受渡しを維持する。未知 method・params の検証は endpoint が行い、main は
 * 外形（`isRelayRequestShape`・`isRelayEventShape`）だけ見る。
 *
 * Electrobun の SDK 呼び出しは持たない。生成・破棄・結線の実体は
 * `src/main/instance-rpc.ts` の適合層が `BrowserView` に結び付け、ここでは
 * 対応付けと照合・退役だけを担う。単体検証は偽の子画面・偽チャネル・偽 backend・
 * 偽 manager で行える。
 *
 * @packageDocumentation
 */
import type {
  AdoptedPluginView,
  PluginRelayEvent,
  PluginRelayResult,
  PluginUiMountFailure,
  PluginUiMountKind,
  PluginUiMountPhase,
  PluginUiMountPlacement,
} from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
  buildPluginViewUrl,
  isRelayEventShape,
  isRelayRequestShape,
  parsePluginMountId,
  PLUGIN_PENDING_TIMEOUT_MS,
} from "bridge-gui-contract/plugin-instance";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { PluginCompanionRegistry } from "./plugin-companions.ts";
import type { PluginInstanceManager } from "./plugin-instance-manager.ts";

/**
 * 子画面配置の対応付けが読む backend の最小口。
 *
 * 外部変化の通知だけを型で求める。配置の有無自体は snapshot に含めず、
 * 通知予約だけを行う。
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
 * 現在の採用済み表示対象と世代を読む口。backend が所有する `pluginView` を正とする。
 */
export type PluginViewSource = () => AdoptedPluginView;

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
  // ADR: Electrobun の型宣言は `string | null` だが、実行時の実体は
  // `string[]` 配列である（preload の `getInitialNavigationRules()` が属性の
  // JSON 文字列を `JSON.parse` して配列のまま `webviewTagInit` へ渡し、
  // `BrowserView.navigationRules` に配列として保持されるため）。実機表現に
  // 合わせて `unknown` で受け、照合は `matchPluginNavigationRules` で行う。
  readonly navigationRules: unknown;
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

/**
 * 中継要求の処理口。当該マウントに閉じ込めた endpoint への不透明中継だけを
 * 行い、文字列で配送先を選ばない。
 */
export type PluginRelayHandler = (request: unknown) => Promise<PluginRelayResult>;

/** 当該マウントの push 口。結線済みの対応付けだけに送る。 */
export interface PluginUiChannel {
  /**
   * 通知を送る。
   *
   * @param event - プラグイン本体から子への通知の共通形。
   */
  push(event: PluginRelayEvent): void;
}

/**
 * 個体別チャネルを作る。SDK 依存の実体は適合層が差し込む。
 *
 * @param view - 照合済みの子画面ハンドル。
 * @param mountId - 結び付けるマウント識別子。
 * @param onRelay - 当該マウントに閉じ込めた中継処理。
 * @returns 当該マウント専用の push 口。
 */
export type PluginUiChannelFactory = (
  view: PluginUiChildView,
  mountId: string,
  onRelay: PluginRelayHandler,
) => PluginUiChannel;

/** 生成待ちの走査間隔（ミリ秒）。期限超過の回収用である。 */
const SWEEP_INTERVAL_MS = 2_000;

/** 対応付けの1行。表示期間（mountId・世代）に紐付く。 */
interface PluginUiMountRecord {
  /** 再利用しないマウント識別子。 */
  readonly mountId: string;
  /** 束縛する個体の種別トークン。登録表の行を指す。 */
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
  /** 表示期間を識別する世代。表示要求の世代を写す。 */
  readonly viewGeneration: number;
  /** 結線段階。 */
  phase: PluginUiMountPhase;
  /** 結線済みの子画面。未結線なら `null`。 */
  view: PluginUiChildView | null;
  /** 当該マウントの push 口。未結線なら `null`。 */
  channel: PluginUiChannel | null;
  /** 束縛個体用の endpoint。未生成なら `null`。 */
  endpoint: PluginEndpoint | null;
  /** endpoint が終了したら真。以後の要求・emit の到達を止める。 */
  endpointClosed: boolean;
  /** 最初の正常な plugin 応答を受けたら真。 */
  pluginResponded: boolean;
  /** 初回中継要求の到達を記録したら真（期限判定には使わない）。 */
  relaySeen: boolean;
  /** 配置を受け付けた時刻。期限の起点である。 */
  createdAt: number;
}

/**
 * 子タグの遷移規則が期待規則と一致するか判定する。
 *
 * 期待値は backend と同じ静的登録済み view パス集合から作り、子の属性や
 * 申告からは作らない。実行時の実表現は `string[]` 配列であり（Electrobun の
 * 型宣言 `string | null` と食い違う。preload が属性の JSON 文字列を
 * `JSON.parse` して配列のまま渡すため）、`webviewTagSetNavigationRules`
 * 経由の JSON 文字列形も互換として受け付ける。比較は文字列配列の順序付き
 * 完全一致であり、集合比較・ソート比較にしない（規則は後勝ちのため順序が
 * 意味を持つ）。要素前後の空白差だけは許す。追加・欠落・並替え・要素の
 * 非文字列・欠落・不正 JSON は不一致とする。
 *
 * @param actual - 子タグの遷移規則。実表現は `string[]` 配列であり、
 * JSON 文字列形も受け付ける。欠けている場合は `null`。
 * @param expected - 静的登録から作った期待規則。
 * @returns 順序付き完全一致の場合に真。
 */
export function matchPluginNavigationRules(actual: unknown, expected: readonly string[]): boolean {
  let rules: readonly unknown[];
  if (Array.isArray(actual)) {
    rules = actual;
  } else if (typeof actual === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(actual) as unknown;
    } catch {
      return false;
    }
    if (!Array.isArray(parsed)) {
      return false;
    }
    rules = parsed;
  } else {
    return false;
  }
  if (rules.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const item = rules[index];
    const want = expected[index];
    if (typeof item !== "string" || want === undefined || item.trim() !== want.trim()) {
      return false;
    }
  }
  return true;
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
 * 実プラグイン子画面の表示要求駆動の対応付け。所有表の操作はすべて同期であり、
 * endpoint の要求処理だけが約束を返す。
 *
 * 配置は表示要求への追随だけが作る。子からの識別子指定は受け付けず、main が
 * 束縛した個体の現割当てだけを使う。失効の判定は main 自身の照合で行い、
 * プラグインの投げた例外では決めない。
 */
export class PluginUiCoordinator {
  private sequence = 0;
  private readonly mounts = new Map<string, PluginUiMountRecord>();
  /** 破棄済みの識別子。遅延生成の回収と使い回し防止に使う。 */
  private readonly retired = new Set<string>();
  /**
   * 失敗表示の一覧。局所化した失敗だけを持ち、本文は含めない。
   *
   * 世代進行時に旧世代分を剪定し、個体ごとに最新のみ保つ。`resetAll`
   * 以外で増え続けない。
   */
  private readonly failures: PluginUiMountFailure[] = [];
  /** 期限走査タイマー。待ちが無ければ `null`。 */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /**
   * @param parentWebviewId - 管理画面 Webview の識別子。親の照合に使う。
   * @param backend - 外部変化の通知口。
   * @param createChannel - 個体別チャネルの工場。SDK 依存はここに閉じる。
   * @param now - 時刻取得。期限用であり、試験で差し替える。
   * @param registry - 種別トークンから行を引く登録表。backend が生成した表を渡す。
   * @param manager - 個体の所有表。束縛の照合・参照口の生成に使う。
   * @param viewSource - 現在の表示要求を読む口。backend の `pluginView` を正とする。
   */
  constructor(
    private readonly parentWebviewId: number,
    private readonly backend: PluginUiBindingBackend,
    private readonly createChannel: PluginUiChannelFactory,
    private readonly now: () => number = Date.now,
    private readonly registry: PluginCompanionRegistry,
    private readonly manager: PluginInstanceManager,
    private readonly viewSource: PluginViewSource,
  ) {}

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
    return (
      record !== undefined &&
      record.phase === "bound" &&
      !record.endpointClosed &&
      record.endpoint !== null
    );
  }

  /**
   * 表示要求・失効・期限へ対応付けを追随させる。
   *
   * 表示要求の世代が進んだ場合は旧子を破棄して新子を生成し、同一表示期間の
   * snapshot 更新では再生成しない。束縛が失効した対応付けは破棄する。期限超過は
   * 失敗表示に回す。変化があれば backend へ通知を予約する。
   *
   * @returns 対応付け・失敗表示を変えた場合に真。
   */
  syncNow(): boolean {
    if (this.disposed) {
      return false;
    }
    let changed = false;
    if (this.reconcileView()) {
      changed = true;
    }
    if (this.reclaimInvalidated()) {
      changed = true;
    }
    if (this.sweepExpired()) {
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
   * 当該マウントの中継要求を処理する。適合層の `relay` から呼ぶ。
   *
   * 接続に閉じ込めたマウントから束縛個体を引き、payload の内容では配送先を
   * 変えない。外形だけを見て内容検査はしない。最初の正常応答で
   * `pluginResponded` を立てる。子からの初回要求到達とは区別して記録する。
   * 非同期完了時は同一マウント・endpoint・束縛の生存を再照合し、失効後は
   * 正常値を返さず `pluginResponded` も更新しない。
   *
   * @param mountId - 接続に閉じ込めたマウント識別子。
   * @param request - 受信した中継要求の未知値。
   * @returns 中継結果。不透明な値または中継自体の失敗である。
   */
  async handleRelay(mountId: string, request: unknown): Promise<PluginRelayResult> {
    const record = this.mounts.get(mountId);
    if (record === undefined || record.phase !== "bound") {
      return {
        ok: false,
        error: { code: "unmounted", message: "対応付けの無いマウントである。" },
      };
    }
    if (record.endpointClosed || record.endpoint === null) {
      return {
        ok: false,
        error: { code: "endpoint-closed", message: "終了済みの endpoint である。" },
      };
    }
    if (!isRelayRequestShape(request)) {
      return {
        ok: false,
        error: { code: "bad-envelope", message: "中継要求の外形が不正である。" },
      };
    }
    // 束縛失効は main 自身の照合で決める。プラグインの投げた例外では決めない。
    try {
      this.manager.requireBinding(record.kind, record.instanceId);
    } catch {
      return {
        ok: false,
        error: { code: "unmounted", message: "束縛が失効した。" },
      };
    }
    if (!record.relaySeen) {
      record.relaySeen = true;
      console.log(`[bridge-gui] 実プラグイン子画面の初回中継要求が到達した: mountId=${mountId}`);
    }
    const endpoint = record.endpoint;
    let value: unknown;
    try {
      value = await endpoint.handleRequest({ method: request.method, params: request.params });
    } catch (error: unknown) {
      // 投げた例外は想定外の失敗として中継失敗に落とす。完了前に失効して
      // いれば `unmounted`、それ以外は `endpoint-closed` とする。
      // 業務エラーは投げず値に載せる規約であり、ここには来ない想定である。
      if (this.mounts.get(mountId) !== record || record.endpointClosed) {
        return {
          ok: false,
          error: { code: "unmounted", message: "完了前に対応付けが失効した。" },
        };
      }
      try {
        this.manager.requireBinding(record.kind, record.instanceId);
      } catch {
        return {
          ok: false,
          error: { code: "unmounted", message: "束縛が失効した。" },
        };
      }
      console.log(
        `[bridge-gui] 実プラグイン子画面の中継が想定外に失敗した: mountId=${mountId} reason=${describeFailure(error)}`,
      );
      return {
        ok: false,
        error: { code: "endpoint-closed", message: "endpoint が要求を処理できない。" },
      };
    }
    // 非同期完了時の生存再照合。同一マウント・endpoint・束縛が生きている
    // 場合だけ正常値を返す。失効後は正常値を返さず、`pluginResponded` も
    // 更新しない。新子へ届かないことだけに依存しない。
    if (
      this.mounts.get(mountId) !== record ||
      record.endpointClosed ||
      record.endpoint !== endpoint
    ) {
      return {
        ok: false,
        error: { code: "unmounted", message: "完了前に対応付けが失効した。" },
      };
    }
    try {
      this.manager.requireBinding(record.kind, record.instanceId);
    } catch {
      return {
        ok: false,
        error: { code: "unmounted", message: "束縛が失効した。" },
      };
    }
    if (!record.pluginResponded) {
      record.pluginResponded = true;
      console.log(`[bridge-gui] 実プラグイン子画面の最初の正常応答を受けた: mountId=${mountId}`);
      this.backend.notifyExternalChange();
    }
    // 応答値は不透明であり、記録に残さない。
    return { ok: true, value };
  }

  /** 配置中の対応付け一覧を返す。表示用である。 */
  listPlacements(): PluginUiMountPlacement[] {
    return [...this.mounts.values()].map((record) => ({
      mountId: record.mountId,
      kind: record.kind,
      initialUrl: record.initialUrl,
      phase: record.phase,
      viewGeneration: record.viewGeneration,
      pluginResponded: record.pluginResponded,
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
   * 失敗表示を消し、現表示要求へ再配置する（個体限定）。
   *
   * 指定した実インスタンスの失敗記録を全世代分消し、その個体が現表示要求の
   * 対象で現割当てにあれば配置を作り直す。他個体の失敗・既存の配置・割当て・
   * 送信には触らない。対象が現所有・失敗のいずれにも無い場合は作用なしと
   * する。同一表示期間の再試行は世代を維持する。受付であり準備完了を保証
   * しない。世代進行時に旧世代分は剪定済みのため、実質は現表示期間の抑止
   * 解除である。`instanceId: null` の特定不能な失敗は帰属不明のため消さず、
   * `resetAll` でのみ消える。
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
    console.log("[bridge-gui] 実プラグイン子画面の再試行を受け付けた");
    this.syncNow();
    return { ok: true };
  }

  /**
   * 全対応付けを破棄する。管理画面の遷移掃除と終了処理に使う。
   *
   * マウント失効・endpoint 終了・表示破棄を行い、購読・タイマー・タグ・
   * BrowserView を残さない。識別子の連番は巻き戻さず、使い回しを避ける。
   * 失敗表示も消し、次回の配置は表示要求から作り直す。子の破棄でプラグイン
   * 本体・Session・UDP ソケットは終了しない。
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
      this.invalidateMount(record);
    }
    this.failures.length = 0;
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
   * 表示要求への追随。世代の進行で旧子破棄・新子生成し、無し要求で破棄する。
   * 同一表示期間の snapshot 更新では再生成しない。
   *
   * 失敗抑止は表示期間（世代＋対象）単位であり、同一表示期間の失敗表示が
   * あれば自動再生成しない。世代が進めば新しい表示期間として一度生成する。
   * 失敗表示そのものが抑止であり、別の履歴を持たない。
   *
   * @returns 対応付けを変えた場合に真。
   */
  private reconcileView(): boolean {
    let view: AdoptedPluginView;
    try {
      view = this.viewSource();
    } catch {
      // 表示要求が読めない場合は現状維持を優先する。
      return false;
    }
    const current = [...this.mounts.values()][0];
    if (view.instanceId === null) {
      if (current === undefined) {
        return false;
      }
      this.releaseMount(current, "表示要求の終了");
      return true;
    }
    if (
      current !== undefined &&
      current.instanceId === view.instanceId &&
      current.viewGeneration === view.viewGeneration
    ) {
      return false;
    }
    // 世代・対象のいずれかが替わった。旧子を破棄して新子を生成する。
    // 古い世代の配置で子を復活させない。
    let changed = false;
    if (current !== undefined) {
      // 同一世代の対象替えは到達しない想定だが、旧子を残さない。
      this.releaseMount(current, "表示対象の切替え");
      changed = true;
    }
    // 新しい表示期間の採用時に、同一個体の旧世代の失敗表示を剪定する。
    // 旧世代の失敗を残すと、成功表示の後もタブ警告が残り続け、失敗表示が
    // 世代ごとに増える。剪定により失敗表示は個体ごとに最新のみとなる。
    if (this.pruneSupersededFailures(view.instanceId, view.viewGeneration)) {
      changed = true;
    }
    // 失敗した表示期間は明示の再試行まで再配置しない。
    // 同一識別子の使い回しは無く、新規割当ては新しい識別子で来る。
    // 対応付けの変化は無いため偽を返す（失敗表示への回収が変化である）。
    if (this.isSuppressed(view.viewGeneration, view.instanceId)) {
      return changed;
    }
    // 対象個体が選択中で所有段階 active かつ現割当て一致の場合だけ生成する。
    // 割当てだけでは作らず、表示要求があるときの一個体に限定する。
    let binding: { kind: string; instanceId: string; localSessionId: string; portId: string };
    try {
      binding = this.resolveTargetBinding(view.instanceId);
    } catch {
      // 対象が所有外・失効・現割当て不一致の場合は作らない。失敗表示にも回さない。
      // 対応付けの変化は旧子の破棄だけである。
      return changed;
    }
    this.createPending(binding, view.viewGeneration);
    return true;
  }

  /**
   * 指定した表示期間が失敗抑止の対象か判定する。
   *
   * 同一表示期間（世代＋対象）の失敗表示があれば自動再生成しない。世代が
   * 進んだ新しい表示期間は抑止しない。失敗表示そのものが抑止であり、
   * 別の履歴を持たない。`instanceId: null` の分岐は型上あり得る場合の
   * 安全側の扱いであり、特定不能の失敗は当該世代の全個体を抑止する。
   * 現行経路で `null` は入らない（`failMount` は常に対象の識別子を入れる）。
   *
   * @param viewGeneration - 判定する表示期間の世代。
   * @param instanceId - 判定する実インスタンスの識別子。
   * @returns 同一表示期間の失敗表示がある場合に真。
   */
  private isSuppressed(viewGeneration: number, instanceId: string): boolean {
    return this.failures.some(
      (failure) =>
        failure.viewGeneration === viewGeneration &&
        (failure.instanceId === null || failure.instanceId === instanceId),
    );
  }

  /**
   * 同一個体の旧世代の失敗表示を剪定する。
   *
   * 新しい表示期間の採用時に呼び、現世代と異なる世代の失敗表示を消す。
   * 同世代の失敗表示は残し、抑止（`isSuppressed`）の判定を保つ。世代が
   * 特定できない失敗（`viewGeneration: null`）は比較ができないため残し、
   * `resetAll` でのみ消える。現行経路で `null` は入らない（`failMount` は
   * 常に対象の世代を入れる）。
   *
   * @param instanceId - 新しい表示期間の対象個体の識別子。
   * @param viewGeneration - 新しい表示期間の世代。
   * @returns 失敗表示を減らした場合に真。
   */
  private pruneSupersededFailures(instanceId: string, viewGeneration: number): boolean {
    let removed = false;
    for (let index = this.failures.length - 1; index >= 0; index -= 1) {
      const failure = this.failures[index];
      if (
        failure?.instanceId === instanceId &&
        failure.viewGeneration !== null &&
        failure.viewGeneration !== viewGeneration
      ) {
        this.failures.splice(index, 1);
        removed = true;
      }
    }
    return removed;
  }

  /**
   * 表示要求の対象個体の束縛を解決する。所有中・確定済み・現割当て一致で
   * なければ拒否する。
   *
   * @param instanceId - 表示要求の対象個体識別子。
   * @returns 生成に使う束縛情報。
   * @throws `RangeError` — 所有外・失効・現割当て不一致の場合。
   */
  private resolveTargetBinding(instanceId: string): {
    kind: string;
    instanceId: string;
    localSessionId: string;
    portId: string;
  } {
    const owned = this.manager.listOwned().find((record) => record.instanceId === instanceId);
    if (owned === undefined) {
      throw new RangeError("所有していない個体である。");
    }
    if (owned.phase !== "active") {
      throw new RangeError("確定済みの個体ではない。");
    }
    // 現割当て一致の確認は `requireBinding` が行う。失効していれば拒否する。
    const binding = this.manager.requireBinding(owned.kind, instanceId);
    return {
      kind: binding.kind,
      instanceId: binding.instanceId,
      localSessionId: binding.localSessionId,
      portId: binding.portId,
    };
  }

  /**
   * 束縛が失効した対応付けを破棄する。失効・インスタンス削除・Session 終了時は
   * 表示中の子も破棄する。子の破棄でプラグイン本体・Session は終了しない。
   *
   * @returns 対応付けを変えた場合に真。
   */
  private reclaimInvalidated(): boolean {
    let changed = false;
    // ADR: 走査中の削除は当該の1行だけであり、`Map` の反復は壊さない。
    for (const record of this.mounts.values()) {
      try {
        this.manager.requireBinding(record.kind, record.instanceId);
      } catch {
        this.releaseMount(record, "束縛の失効");
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 期限超過を失敗表示に回す。配置受付から最初の正常な plugin 応答までの
   * 総予算であり、要求到達だけでは判定しない。
   *
   * @returns 対応付け・失敗表示を変えた場合に真。
   */
  private sweepExpired(): boolean {
    let changed = false;
    const nowMs = this.now();
    // ADR: 走査中の削除は当該の1行だけであり、`Map` の反復は壊さない。
    // ADR: 期限は配置からの総予算とし、生成待ちと応答待ちで分けない。
    for (const record of this.mounts.values()) {
      if (!record.pluginResponded && nowMs - record.createdAt > PLUGIN_PENDING_TIMEOUT_MS) {
        this.failMount(
          record,
          "子画面の初期化が時間内に完了しませんでした。このウィンドウをクリックしてから「再試行」を押してください。",
        );
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 現割当てに配置を作る。識別子は単調な連番で発行し、使い回さない。
   * 子画面 URL は登録表の解決済み view パスから汎用の組み立てで作り、
   * 種別分岐を持たない。
   *
   * @param want - 配置する束縛。
   * @param viewGeneration - 写す表示期間の世代。
   */
  private createPending(
    want: { kind: PluginUiMountKind; instanceId: string; localSessionId: string; portId: string },
    viewGeneration: number,
  ): void {
    // ADR: 識別子の単調性を `sequence` の破棄をしないことで保つ。
    // `resetAll`・`dispose` でも巻き戻さず、古い割当てとの混線を避ける。
    this.sequence += 1;
    const mountId = `plugin-${want.kind}-${this.sequence}`;
    const entry = this.registry.getEntry(want.kind);
    if (entry === undefined) {
      // ADR: 到達不能な invariant。種別は composition root で所有表と登録表に
      // 対で登録するため、所有済みの束縛が登録表に無いことはない。混入時の
      // 続行を避けるため失敗させる。
      throw new RangeError(`未登録の種別への配置である: ${want.kind}`);
    }
    const initialUrl = buildPluginBlankUrl(mountId);
    const viewUrl = buildPluginViewUrl(entry.companion.viewPath, mountId);
    this.mounts.set(mountId, {
      mountId,
      kind: want.kind,
      initialUrl,
      viewUrl,
      instanceId: want.instanceId,
      localSessionId: want.localSessionId,
      portId: want.portId,
      viewGeneration,
      phase: "pending",
      view: null,
      channel: null,
      endpoint: null,
      endpointClosed: false,
      pluginResponded: false,
      relaySeen: false,
      createdAt: this.now(),
    });
    console.log(
      `[bridge-gui] 実プラグイン子画面の配置を受け付けた: mountId=${mountId} kind=${want.kind} generation=${viewGeneration}`,
    );
  }

  /**
   * 配置待ちの1行を結線する。生成条件の照合後に endpoint を生成して個体別
   * RPC を結線し、子画面を読み込む。画面から任意 URL・HTML・preload は
   * 受け付けない。タグ方式の二重生成はしない（native 生成はタグ内部）。
   *
   * 子タグの遷移規則は endpoint 生成・RPC 結線・子 URL 読込みより前に、
   * backend と同じ静的登録済み view パス集合から作った期待規則と照合する。
   * 不一致・欠落・不正 JSON は endpoint を生成せず回収し、そのマウントに
   * 局所化する。
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
    // 期待値は backend と同じ静的登録済み view パス集合から作る。子の属性や
    // 申告からは作らない。順序付き完全一致であり、集合比較・ソート比較にしない。
    const expectedRules = buildPluginNavigationRules(
      this.registry.list().map((entry) => entry.companion.viewPath),
    );
    if (!matchPluginNavigationRules(view.navigationRules, expectedRules)) {
      this.failMount(record, "子画面の遷移規則が期待値と一致しないため回収した。");
      return;
    }
    const entry = this.registry.getEntry(record.kind);
    if (entry === undefined) {
      this.failMount(record, "未登録の種別であるため回収した。");
      return;
    }
    // 束縛失効は main 自身の照合で決める。所有段階・現割当てをここで確認する。
    try {
      this.manager.requireBinding(record.kind, record.instanceId);
    } catch (error: unknown) {
      this.failMount(record, `個体の束縛に失敗した: ${describeFailure(error)}`);
      return;
    }
    let endpoint: PluginEndpoint;
    const emission: PluginEmissionPort = {
      emit: (event) => {
        this.deliverEmission(record.mountId, event);
      },
    };
    try {
      // ADR: 型消去は endpoint 工場の閉包内に限定する。参照口の生成は
      // 管理層が行い、ここでは消した型で渡す。
      const ref = this.manager.createBoundRef<unknown, unknown>(record.kind, record.instanceId);
      endpoint = entry.createEndpoint(ref, emission);
    } catch (error: unknown) {
      this.failMount(record, `個体の束縛に失敗した: ${describeFailure(error)}`);
      return;
    }
    record.endpoint = endpoint;
    let channel: PluginUiChannel;
    try {
      channel = this.createChannel(view, record.mountId, (request: unknown) =>
        this.handleRelay(record.mountId, request),
      );
    } catch (error: unknown) {
      this.failMount(record, `子画面の結線に失敗した: ${describeFailure(error)}`);
      return;
    }
    record.channel = channel;
    record.phase = "bound";
    console.log(
      `[bridge-gui] 実プラグイン子画面を生成した: mountId=${record.mountId} viewId=${view.viewId}`,
    );
    try {
      // 結線の後に子画面を読み込む。初期 URL は静的登録表から選ぶ。
      view.loadPluginUrl(record.viewUrl);
    } catch (error: unknown) {
      this.failMount(record, `子画面の読込みに失敗した: ${describeFailure(error)}`);
      return;
    }
    console.log(
      `[bridge-gui] 実プラグイン子画面を束縛した: mountId=${record.mountId} viewId=${view.viewId}`,
    );
    console.log(`[bridge-gui] 実プラグイン子画面の URL を読み込んだ: mountId=${record.mountId}`);
    this.backend.notifyExternalChange();
  }

  /**
   * endpoint からの通知を同一マウント生存時のみ子へ素通しする。
   * 外形だけを見て内容検査はしない。キュー・再配信・最新状態キャッシュは
   * 持たない。
   *
   * @param mountId - 送り元のマウント識別子。
   * @param event - 通知の共通形。
   */
  private deliverEmission(mountId: string, event: PluginRelayEvent): void {
    const record = this.mounts.get(mountId);
    if (
      record === undefined ||
      record.phase !== "bound" ||
      record.endpointClosed ||
      record.channel === null
    ) {
      return;
    }
    if (!isRelayEventShape(event)) {
      return;
    }
    // 束縛失効は main 自身の照合で決める。
    try {
      this.manager.requireBinding(record.kind, record.instanceId);
    } catch {
      return;
    }
    try {
      record.channel.push({ event: event.event, payload: event.payload });
    } catch {
      // 送信の失敗は対応付けの整理を止めない。
    }
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
   * 終了した表示要求・失効した束縛の対応付けを外す。失敗表示には回さない。
   *
   * @param record - 外す対応付けの記録。
   * @param reason - 記録用の理由（表示名のみ）。
   */
  private releaseMount(record: PluginUiMountRecord, reason: string): void {
    this.invalidateMount(record);
    console.log(
      `[bridge-gui] 実プラグイン子画面を外した: mountId=${record.mountId} reason=${reason}`,
    );
  }

  /**
   * 失敗した対応付けを回収し、失敗表示に回す。
   *
   * インスタンスや Session を自動解除せず、送信も自動再実行しない。
   * 同一表示期間の再配置は明示の再試行まで行わない。新しい表示期間では
   * 失敗表示が一致しないため一度生成する。
   *
   * @param record - 回収する対応付けの記録。
   * @param reason - 人間向けの短い理由。
   */
  private failMount(record: PluginUiMountRecord, reason: string): void {
    const generation = record.viewGeneration;
    this.invalidateMount(record);
    this.failures.push({
      kind: record.kind,
      reason,
      instanceId: record.instanceId,
      localSessionId: record.localSessionId,
      viewGeneration: generation,
    });
    console.log(
      `[bridge-gui] 実プラグイン子画面を回収した: mountId=${record.mountId} reason=${reason}`,
    );
    this.backend.notifyExternalChange();
    this.maintainSweepTimer();
  }

  /**
   * マウント失効・endpoint 終了・表示破棄を行う。子の破棄でプラグイン本体・
   * Session・UDP ソケットは終了しない。
   *
   * @param record - 無効化する対応付けの記録。
   */
  private invalidateMount(record: PluginUiMountRecord): void {
    const view = record.view;
    const endpoint = record.endpoint;
    this.mounts.delete(record.mountId);
    this.retired.add(record.mountId);
    record.view = null;
    record.channel = null;
    record.endpoint = null;
    record.endpointClosed = true;
    if (endpoint !== null) {
      try {
        endpoint.dispose();
      } catch {
        // 終了の失敗は記録の整理を止めない。
      }
    }
    this.removeSilently(view);
  }

  /**
   * 表示の破棄。失敗しても所有表の整理を止めない。
   *
   * @param view - 破棄する子画面ハンドル。`null` なら何もしない。
   */
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
   * 期限走査タイマーを保つ。待ちがある間だけ動かし、無ければ止める。
   * 終了・破棄では残さない。
   */
  private maintainSweepTimer(): void {
    const needsSweep = [...this.mounts.values()].some((record) => !record.pluginResponded);
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

  /** 期限走査タイマーを止める。 */
  private stopSweepTimer(): void {
    const timer = this.sweepTimer;
    this.sweepTimer = null;
    if (timer === null) {
      return;
    }
    clearInterval(timer);
  }
}
