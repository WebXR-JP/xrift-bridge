/**
 * マウントと実インスタンスの対応付け。段0所有表の生存照合と backend の
 * 現割当て照合を両方行い、そのマウントに束縛した個体別 RPC の要求に応答する。
 *
 * Electrobun の SDK 呼び出しは持たない。`BrowserView` への結線は
 * `src/main/instance-rpc.ts` の適合層が担い、ここでは対応付けと照合・
 * 改訂番号だけを担う。単体検証は偽の backend・偽の生存照合で行える。
 *
 * 対応付けの方針は以下である。
 * - 対応付けは `mountId` から束縛個体（`instanceId`・種別）への写像だけを持ち、
 *   割当ての実体は backend が持つ。子から任意の `instanceId`／`localSessionId`
 *   を受け取って振り分ける口は作らない。
 * - 要求ごとにマウント生存と種別を照合し、現割当ては backend の射影が
 *   例外で示す。古い（失効した）マウント・割当ての要求は拒否する。
 * - 改訂番号は対応付けごとに進み、読み取りでは進めない。push でのみ進む。
 *
 * @packageDocumentation
 */
import type { TextSendResult } from "bridge-app-core";
import type {
  DiagnosticInstanceChangedMessage,
  DiagnosticInstanceSnapshot,
  DiagnosticInstanceView,
  TextInstanceChangedMessage,
  TextInstanceSnapshot,
  TextInstanceView,
} from "../shared/plugin-instance.ts";
import type { PluginMountManager } from "./plugin-mounts.ts";

/**
 * 個体別射影の最小口。`GuiBackend` が構造的に満たす。
 *
 * 管理 snapshot 全体・他個体の情報・候補一覧・保留情報は返さない。
 * 現割当てが失効していれば `RangeError` で拒否する。
 */
export interface InstanceProjectionBackend {
  /**
   * 束縛テキスト個体の限定表示を返す。
   *
   * @param params - 束縛個体の識別子。main が対応付けから決め、子は指定しない。
   */
  getTextInstanceView(params: { instanceId: unknown }): TextInstanceView;
  /**
   * 束縛テキスト個体の現割当てへ本文を送る。
   *
   * 識別子は main が対応付けから決め、子は本文だけを渡す。
   *
   * @param instanceId - 束縛個体の識別子。main が対応付けから決める。
   * @param params - 送信する本文。文字列であること。
   */
  sendTextForInstance(instanceId: unknown, params: { text: unknown }): Promise<TextSendResult>;
  /**
   * 束縛診断個体の限定表示を返す。
   *
   * @param params - 束縛個体の識別子。main が対応付けから決め、子は指定しない。
   */
  getDiagnosticInstanceView(params: { instanceId: unknown }): DiagnosticInstanceView;
}

/**
 * マウント生存の照合口。段0所有表の読み取り側が実装する。
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

/**
 * 段0所有表を生存照合口として読む。
 *
 * 結線済み（`bound`）の所有だけを生存とし、配置待ち・破棄済みは
 * 利用できない。所有表の変更はしない。
 *
 * @param manager - 段0スパイクのマウント管理。
 * @returns 生存照合口。
 */
export function asMountLiveness(manager: PluginMountManager): MountLiveness {
  return {
    isLive: (mountId) =>
      manager.listMounts().some((mount) => mount.mountId === mountId && mount.phase === "bound"),
  };
}

/** テキスト個体の push 口。当該マウントの結線だけに送る。 */
export type TextPushSink = (message: TextInstanceChangedMessage) => void;

/** 診断個体の push 口。当該マウントの結線だけに送る。 */
export type DiagnosticPushSink = (message: DiagnosticInstanceChangedMessage) => void;

/**
 * 個体別 RPC が main 側へ返す処理。子から識別子の指定は受け付けない。
 *
 * 束縛済み個体以外・失効した対応付けの要求は `RangeError` で拒否する。
 */
export interface InstanceChannelHooks {
  /**
   * 束縛テキスト個体の状態取得に応答する。
   *
   * @param mountId - 照合済みのマウント識別子。
   */
  handleGetTextState(mountId: string): TextInstanceSnapshot;
  /**
   * 束縛テキスト個体の現割当てへ本文を送る。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @param text - 送信する本文。文字列であること。
   */
  handleSendText(mountId: string, text: unknown): Promise<TextSendResult>;
  /**
   * 束縛診断個体の状態取得に応答する。
   *
   * @param mountId - 照合済みのマウント識別子。
   */
  handleGetDiagnosticState(mountId: string): DiagnosticInstanceSnapshot;
}

/** 対応付けの種別。 */
type BindingKind = "text" | "diagnostic";

/** 対応付けの1行。 */
interface BindingRecord {
  /** 対応付けるマウント識別子。 */
  readonly mountId: string;
  /** 束縛した実インスタンスの識別子。 */
  readonly instanceId: string;
  /** 束縛した個体の種別。 */
  readonly kind: BindingKind;
  /** 対応付け単位の改訂番号。 */
  revision: number;
  /** テキスト push 口。未登録・種別外なら `null`。 */
  textSink: TextPushSink | null;
  /** 診断 push 口。未登録・種別外なら `null`。 */
  diagnosticSink: DiagnosticPushSink | null;
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
 * 子画面が呼べる要求は `InstanceChannelHooks` の3口だけであり、
 * 受付・保留・承認・接続断・割当て等の管理操作は持たない。
 */
export class PluginInstanceBinder implements InstanceChannelHooks {
  private readonly bindings = new Map<string, BindingRecord>();

  /**
   * @param liveness - 段0所有表の生存照合口。
   * @param backend - 個体別射影の最小口。
   */
  constructor(
    private readonly liveness: MountLiveness,
    private readonly backend: InstanceProjectionBackend,
  ) {}

  /** 対応付け中の件数。記録用である。 */
  get size(): number {
    return this.bindings.size;
  }

  /**
   * マウントにテキスト個体を束縛する。
   *
   * マウント生存と実在・現割当てをこの時点で確かめ、失効していれば
   * 対応付けを作らず拒否する。
   *
   * @param mountId - 対応付けるマウント識別子。
   * @param instanceId - 束縛するテキストインスタンスの識別子。
   * @throws `RangeError` — 識別子が不正・対応付け済み・所有表に無い・
   * 実在しない・現割当てが無い場合。
   */
  bindTextMount(mountId: string, instanceId: string): void {
    this.bind(mountId, instanceId, "text");
  }

  /**
   * マウントに診断個体を束縛する。
   *
   * @param mountId - 対応付けるマウント識別子。
   * @param instanceId - 束縛する診断インスタンスの識別子。
   * @throws `RangeError` — 識別子が不正・対応付け済み・所有表に無い・
   * 実在しない・現割当てが無い場合。
   */
  bindDiagnosticMount(mountId: string, instanceId: string): void {
    this.bind(mountId, instanceId, "diagnostic");
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
      record.textSink = null;
      record.diagnosticSink = null;
      console.log(`[bridge-gui] 個体の対応付けを外した: mountId=${id}`);
    }
    return { ok: true };
  }

  /**
   * テキスト push 口を登録する。更新ハンドラ登録に相当する。
   *
   * @param mountId - 対応付け済みのマウント識別子。
   * @param sink - 当該マウント専用の push 口。
   * @throws `RangeError` — 未対応付け・失効・種別外の場合。
   */
  setTextSink(mountId: string, sink: TextPushSink): void {
    this.requireKind(mountId, "text").textSink = sink;
  }

  /**
   * 診断 push 口を登録する。更新ハンドラ登録に相当する。
   *
   * @param mountId - 対応付け済みのマウント識別子。
   * @param sink - 当該マウント専用の push 口。
   * @throws `RangeError` — 未対応付け・失効・種別外の場合。
   */
  setDiagnosticSink(mountId: string, sink: DiagnosticPushSink): void {
    this.requireKind(mountId, "diagnostic").diagnosticSink = sink;
  }

  /**
   * 束縛テキスト個体の状態取得に応答する。読み取りは revision を進めない。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合。
   */
  handleGetTextState(mountId: string): TextInstanceSnapshot {
    const record = this.requireKind(mountId, "text");
    const view = this.backend.getTextInstanceView({ instanceId: record.instanceId });
    return { ...view, revision: record.revision };
  }

  /**
   * 束縛テキスト個体の現割当てへ本文を送る。子からの割当て識別子の
   * 指定は受け付けず、main が束縛した個体の現割当てに委譲する。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @param text - 送信する本文。文字列であること。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合（同期的）。
   */
  handleSendText(mountId: string, text: unknown): Promise<TextSendResult> {
    const record = this.requireKind(mountId, "text");
    return this.backend.sendTextForInstance(record.instanceId, { text });
  }

  /**
   * 束縛診断個体の状態取得に応答する。読み取りは revision を進めない。
   *
   * @param mountId - 照合済みのマウント識別子。
   * @throws `RangeError` — 未対応付け・失効・種別外・現割当て失効の場合。
   */
  handleGetDiagnosticState(mountId: string): DiagnosticInstanceSnapshot {
    const record = this.requireKind(mountId, "diagnostic");
    const view = this.backend.getDiagnosticInstanceView({ instanceId: record.instanceId });
    return { ...view, revision: record.revision };
  }

  /**
   * 当該マウントだけにテキスト状態 push を送る。改訂番号を進める。
   *
   * @param mountId - 送り先のマウント識別子。
   * @throws `RangeError` — 識別子が不正・未対応付け・失効・種別外・
   * push 口未登録・現割当て失効の場合。
   */
  pushText(mountId: unknown): { revision: number } {
    const id = assertId(mountId, "mountId");
    const record = this.requireKind(id, "text");
    const sink = record.textSink;
    if (sink === null) {
      throw new RangeError("子画面の push 口が無い。");
    }
    const view = this.backend.getTextInstanceView({ instanceId: record.instanceId });
    record.revision += 1;
    const snapshot: TextInstanceSnapshot = { ...view, revision: record.revision };
    sink({ revision: record.revision, snapshot });
    console.log(`[bridge-gui] 個体へ送った: mountId=${id} revision=${record.revision}`);
    return { revision: record.revision };
  }

  /**
   * 当該マウントだけに診断状態 push を送る。改訂番号を進める。
   *
   * @param mountId - 送り先のマウント識別子。
   * @throws `RangeError` — 識別子が不正・未対応付け・失効・種別外・
   * push 口未登録・現割当て失効の場合。
   */
  pushDiagnostic(mountId: unknown): { revision: number } {
    const id = assertId(mountId, "mountId");
    const record = this.requireKind(id, "diagnostic");
    const sink = record.diagnosticSink;
    if (sink === null) {
      throw new RangeError("子画面の push 口が無い。");
    }
    const view = this.backend.getDiagnosticInstanceView({ instanceId: record.instanceId });
    record.revision += 1;
    const snapshot: DiagnosticInstanceSnapshot = { ...view, revision: record.revision };
    sink({ revision: record.revision, snapshot });
    console.log(`[bridge-gui] 個体へ送った: mountId=${id} revision=${record.revision}`);
    return { revision: record.revision };
  }

  /** 対応付け中の概要一覧を返す。表示用である。 */
  listBindings(): Array<{
    readonly mountId: string;
    readonly instanceId: string;
    readonly kind: BindingKind;
    readonly revision: number;
  }> {
    return [...this.bindings.values()].map((record) => ({
      mountId: record.mountId,
      instanceId: record.instanceId,
      kind: record.kind,
      revision: record.revision,
    }));
  }

  /**
   * 対応付けを作る。実在と現割当ては backend の射影で確かめる。
   */
  private bind(mountId: string, instanceId: string, kind: BindingKind): void {
    const mount = assertId(mountId, "mountId");
    const instance = assertId(instanceId, "instanceId");
    if (this.bindings.has(mount)) {
      throw new RangeError("対応付け済みのマウントである。");
    }
    if (!this.liveness.isLive(mount)) {
      throw new RangeError("子画面は利用できない（未結線・破棄済み）。");
    }
    // ADR: 実在と現割当ての有無は backend の射影に問う。失効していれば
    // ここで拒否し、対応付けを作らない。二重管理の真偽表は持たない。
    if (kind === "text") {
      this.backend.getTextInstanceView({ instanceId: instance });
    } else {
      this.backend.getDiagnosticInstanceView({ instanceId: instance });
    }
    this.bindings.set(mount, {
      mountId: mount,
      instanceId: instance,
      kind,
      revision: 0,
      textSink: null,
      diagnosticSink: null,
    });
    console.log(`[bridge-gui] 個体を対応付けた: mountId=${mount} instanceId=${instance}`);
  }

  /** 対応付けを取り出し、生存と種別を照合する。 */
  private requireKind(mountId: string, kind: BindingKind): BindingRecord {
    const record = this.bindings.get(mountId);
    if (record === undefined) {
      throw new RangeError("対応付けの無いマウントである。");
    }
    // 照合は所有表の現在形で行い、古い（失効した）マウントの要求は拒否する。
    if (!this.liveness.isLive(mountId)) {
      throw new RangeError("子画面は利用できない（未結線・破棄済み）。");
    }
    if (record.kind !== kind) {
      throw new RangeError("束縛した個体の種別と要求が一致しない。");
    }
    return record;
  }
}

/**
 * テキスト個体 RPC の要求処理を組み立てる。SDK に依存しない。
 *
 * 子画面が呼べる要求はここに載せたものだけであり、受付・保留・承認・
 * 接続断・割当て等の管理操作は載せない。適合層はこの表をそのまま使う。
 *
 * @param mountId - 結び付けるマウント識別子。
 * @param hooks - main 側の応答処理。
 * @returns 要求名から処理への表。
 */
export function buildTextRequestHandlers(
  mountId: string,
  hooks: InstanceChannelHooks,
): {
  getTextState: () => TextInstanceSnapshot;
  sendText: (params: { text: string }) => Promise<TextSendResult>;
} {
  return {
    getTextState: () => hooks.handleGetTextState(mountId),
    sendText: ({ text }) => hooks.handleSendText(mountId, text),
  };
}

/**
 * 診断個体 RPC の要求処理を組み立てる。SDK に依存しない。
 *
 * 子画面が呼べる要求はここに載せたものだけであり、管理操作は載せない。
 * 適合層はこの表をそのまま使う。
 *
 * @param mountId - 結び付けるマウント識別子。
 * @param hooks - main 側の応答処理。
 * @returns 要求名から処理への表。
 */
export function buildDiagnosticRequestHandlers(
  mountId: string,
  hooks: InstanceChannelHooks,
): {
  getDiagnosticState: () => DiagnosticInstanceSnapshot;
} {
  return {
    getDiagnosticState: () => hooks.handleGetDiagnosticState(mountId),
  };
}
