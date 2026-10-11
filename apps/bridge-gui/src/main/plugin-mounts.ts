/**
 * 段0スパイクのマウント管理。実在インスタンスの代わりに検証用の子画面を
 * マウント識別子ごとに所有する。
 *
 * Electrobun の SDK 呼び出しは持たない。生成・破棄・結線の実体は
 * `src/main/spike-rpc.ts` の適合層が `BrowserView` に結び付け、
 * ここでは所有表と照合・退役だけを担う。単体検証は偽の子画面で行える。
 *
 * 所有の方針は以下である。
 * - マウント識別子は単調な連番で発行し、破棄後も使い回さない。
 * - タグ生成の照合は main が発行した初期 URL の完全一致で行い、
 *   画面の申告（任意 URL・HTML・preload）は受け付けない。
 * - 破棄は所有表からの削除と表示の破棄で行い、DOM 削除だけに依存しない。
 * - 全工程は同期的であり、 event loop 上で直列化される。
 *   退役と遅延生成のどちらが先でも残存を残さない。
 *
 * @packageDocumentation
 */
import type {
  PluginMountDto,
  SpikePushMessage,
  SpikePushResult,
  SpikeSnapshot,
} from "../shared/plugin-spike.ts";
import { buildBlankUrl, buildSpikeUrl, parseMountId } from "../shared/plugin-spike.ts";

/**
 * SDK 非依存の子画面ハンドル。実体は適合層が `BrowserView` に結び付ける。
 *
 * 読み取りは生成時の照合専用であり、画面側が後から書き換える口はない。
 */
export interface MountChildView {
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
   * 専用 RPC の結線後に子画面を読み込む。
   *
   * @param url - main の静的登録表から作った子画面 URL。
   */
  loadSpikeUrl(url: string): void;
  /** 所有表からの破棄。冪等であること。 */
  removeView(): void;
}

/** マウント専用の push 口。当該マウントの結線だけに送る。 */
export interface MountChannel {
  /**
   * 状態 push を送る。
   *
   * @param message - 送り先識別子と改訂番号。本文は含めない。
   */
  pushState(message: SpikePushMessage): void;
}

/** マウント専用 RPC が main 側へ返す処理。 */
export interface SpikeChannelHooks {
  /**
   * 子画面の状態取得に応答する。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @returns 当該マウントの snapshot。
   */
  handleGetState(mountId: string): SpikeSnapshot;
  /**
   * 子画面の初期 snapshot 採用通知を受け、準備完了と push を行う。
   *
   * @param mountId - 照合済みのマウント識別子。
   */
  handleReady(mountId: string): void;
}

/**
 * マウント専用チャネルを作る。SDK 依存の実体は適合層が差し込む。
 *
 * @param view - 照合済みの子画面ハンドル。
 * @param mountId - 結び付けるマウント識別子。
 * @param hooks - main 側の応答処理。
 * @returns 当該マウント専用の push 口。
 */
export type SpikeChannelFactory = (
  view: MountChildView,
  mountId: string,
  hooks: SpikeChannelHooks,
) => MountChannel;

/** 所有表の1行。 */
interface MountRecord {
  /** 再利用しないマウント識別子。 */
  readonly mountId: string;
  /** 発行した初期 URL。生成照合の鍵である。 */
  readonly initialUrl: string;
  /** 結線後に読み込む子画面 URL。 */
  readonly spikeUrl: string;
  /** 結線段階。 */
  phase: "pending" | "bound";
  /** 結線済みの子画面。未結線なら `null`。 */
  view: MountChildView | null;
  /** 専用 push 口。未結線なら `null`。 */
  channel: MountChannel | null;
  /** マウント単位の改訂番号。 */
  revision: number;
  /** 初期 snapshot 採用通知を受けた場合に真。 */
  ready: boolean;
}

/**
 * 空でない識別子を検証する。
 *
 * 型付き RPC を実行時検証とみなさず、境界で検査する。
 *
 * @param value - 検査する未知値。
 * @returns 検証済みのマウント識別子。
 * @throws `RangeError` — 空・文字列でない場合。
 */
function assertMountId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError("mountId は空でない文字列であること。");
  }
  return value;
}

/**
 * 段0スパイクのマウント管理。所有表の操作はすべて同期である。
 *
 * 生成前の終了要求・初期化途中の削除・遅延生成のいずれでも、
 * 所有表・表示・購読の残存を残さない。
 */
export class PluginMountManager {
  private readonly parentWebviewId: number;
  private readonly createChannel: SpikeChannelFactory;
  private sequence = 0;
  private readonly mounts = new Map<string, MountRecord>();
  /** 破棄済みの識別子。遅延生成の回収と使い回し防止に使う。 */
  private readonly retired = new Set<string>();

  /**
   * @param parentWebviewId - 管理画面 Webview の識別子。親の照合に使う。
   * @param createChannel - 専用チャネルの工場。SDK 依存はここに閉じる。
   */
  constructor(parentWebviewId: number, createChannel: SpikeChannelFactory) {
    this.parentWebviewId = parentWebviewId;
    this.createChannel = createChannel;
  }

  /** 所有中のマウント数。記録用である。 */
  get size(): number {
    return this.mounts.size;
  }

  /**
   * 配置を受け付け、配置用 DTO を返す。
   *
   * 識別子は単調な連番で発行し、破棄後も使い回さない。
   *
   * @returns 管理画面がタグ配置に使う DTO。
   */
  createMount(): PluginMountDto {
    // ADR: 識別子の単調性を `sequence` の破棄をしないことで保つ。
    // `resetAll`・`closeAll` でも巻き戻さず、古い割当てとの混線を避ける。
    this.sequence += 1;
    const mountId = `spike-${this.sequence}`;
    const initialUrl = buildBlankUrl(mountId);
    const spikeUrl = buildSpikeUrl(mountId);
    this.mounts.set(mountId, {
      mountId,
      initialUrl,
      spikeUrl,
      phase: "pending",
      view: null,
      channel: null,
      revision: 0,
      ready: false,
    });
    console.log(`[bridge-gui] 子画面の配置を受け付けた: mountId=${mountId}`);
    return { mountId, initialUrl };
  }

  /**
   * タグ生成を照合し、当該マウント専用の結線を行う。
   *
   * `BrowserView.on("created")` から呼ぶ。親 Webview・初期 URL・
   * 生成条件（native・sandbox 無し・preload 無し）を照合し、
   * 結線してから子画面を読み込む。照合に失敗した生成は回収する。
   * 退役済み・重複・由来不明の遅延生成もここで回収する。
   *
   * @param view - 生成された子画面ハンドル。
   */
  handleTagCreated(view: MountChildView): void {
    // 親の照合。他者の所有物には触らず無視する。
    if (view.hostWebviewId !== this.parentWebviewId) {
      console.log(`[bridge-gui] 別の親の生成を無視した: viewId=${view.viewId}`);
      return;
    }
    const url = view.currentUrl;
    for (const record of this.mounts.values()) {
      // 照合は発行済み初期 URL の完全一致である。画面の申告は読まない。
      if (record.phase === "pending" && record.initialUrl === url) {
        this.bind(record, view);
        return;
      }
    }
    this.reclaimOrphan(view);
  }

  /**
   * 子画面の状態取得に応答する。専用チャネル経由で呼ぶ。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @returns 当該マウントの snapshot。
   * @throws `RangeError` — 未結線・破棄済みの場合。
   */
  snapshotOf(mountId: string): SpikeSnapshot {
    const record = this.requireBound(mountId);
    return { mountId: record.mountId, revision: record.revision };
  }

  /**
   * 子画面の初期 snapshot 採用通知を受け、準備完了として push を返す。
   *
   * `dom-ready` では判定せず、この通知で準備完了とする。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @throws `RangeError` — 未結線・破棄済みの場合。
   */
  markReady(mountId: string): void {
    const record = this.requireBound(mountId);
    const channel = record.channel;
    if (channel === null) {
      throw new RangeError("子画面は結線されていない。");
    }
    record.ready = true;
    record.revision += 1;
    channel.pushState({ mountId: record.mountId, revision: record.revision });
    console.log(
      `[bridge-gui] 子画面の準備ができた: mountId=${record.mountId} revision=${record.revision}`,
    );
  }

  /**
   * 当該マウントだけに push を送る。混線の確認用である。
   *
   * @param mountId - 送り先のマウント識別子。
   * @returns 送った改訂番号。
   * @throws `RangeError` — 識別子が不正・未結線・破棄済みの場合。
   */
  pushMount(mountId: unknown): SpikePushResult {
    const id = assertMountId(mountId);
    const record = this.requireBound(id);
    const channel = record.channel;
    if (channel === null) {
      throw new RangeError("子画面は結線されていない。");
    }
    record.revision += 1;
    channel.pushState({ mountId: record.mountId, revision: record.revision });
    console.log(
      `[bridge-gui] 子画面へ送った: mountId=${record.mountId} revision=${record.revision}`,
    );
    return { revision: record.revision };
  }

  /**
   * マウントを破棄する。所有表からの削除と表示の破棄を行う。
   *
   * 配置待ちの破棄では識別子を退役に回し、遅延生成を回収できるようにする。
   * DOM 削除だけには依存しない。
   *
   * @param mountId - 破棄するマウント識別子。
   * @throws `RangeError` — 識別子が不正・不明な場合。
   */
  destroyMount(mountId: unknown): { ok: true } {
    const id = assertMountId(mountId);
    const record = this.mounts.get(id);
    if (record === undefined) {
      throw new RangeError("不明なマウントである。");
    }
    const view = record.view;
    this.retireRecord(record, "破棄");
    this.removeSilently(view);
    return { ok: true };
  }

  /**
   * 全マウントを破棄する。管理画面の再読込み掃除と終了処理に使う。
   *
   * 識別子の連番は巻き戻さず、使い回しを避ける。
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
      this.retireRecord(record, reason);
      this.removeSilently(view);
    }
    console.log(`[bridge-gui] 子画面を全て外した: reason=${reason} count=${ids.length}`);
    return { ok: true };
  }

  /** 所有中のマウント一覧を返す。表示用である。 */
  listMounts(): Array<{
    readonly mountId: string;
    readonly initialUrl: string;
    readonly phase: "pending" | "bound";
    readonly ready: boolean;
    readonly revision: number;
  }> {
    return [...this.mounts.values()].map((record) => ({
      mountId: record.mountId,
      initialUrl: record.initialUrl,
      phase: record.phase,
      ready: record.ready,
      revision: record.revision,
    }));
  }

  /**
   * 配置待ちの1行を結線する。生成条件の照合後に専用 RPC を結線し、
   * 子画面を読み込む。画面から任意 URL・HTML・preload は受け付けない。
   */
  private bind(record: MountRecord, view: MountChildView): void {
    if (view.renderer !== "native" || view.sandbox || view.preload !== null) {
      console.log(`[bridge-gui] 生成条件外のため回収した: mountId=${record.mountId}`);
      this.retireRecord(record, "生成条件外");
      this.removeSilently(view);
      return;
    }
    const channel = this.createChannel(view, record.mountId, {
      handleGetState: (mountId) => this.snapshotOf(mountId),
      handleReady: (mountId) => this.markReady(mountId),
    });
    record.phase = "bound";
    record.view = view;
    record.channel = channel;
    console.log(`[bridge-gui] 子画面を結線した: mountId=${record.mountId} viewId=${view.viewId}`);
    try {
      // 結線の後に子画面を読み込む。初期 URL は静的登録表から選ぶ。
      view.loadSpikeUrl(record.spikeUrl);
    } catch (error: unknown) {
      console.log(
        `[bridge-gui] 子画面の読込みに失敗したため回収する: mountId=${record.mountId} ${String(error)}`,
      );
      this.retireRecord(record, "読込み失敗");
      this.removeSilently(view);
    }
  }

  /**
   * 所有表に結び付かない生成を回収する。
   *
   * 初期化完了前の DOM 削除が native 生成を止めない SDK 挙動があるため、
   * 退役済み・重複・由来不明の遅延生成は main が回収する。
   */
  private reclaimOrphan(view: MountChildView): void {
    const claimed = parseMountId(view.currentUrl);
    if (claimed !== null && this.retired.has(claimed)) {
      console.log(
        `[bridge-gui] 失効済みマウントの遅延生成を回収した: mountId=${claimed} viewId=${view.viewId}`,
      );
    } else if (claimed !== null && this.mounts.has(claimed)) {
      console.log(`[bridge-gui] 重複する生成を回収した: mountId=${claimed} viewId=${view.viewId}`);
    } else {
      console.log(`[bridge-gui] 由来不明の生成を回収した: viewId=${view.viewId}`);
    }
    this.removeSilently(view);
  }

  /** 結線済みの1行を取り出す。未結線・破棄済みは拒否する。 */
  private requireBound(mountId: string): MountRecord {
    const record = this.mounts.get(mountId);
    if (record === undefined || record.phase !== "bound" || record.view === null) {
      throw new RangeError("子画面は利用できない（未結線・破棄済み）。");
    }
    return record;
  }

  /** 所有表から外し、退役に回す。購読の参照もここで離す。 */
  private retireRecord(record: MountRecord, reason: string): void {
    this.mounts.delete(record.mountId);
    this.retired.add(record.mountId);
    record.view = null;
    record.channel = null;
    console.log(`[bridge-gui] 子画面を外した: mountId=${record.mountId} reason=${reason}`);
  }

  /** 表示の破棄。失敗しても所有表の整理を止めない。 */
  private removeSilently(view: MountChildView | null): void {
    if (view === null) {
      return;
    }
    try {
      view.removeView();
    } catch {
      // 破棄の失敗は記録の整理を止めない。
    }
  }
}
