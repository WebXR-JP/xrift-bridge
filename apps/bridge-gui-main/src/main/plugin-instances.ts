/**
 * マウントと実インスタンスの対応付け。マウント生存の照合と backend の
 * 現割当て照合を両方行い、そのマウントに束縛した個体別 RPC の要求に応答する。
 *
 * Electrobun の SDK 呼び出しは持たない。`BrowserView` への結線は
 * `src/main/instance-rpc.ts` の適合層が担い、ここでは対応付けと照合・
 * 改訂番号だけを担う。単体検証は偽の backend・偽の生存照合で行える。
 *
 * 種別ごとの限定射影・操作への到達は backend ごとに生成した登録表
 * （`plugin-companions.ts`）の記述子に委譲し、ここに種別分岐を持たない。
 * 新しい companion の追加は登録だけで行い、この層の分岐追加は要らない。
 *
 * 対応付けの方針は以下である。
 * - 対応付けは `mountId` から束縛個体（`instanceId`・種別トークン）への写像だけを持ち、
 *   割当ての実体は backend が持つ。子から任意の `instanceId`／`localSessionId`
 *   を受け取って振り分ける口は作らない。
 * - 要求ごとにマウント生存と種別を照合し、現割当ては companion の射影が
 *   例外で示す。古い（失効した）マウント・割当ての要求は拒否する。
 * - 改訂番号は対応付けごとに進み、読み取りでは進めない。push でのみ進む。
 *
 * @packageDocumentation
 */
import type { PluginCompanion } from "bridge-gui-plugin-sdk/companion";
import type { PluginCompanionRegistry } from "./plugin-companions.ts";

/**
 * マウント生存の照合口。対応付け側の所有表の読み取り側が実装する。
 */
export interface MountLiveness {
  /**
   * 子画面が結線済みで利用できるか。
   *
   * @param mountId - 照合するマウント識別子。
   * @returns 結線済みで所有中なら真。
   */
  isLive(mountId: string): boolean;
}

/** 汎用の push 口。当該マウントの結線だけに送る。 */
export type PushSink = (message: unknown) => void;

/** 対応付けの1行。 */
interface BindingRecord {
  /** 対応付けるマウント識別子。 */
  readonly mountId: string;
  /** 束縛した実インスタンスの識別子。 */
  readonly instanceId: string;
  /** 束縛した個体の種別トークン。登録表の companion を指す。 */
  readonly kind: string;
  /** 対応付け単位の改訂番号。 */
  revision: number;
  /** 状態 push 口。未登録なら `null`。 */
  sink: PushSink | null;
}

/**
 * 空でない識別子を検証する。
 *
 * 型付き RPC を実行時検証とみなさず、境界で検査する。
 *
 * @param value - 検査する未知値。
 * @param name - 項目名（人間向けの説明に使う）。
 * @returns 検証済みの識別子。
 * @throws `RangeError` — 空・文字列でない場合。
 */
function assertId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${name} は空でない文字列であること。`);
  }
  return value;
}

/**
 * マウントと実インスタンスの対応付け。所有表の操作はすべて同期であり、
 * backend の射影呼び出し自体も同期的である（送信の解決は約束で返す）。
 *
 * 子画面が呼べる要求は汎用の `readSnapshot`・`send` だけであり、
 * 種別トークンは companion が決め打ちで渡す。受付・保留・承認・接続断・
 * 割当て等の管理操作は持たない。
 */
export class PluginInstanceBinder {
  private readonly bindings = new Map<string, BindingRecord>();

  /**
   * @param liveness - マウント生存の照合口。
   * @param registry - 種別トークンから記述子を引く登録表。backend ごとに生成して渡す。
   */
  constructor(
    private readonly liveness: MountLiveness,
    private readonly registry: PluginCompanionRegistry,
  ) {}

  /** 対応付け中の件数。記録用である。 */
  get size(): number {
    return this.bindings.size;
  }

  /**
   * マウントに個体を束縛する。種別ごとの実在・現割当ての確認は
   * 登録表の記述子に委譲し、ここに種別分岐を持たない。
   *
   * @param mountId - 対応付けるマウント識別子。
   * @param kind - 束縛する個体の種別トークン。登録済みであること。
   * @param instanceId - 束縛する実インスタンスの識別子。
   * @throws `RangeError` — 識別子が不正・対応付け済み・所有表に無い・
   * 未登録種別・実在しない・現割当てが無い場合。
   */
  bindMount(mountId: string, kind: string, instanceId: string): void {
    const mount = assertId(mountId, "mountId");
    const token = assertId(kind, "kind");
    const instance = assertId(instanceId, "instanceId");
    if (this.bindings.has(mount)) {
      throw new RangeError("対応付け済みのマウントである。");
    }
    if (!this.liveness.isLive(mount)) {
      throw new RangeError("子画面は利用できない（未結線・破棄済み）。");
    }
    const companion = this.requireCompanion(token);
    // ADR: 実在と現割当ての有無は companion の射影に問う。失効していれば
    // ここで拒否し、対応付けを作らない。二重管理の真偽表は持たない。
    companion.readView(instance);
    this.bindings.set(mount, {
      mountId: mount,
      instanceId: instance,
      kind: token,
      revision: 0,
      sink: null,
    });
    console.log(`[bridge-gui] 個体を対応付けた: mountId=${mount} instanceId=${instance}`);
  }

  /**
   * 対応付けを外す。清掃経路の二重外しを許し、冪等である。
   *
   * @param mountId - 外す対応付けのマウント識別子。
   * @throws `RangeError` — 識別子が不正な場合。
   */
  unbindMount(mountId: unknown): { ok: true } {
    const id = assertId(mountId, "mountId");
    const record = this.bindings.get(id);
    if (record !== undefined) {
      this.bindings.delete(id);
      record.sink = null;
      console.log(`[bridge-gui] 個体の対応付けを外した: mountId=${id}`);
    }
    return { ok: true };
  }

  /**
   * 状態 push 口を登録する。更新ハンドラ登録に相当する。
   *
   * @param mountId - 対応付け済みのマウント識別子。
   * @param kind - 束縛した個体の種別トークン。対応付けの記録と照合する。
   * @param sink - 当該マウント専用の push 口。
   * @throws `RangeError` — 未対応付け・失効・種別外の場合。
   */
  setSink(mountId: string, kind: string, sink: PushSink): void {
    this.requireBinding(mountId, kind).sink = sink;
  }

  /**
   * 束縛個体の限定表示を改訂番号付きで読む。読み取りは revision を進めない。
   * 種別ごとの射影は登録表の記述子に委譲し、ここに種別分岐を持たない。
   *
   * @param kind - companion の種別トークン。対応付けの記録と照合する。
   * @param mountId - 照合済みのマウント識別子。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合。
   */
  readSnapshot(kind: string, mountId: string): unknown {
    const record = this.requireBinding(mountId, kind);
    const companion = this.requireCompanion(record.kind);
    const view = companion.readView(record.instanceId);
    return companion.toSnapshot(view, record.revision);
  }

  /**
   * 束縛個体の操作へ委譲する。子からの割当て識別子の指定は受け付けず、
   * main が束縛した個体の現割当てに委譲する。種別ごとの操作口は
   * 登録表の記述子に委譲し、ここに種別分岐を持たない。
   *
   * @param kind - companion の種別トークン。対応付けの記録と照合する。
   * @param mountId - 照合済みのマウント識別子。
   * @param params - 操作の引数。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効・操作口無しの場合（同期的）。
   */
  send(kind: string, mountId: string, params: unknown): Promise<unknown> {
    const record = this.requireBinding(mountId, kind);
    const companion = this.requireCompanion(record.kind);
    const operation = companion.send;
    if (operation === undefined) {
      throw new RangeError("操作口が無い。");
    }
    return operation(record.instanceId, params);
  }

  /**
   * 当該マウントだけに状態 push を送る。改訂番号を進める。
   * 種別ごとの射影・通知名は登録表の記述子に委譲し、ここに種別分岐を持たない。
   *
   * @param mountId - 送り先のマウント識別子。
   * @throws `RangeError` — 識別子が不正・未対応付け・失効・
   * push 口未登録・現割当て失効の場合。
   */
  push(mountId: unknown): { revision: number } {
    const id = assertId(mountId, "mountId");
    const record = this.requireBinding(id, undefined);
    const companion = this.requireCompanion(record.kind);
    const sink = record.sink;
    if (sink === null) {
      throw new RangeError("子画面の push 口が無い。");
    }
    const view = companion.readView(record.instanceId);
    record.revision += 1;
    // 通知の外形（`{ revision, snapshot }`）は全 companion で共通であり、
    // 中身の snapshot は記述子が作る。種別分岐は持たない。
    sink({ revision: record.revision, snapshot: companion.toSnapshot(view, record.revision) });
    console.log(`[bridge-gui] 個体へ送った: mountId=${id} revision=${record.revision}`);
    return { revision: record.revision };
  }

  /** 対応付け中の概要一覧を返す。表示用である。 */
  listBindings(): Array<{
    readonly mountId: string;
    readonly instanceId: string;
    readonly kind: string;
    readonly revision: number;
  }> {
    return [...this.bindings.values()].map((record) => ({
      mountId: record.mountId,
      instanceId: record.instanceId,
      kind: record.kind,
      revision: record.revision,
    }));
  }

  /** 登録表から記述子を引く。未登録なら拒否する。 */
  private requireCompanion(kind: string): PluginCompanion {
    const companion = this.registry.get(kind);
    if (companion === undefined) {
      throw new RangeError("未登録の種別である。");
    }
    return companion;
  }

  /** 対応付けを取り出し、生存と種別を照合する。 */
  private requireBinding(mountId: string, kind: string | undefined): BindingRecord {
    const record = this.bindings.get(mountId);
    if (record === undefined) {
      throw new RangeError("対応付けの無いマウントである。");
    }
    // 照合は所有表の現在形で行い、古い（失効した）マウントの要求は拒否する。
    if (!this.liveness.isLive(mountId)) {
      throw new RangeError("子画面は利用できない（未結線・破棄済み）。");
    }
    if (kind !== undefined && record.kind !== kind) {
      throw new RangeError("束縛した個体の種別と要求が一致しない。");
    }
    return record;
  }
}
