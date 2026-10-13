/**
 * 第三の companion（text/diagnostic と異なる固有RPC）の登録検証。
 *
 * 共通の対応付け・結線（binder・coordinator・channel factory）に分岐を
 * 追加せず、登録表への登録だけで配置→結線→状態取得→push が通ることを
 * 確かめる。text/diagnostic と異なる要求名・通知名・表示を持つ。
 * 試験用の登録表を使い、既定の共有表を汚さない。
 * 新 registrar 経路全体の検証は `third-plugin-registration.test.ts` が担い、
 * ここでは登録表直結の結線単位を固定する（役割分担であり、
 * 保証内容の重複削除ではない）。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginViewUrl,
  parsePluginMountId,
  pluginMountKindOf,
} from "bridge-gui-contract/plugin-instance";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import type { CompanionRequestEnv, PluginCompanion } from "bridge-gui-plugin-sdk/companion";
import {
  PluginUiCoordinator,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";

/** テスト専用 companion の種別トークン。既存種別と重ならない。 */
const MEMO_KIND = "memo";

/** テスト専用 companion の view パス。同梱しないため表に載せない。 */
const MEMO_VIEW_PATH = "views://plugin-memo/index.html";

/** メモ個体の限定表示。本文は含めない。 */
interface MemoView extends InstanceBaseView {
  /** 追加済みメモの件数。 */
  readonly noteCount: number;
  /** 直近メモの写し。未追加なら `null`。 */
  readonly lastNote: string | null;
}

/** メモ子画面が受け取る snapshot。 */
interface MemoSnapshot extends MemoView {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
}

/** main からメモ子画面への状態通知。 */
interface MemoChangedMessage {
  /** 単調増加の改訂番号。 */
  readonly revision: number;
  /** 採用対象の表示状態。 */
  readonly snapshot: MemoSnapshot;
}

/** メモ companion が capture する材料。現割当てと限定表示だけを持つ。 */
interface MemoStore {
  /** 現在のメモ束縛の一覧。 */
  memoBindings: Array<{ instanceId: string; localSessionId: string; portId: string }>;
  /** 束縛メモ個体の限定表示。 */
  memoViews: Map<string, MemoView>;
  /** 束縛メモ個体へ追加した記録。 */
  appended: Array<{ instanceId: string; note: string }>;
}

/**
 * テスト専用のメモ companion を組み立てる。text/diagnostic と異なる要求名
 * （`getMemoState`・`appendMemo`）と通知名（`memoStateChanged`）を持つ。
 * 到達は capture した材料だけを使う。
 *
 * @param store - companion が capture する材料。
 * @returns メモ companion の記述子。
 */
function createMemoCompanion(store: MemoStore): PluginCompanion {
  return {
    kind: MEMO_KIND,
    label: "メモ",
    viewPath: MEMO_VIEW_PATH,
    listDesired(): Array<{
      instanceId: string;
      localSessionId: string;
      portId: string;
    }> {
      return [...store.memoBindings];
    },
    readView(instanceId: string): InstanceBaseView {
      const view = store.memoViews.get(instanceId);
      if (view === undefined) {
        throw new RangeError("束縛したメモ個体ではない。");
      }
      if (!store.memoBindings.some((binding) => binding.instanceId === view.instanceId)) {
        throw new RangeError("メモの現割当てが無い。");
      }
      return view;
    },
    toSnapshot(view: InstanceBaseView, revision: number): unknown {
      // ADR: `as` を使う理由は、同じ companion の `readView` が作った表示に
      // 改訂番号だけを付けるためである。
      const typed = view as MemoView;
      const snapshot: MemoSnapshot = { ...typed, revision };
      return snapshot;
    },
    send(instanceId: string, params: unknown): Promise<unknown> {
      // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
      const table = params as { note: unknown };
      if (!store.memoViews.has(instanceId)) {
        return Promise.reject(new RangeError("束縛したメモ個体ではない。"));
      }
      if (typeof table.note !== "string" || table.note.length === 0) {
        return Promise.reject(new RangeError("note は空でない文字列であること。"));
      }
      store.appended.push({ instanceId, note: table.note });
      return Promise.resolve({ ok: true as const, count: store.appended.length });
    },
    pushMessageName: "memoStateChanged",
    buildRequestHandlers(mountId: string, env: CompanionRequestEnv) {
      return {
        getMemoState: () => {
          const snapshot = env.readSnapshot(MEMO_KIND, mountId);
          // ADR: `as` を使う理由は、対応付けが同一種別の記述子で読んだ表示を
          // 返すためである。
          const typed = snapshot as MemoSnapshot;
          env.markReady(mountId);
          return typed;
        },
        appendMemo: (params: { note: string }) => {
          const result = env.send(MEMO_KIND, mountId, params);
          // ADR: `as` を使う理由は、委譲先の解決型を保つためである。
          return result as Promise<{ ok: true; count: number }>;
        },
      };
    },
  };
}

/**
 * 試験用の登録表を作る。backend ごとに生成し、使い捨てる。
 *
 * 共通コードへの変更なしに登録する。配置の優先順は登録順である。
 *
 * @returns 材料とメモ companion だけを載せた登録表。
 */
function setupMemoRegistry(): { backend: FakeMemoBackend; registry: PluginCompanionRegistry } {
  const backend = new FakeMemoBackend();
  const registry = new PluginCompanionRegistry();
  registry.register(createMemoCompanion(backend));
  return { backend, registry };
}

/** 検証用の偽 backend。材料と外部変化の通知口だけを持つ。 */
class FakeMemoBackend {
  memoBindings: Array<{ instanceId: string; localSessionId: string; portId: string }> = [];
  memoViews = new Map<string, MemoView>();
  appended: Array<{ instanceId: string; note: string }> = [];
  notified = 0;

  notifyExternalChange(): void {
    this.notified += 1;
  }
}

/** 検証用の偽子画面。破棄と読込みの事実だけを残す。 */
class FakeMemoView implements PluginUiChildView {
  removed = false;
  loaded: string[] = [];
  constructor(
    readonly viewId: number,
    readonly hostWebviewId: number | undefined,
    readonly currentUrl: string | null,
  ) {}
  get renderer(): string {
    return "native";
  }
  get sandbox(): boolean {
    return false;
  }
  get preload(): string | null {
    return null;
  }
  get navigationRules(): string | null {
    return null;
  }
  loadPluginUrl(url: string): void {
    this.loaded.push(url);
  }
  removeView(): void {
    this.removed = true;
  }
}

/** 検証用の登録表駆動の偽チャネル工場。種別分岐を持たない。 */
function setupMemoFactory(registry: PluginCompanionRegistry): {
  factory: PluginUiChannelFactory;
  pushes: Map<string, unknown[]>;
  handlers: Map<string, Record<string, (...args: never[]) => unknown>>;
} {
  const pushes = new Map<string, unknown[]>();
  const handlers = new Map<string, Record<string, (...args: never[]) => unknown>>();
  const factory: PluginUiChannelFactory = (view, mountId, kind, env) => {
    void view;
    // 記述子引きだけであり、種別ごとの分岐は持たない。
    const companion = registry.get(kind);
    if (companion === undefined) {
      throw new RangeError("未登録の種別である。");
    }
    handlers.set(mountId, companion.buildRequestHandlers(mountId, env));
    const pushed: unknown[] = [];
    pushes.set(mountId, pushed);
    const channel: PluginUiChannel = {
      push: (message: unknown) => {
        pushed.push(message);
      },
    };
    return channel;
  };
  return { factory, pushes, handlers };
}

/** メモ個体の限定表示の雛形。 */
const MEMO_VIEW: MemoView = {
  instanceId: "memo-instance-1",
  pluginId: "memo",
  portId: "memo",
  localSessionId: "memo-local-1",
  noteCount: 0,
  lastNote: null,
};

test("第三の companion を共通コードの変更なしに登録できる", () => {
  const { registry } = setupMemoRegistry();
  // 登録表から引ける。text/diagnostic と異なる通知名を持つ。
  expect(registry.get("memo")?.pushMessageName).toBe("memoStateChanged");
  // backend ごとの登録表は互いを汚さない。別表には試験用は載らない。
  const other = setupMemoRegistry().registry;
  expect(other.get("memo")?.pushMessageName).toBe("memoStateChanged");
  expect(new PluginCompanionRegistry().get("memo")).toBeUndefined();
  // 未登録種別は引けない。呼び出し側が拒否・回収する。
  expect(registry.get("notregistered")).toBeUndefined();
  // 構文は汎用のまま往復する。既知・未登録の判定は登録表が行う。
  expect(parsePluginMountId(buildPluginBlankUrl("plugin-memo-1"))).toBe("plugin-memo-1");
  expect(pluginMountKindOf("plugin-memo-1")).toBe("memo");
});

test("第三の companion で配置から結線と状態取得と送信 push が通る", async () => {
  const { backend, registry } = setupMemoRegistry();
  backend.memoBindings = [
    { instanceId: "memo-instance-1", localSessionId: "memo-local-1", portId: "memo" },
  ];
  backend.memoViews.set("memo-instance-1", MEMO_VIEW);
  const fakes = setupMemoFactory(registry);
  const coordinator = new PluginUiCoordinator(7, backend, fakes.factory, () => 0, registry);

  // 現割当てに配置を作る。識別子は単調連番で使い回さない。
  expect(coordinator.syncNow()).toBe(true);
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.mountId).toBe("plugin-memo-1");
  expect(placement.kind).toBe("memo");
  expect(placement.initialUrl).toBe(buildPluginBlankUrl("plugin-memo-1"));
  expect(placement.phase).toBe("pending");

  // タグ生成で結線する。読み込む先は companion の view パスである。
  const view = new FakeMemoView(11, 7, placement.initialUrl);
  expect(coordinator.handleTagCreated(view)).toBe(true);
  expect(view.loaded).toEqual([buildPluginViewUrl(MEMO_VIEW_PATH, placement.mountId)]);
  expect(coordinator.listPlacements()[0]?.phase).toBe("bound");

  // 要求表は固有RPCだけを持ち、text/diagnostic の要求名と混ざらない。
  const table = fakes.handlers.get(placement.mountId);
  if (table === undefined) throw new Error("要求表が無い。");
  expect(Object.keys(table).sort()).toEqual(["appendMemo", "getMemoState"]);

  // 状態取得で準備完了になる。読み取りは改訂を進めない。
  const getMemoState = table["getMemoState"] as () => MemoSnapshot;
  const snapshot = getMemoState();
  expect(snapshot.instanceId).toBe("memo-instance-1");
  expect(snapshot.noteCount).toBe(0);
  expect(snapshot.revision).toBe(0);
  expect(coordinator.listPlacements()[0]?.ready).toBe(true);

  // 固有操作が束縛個体の現割当てに届く。識別子の指定口は無い。
  const appendMemo = table["appendMemo"] as (params: { note: string }) => Promise<{
    ok: true;
    count: number;
  }>;
  await expect(appendMemo({ note: "ダミー-001" })).resolves.toEqual({ ok: true, count: 1 });
  expect(backend.appended).toEqual([{ instanceId: "memo-instance-1", note: "ダミー-001" }]);

  // 結線済みの対応付けへ最新状態を送る。改訂は push でのみ進む。
  coordinator.pushBound();
  const pushed = fakes.pushes.get(placement.mountId);
  expect(pushed).toHaveLength(1);
  const message = pushed?.[0] as MemoChangedMessage;
  expect(message.revision).toBe(1);
  expect(message.snapshot.instanceId).toBe("memo-instance-1");
  expect(message.snapshot.revision).toBe(1);
  expect(coordinator.listPlacements()[0]?.revision).toBe(1);

  // 変化が無ければ通知を重ねない。
  const notified = backend.notified;
  expect(coordinator.syncNow()).toBe(false);
  expect(backend.notified).toBe(notified);
});

test("第三の companion の失効はその対応付けに局所化する", () => {
  const { backend, registry } = setupMemoRegistry();
  backend.memoBindings = [
    { instanceId: "memo-instance-1", localSessionId: "memo-local-1", portId: "memo" },
  ];
  backend.memoViews.set("memo-instance-1", MEMO_VIEW);
  const fakes = setupMemoFactory(registry);
  const coordinator = new PluginUiCoordinator(7, backend, fakes.factory, () => 0, registry);
  coordinator.syncNow();
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  coordinator.handleTagCreated(new FakeMemoView(11, 7, placement.initialUrl));

  // 現割当ての失効後の送信 push は対応付けを回収し、失敗表示に回す。
  backend.memoBindings = [];
  coordinator.pushBound();
  expect(fakes.pushes.get(placement.mountId)).toHaveLength(0);
  expect(coordinator.size).toBe(0);
  const failures = coordinator.listFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.kind).toBe("memo");
  expect(failures[0]?.instanceId).toBe("memo-instance-1");
});

test("未登録種別の生成は消費せず呼び出し側に返す", () => {
  const { backend, registry } = setupMemoRegistry();
  const fakes = setupMemoFactory(registry);
  const coordinator = new PluginUiCoordinator(7, backend, fakes.factory, () => 0, registry);
  // 所有も退役も無い未登録種別の生成には触らない。
  const ghost = new FakeMemoView(11, 7, buildPluginBlankUrl("plugin-ghost-9"));
  expect(coordinator.handleTagCreated(ghost)).toBe(false);
  expect(ghost.removed).toBe(false);
  expect(coordinator.size).toBe(0);
});
