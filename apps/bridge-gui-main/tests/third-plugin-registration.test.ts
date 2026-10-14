/**
 * 第三プラグインの新 registrar 経由の登録検証。
 *
 * text/diagnostic と異なる種別・型・RPC（`getMemoState`・`appendMemo`・
 * `memoStateChanged`）を持つメモプラグインを、汎用ホストの変更なしに新
 * registrar へ登録し、種別一覧・割当て・解決 URL と遷移規則の snapshot
 * 配布・配置→結線→状態取得→push・固有操作の解除・未登録種別の拒否までが
 * 通ることを確かめる。`plugin-third-companion.test.ts` が登録表直結の結線
 * 単位を固定するのに対し、ここでは backend 生成（registrar 注入）から
 * coordinator 結線までの解決経路全体を固定する。`plugin-registration.test.ts`
 * が空構成・同梱順・失敗時の回収を固定するのに対し、ここでは第三種別の
 * 追加可能性を固定する（役割分担であり、保証内容の重複削除ではない）。
 *
 * 保証の射程: プラグイン実装（管理記述子・companion factory・固有契約）と
 * 同梱 composition 宣言（＋資産宣言・package dependency・静的同梱宣言。
 * 本試験では解決済み view パス相当の最小宣言で代用する）を追加すれば、
 * 汎用ホスト・共有契約・Angular を変更しなくてよい。試験 fixture 自体は
 * テスト専用であり、実 UI 資産・config 登録は要らない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import type { AssignedSession } from "bridge-app-core/core";
import type { PluginDefinition, PluginInstance } from "bridge-app-core/core";
import type { InstanceBaseView } from "bridge-gui-contract/plugin-instance";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
  buildPluginViewUrl,
} from "bridge-gui-contract/plugin-instance";
import type { GuiPluginAccess } from "bridge-gui-plugin-sdk/management";
import type {
  CompanionRequestEnv,
  PluginCompanion,
  PluginCompanionDeclaration,
} from "bridge-gui-plugin-sdk/companion";
import type { GuiPluginRegistrar } from "bridge-gui-plugin-sdk/registration";
import { createConnectionRequest, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import {
  PluginUiCoordinator,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";

const TEST_ORIGIN = "https://gui-memo-third-test.invalid";

/** 第三種別のトークン。既存種別と重ならない。 */
const MEMO_MOUNT_KIND = "memo";

/** 第三種別の表示名。種別表の登録由来の確認に使う。 */
const MEMO_LABEL = "メモ";

/** 第三子画面の相対 entrypoint。解決の照合材料である。 */
const MEMO_VIEW_ENTRY = "index.html";

/**
 * 第三子画面の解決済み view パス。本番では静的 manifest
 * （`src/composition/bundled-plugin-assets.ts`）の対応付けから導くが、
 * 試験では最小の資産宣言として直置きする。
 */
const MEMO_VIEW_PATH = "views://plugin-memo/index.html";

/** 第三種別の割当て対象の論理名。text 用とは別にする。 */
const MEMO_SESSION_ID = "memo";

/** 第三種別の接続口の識別子。 */
const MEMO_PORT_ID = "main";

/** メモ個体の UI 非依存の状態。件数と直近の写しだけを持つ。 */
interface MemoState {
  /** 追加済みメモの件数。 */
  readonly noteCount: number;
  /** 直近メモの写し。未追加なら `null`。 */
  readonly lastNote: string | null;
}

/** メモ個体のプラグイン固有の操作口。件数の追加だけを持つ。 */
interface MemoOperations {
  /**
   * メモを追加する。
   *
   * @param note - 追加するメモ。空でないこと。
   * @returns 追加後の件数。
   */
  append(note: string): number;
}

/** メモ個体の限定表示。件数と直近の写しだけを持つ。 */
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

/** メモの公開する固有操作。限定口経由の追加だけを持つ。 */
interface MemoManagementOperations {
  /**
   * 束縛個体の現割当てへメモを追加する。
   *
   * @param instanceId - 操作対象の個体識別子。
   * @param note - 追加するメモ。本文の検証は委譲先が行う。
   * @returns 追加後の件数。
   */
  appendNote(instanceId: string, note: unknown): Promise<{ count: number }>;
}

/** 検証用のメモ個体。件数と直近の写しだけを保つ。 */
class MemoInstance implements PluginInstance<MemoState, MemoOperations> {
  private notes: string[] = [];
  private disposed = false;

  attach(portId: string, _session: AssignedSession): void {
    if (portId !== MEMO_PORT_ID) {
      throw new RangeError("不明な接続口である。");
    }
    if (this.disposed) {
      throw new RangeError("破棄済みの個体である。");
    }
  }

  getState(): MemoState {
    return { noteCount: this.notes.length, lastNote: this.notes[this.notes.length - 1] ?? null };
  }

  getOperations(): MemoOperations {
    return {
      append: (note: string) => {
        if (typeof note !== "string" || note.length === 0) {
          throw new RangeError("note は空でない文字列であること。");
        }
        this.notes.push(note);
        return this.notes.length;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** 第三種別の生成元。接続口 `main` で確実配送の双方向だけを受ける。 */
const memoDefinition: PluginDefinition<MemoState, MemoOperations> = {
  pluginId: MEMO_MOUNT_KIND,
  ports: [{ portId: MEMO_PORT_ID, accepts: [{ kind: "reliable", direction: "bidirectional" }] }],
  create: () => new MemoInstance(),
};

/**
 * 第三種別の管理記述子。text/diagnostic と異なる論理名（`memo`）だけを
 * 候補にし、監視はしない。
 */
const memoManagement = {
  kind: MEMO_MOUNT_KIND,
  definition: memoDefinition,
  assignment: {
    maxInstances: 1,
    select(input: {
      readonly request:
        | { readonly mode: "auto" }
        | { readonly mode: "session"; readonly localSessionId: string };
      readonly candidates: readonly {
        readonly localSessionId: string;
        readonly sessionId: string;
        readonly capability: { readonly kind: string; readonly direction: string };
        readonly alive: boolean;
        readonly assignment: unknown;
      }[];
    }): { readonly localSessionId: string; readonly portId: string } {
      const eligible = input.candidates.filter(
        (candidate) =>
          candidate.alive &&
          candidate.assignment === null &&
          candidate.sessionId === MEMO_SESSION_ID &&
          candidate.capability.kind === "reliable" &&
          candidate.capability.direction === "bidirectional",
      );
      if (eligible.length === 0) {
        throw new RangeError("メモ割当ての候補が無い。");
      }
      if (eligible.length > 1) {
        throw new RangeError("メモ割当ての候補が複数ある。");
      }
      const target = eligible[0];
      if (target === undefined) {
        throw new RangeError("メモ割当ての候補が無い。");
      }
      if (
        input.request.mode === "session" &&
        target.localSessionId !== input.request.localSessionId
      ) {
        throw new RangeError("指定した候補と割当て先が一致しない。");
      }
      return { localSessionId: target.localSessionId, portId: MEMO_PORT_ID };
    },
  },
  observation: { mode: "none" as const },
  projectView(input: {
    readonly binding: {
      readonly instanceId: string;
      readonly pluginId: string;
      readonly portId: string;
      readonly localSessionId: string;
    };
    readonly state: MemoState;
  }): MemoView {
    return {
      instanceId: input.binding.instanceId,
      pluginId: input.binding.pluginId,
      portId: input.binding.portId,
      localSessionId: input.binding.localSessionId,
      noteCount: input.state.noteCount,
      lastNote: input.state.lastNote,
    };
  },
  buildOperations(access: {
    withOperations<R>(
      instanceId: string,
      use: (operations: MemoOperations, binding: { readonly instanceId: string }) => R,
    ): R;
  }): MemoManagementOperations {
    return {
      appendNote(instanceId: string, note: unknown): Promise<{ count: number }> {
        if (typeof note !== "string" || note.length === 0) {
          throw new RangeError("note は空でない文字列であること。");
        }
        const body = note;
        const count = access.withOperations(instanceId, (operations) => operations.append(body));
        return Promise.resolve({ count });
      },
    };
  },
};

/**
 * 第三 companion の解決前の宣言を組み立てる。`GuiPluginAccess` を capture
 * し、backend 引数は持たない。
 *
 * @param access - 管理層が返す種別の公開参照口。
 * @returns 解決前の宣言（振る舞いと相対 entrypoint）。
 */
function createMemoDeclaration(
  access: GuiPluginAccess<MemoView, MemoManagementOperations>,
): PluginCompanionDeclaration {
  return {
    kind: MEMO_MOUNT_KIND,
    label: MEMO_LABEL,
    viewEntry: MEMO_VIEW_ENTRY,
    listDesired() {
      return access.listBindings().map((binding) => ({
        instanceId: binding.instanceId,
        localSessionId: binding.localSessionId,
        portId: binding.portId,
      }));
    },
    readView(instanceId: string): InstanceBaseView {
      return access.readView(instanceId);
    },
    toSnapshot(view: InstanceBaseView, revision: number): unknown {
      // ADR: `as` を使う理由は、同じ companion の `readView` が作った表示に
      // 改訂番号だけを付けるためである。根拠は、対応付けが同一種別の記述子で
      // 読み・付番を対にすることである。
      const typed = view as MemoView;
      const snapshot: MemoSnapshot = { ...typed, revision };
      return snapshot;
    },
    send(instanceId: string, params: unknown): Promise<unknown> {
      // ADR: `as` を使う理由は、操作引数の形状を companion が固定するためである。
      // 根拠は、要求表の `appendMemo` がメモだけを渡すことである。本文の検証は
      // 委譲先（固有操作）が行う。
      const table = params as { note: unknown };
      return access.operations.appendNote(instanceId, table.note);
    },
    pushMessageName: "memoStateChanged",
    buildRequestHandlers(mountId: string, env: CompanionRequestEnv) {
      return {
        getMemoState: () => {
          const snapshot = env.readSnapshot(MEMO_MOUNT_KIND, mountId);
          // ADR: `as` を使う理由は上記と同様であり、対応付けが同一種別の
          // 記述子で読んだ表示を返すためである。
          const typed = snapshot as MemoSnapshot;
          env.markReady(mountId);
          return typed;
        },
        appendMemo: (params: { note: string }) => {
          const result = env.send(MEMO_MOUNT_KIND, mountId, params);
          // ADR: `as` を使う理由は上記と同様であり、委譲先の解決型を保つためである。
          return result as Promise<{ count: number }>;
        },
      };
    },
  };
}

/**
 * 解決前の宣言に解決済み view パスを付与する。本番では静的 manifest と
 * 照合するが、試験では最小の資産宣言として相対名の一致だけを確かめる。
 *
 * @param declaration - companion factory が返した解決前の宣言。
 * @returns 登録表に載せる解決済みの記述子。
 */
function resolveMemoCompanion(declaration: PluginCompanionDeclaration): PluginCompanion {
  if (declaration.kind !== MEMO_MOUNT_KIND || declaration.viewEntry !== MEMO_VIEW_ENTRY) {
    throw new RangeError("メモの資産宣言と一致しない。");
  }
  const { viewEntry: _viewEntry, ...behavior } = declaration;
  void _viewEntry;
  return { ...behavior, viewPath: MEMO_VIEW_PATH };
}

/**
 * 第三プラグインを新 registrar へ登録する。本番の同梱追加ではこの関数相当の
 * composition 宣言（＋資産宣言・package dependency・静的同梱宣言）を足す。
 *
 * @param registrar - backend が渡す汎用の登録口。
 */
function registerMemoPlugin(registrar: GuiPluginRegistrar): void {
  registrar.registerPlugin({
    // ADR: 記述子リテラルの型付けに推論を使う理由は、試験 fixture の記述子が
    // 登録単位の型引数（状態・操作・表示・公開操作）をその場で固定するためで
    // ある。根拠は、汎用の `registerPlugin` が型引数ごとに受け付けることである。
    management: memoManagement,
    createCompanion: (access) =>
      resolveMemoCompanion(
        createMemoDeclaration(access as GuiPluginAccess<MemoView, MemoManagementOperations>),
      ),
  });
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

/**
 * 登録表駆動の偽チャネル工場。種別分岐を持たない。
 *
 * @param registry - backend が生成した登録表。
 */
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

const backends: GuiBackend[] = [];
const providers: SessionProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 受付→承認まで進める。
 *
 * 両方の約束に扱いを付け、未処理の拒否を残さない。
 */
async function approveConnection(backend: GuiBackend): Promise<SessionProvider> {
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({
    endpoint: endpoint.url,
    origin: TEST_ORIGIN,
  });
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  const approved = backend.approvePairing({ requestId: pairing.requestId });
  expect(approved.status).toBe("APPROVED");
  const provider = await request.sessionProvider;
  providers.push(provider);
  return provider;
}

test("第三種別が登録由来で種別一覧に載り解決済みURLと遷移規則がsnapshotで配布される", async () => {
  const backend = await GuiBackend.create(
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
    { registerPlugins: registerMemoPlugin },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  // 種別表は composition の別途列挙ではなく登録内容から生成される。
  expect(backend.getSnapshot().plugins.kinds).toEqual([
    { pluginKind: MEMO_MOUNT_KIND, pluginId: MEMO_MOUNT_KIND, label: MEMO_LABEL, maxInstances: 1 },
  ]);
  const companion = backend.companionRegistry.get(MEMO_MOUNT_KIND);
  expect(companion?.label).toBe(MEMO_LABEL);
  expect(companion?.viewPath).toBe(MEMO_VIEW_PATH);
  expect(companion?.pushMessageName).toBe("memoStateChanged");
  // 解決 URL と遷移規則は登録済みの解決済み view パスから生成し、snapshot で配布される。
  expect(backend.getSnapshot().pluginNavigationRules).toEqual(
    buildPluginNavigationRules([MEMO_VIEW_PATH]),
  );
  expect(backend.getSnapshot().pluginNavigationRules).toContain("views://plugin-memo/*");
});

test("第三種別の割当てと固有操作と解除が通り未登録種別を拒否する", async () => {
  const backend = await GuiBackend.create(
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
    { registerPlugins: registerMemoPlugin },
  );
  backends.push(backend);
  backend.enableAcceptance();
  // 候補が無ければ割当てを拒否する。
  expect(() => backend.assignPlugin({ pluginKind: MEMO_MOUNT_KIND })).toThrowError(RangeError);
  expect(() => backend.assignPlugin({ pluginKind: "ghost" })).toThrowError(RangeError);

  const provider = await approveConnection(backend);
  await waitForArrival(() => backend.getSnapshot().sessions.length >= 0, "接続の公開");
  const before = backend.getSnapshot().sessions.length;
  await provider.tryCreateSession({
    sessionId: MEMO_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );

  // 割当てが通り、companion が生成される。
  const assignment = backend.assignPlugin({ pluginKind: MEMO_MOUNT_KIND });
  expect(assignment.pluginKind).toBe(MEMO_MOUNT_KIND);
  expect(assignment.portId).toBe(MEMO_PORT_ID);
  const companion = backend.companionRegistry.get(MEMO_MOUNT_KIND);
  if (companion === undefined) throw new Error("メモ companion が無い。");
  // ADR: `as` を使う理由は、汎用口が種別を問わない表示を返し、試験で
  // 束縛種別の具象表示を取り出すためである。根拠は、対応付けが同一種別の
  // 記述子で読み・付番を対にすることである。
  const view = companion.readView(assignment.instanceId) as MemoView;
  expect(view.noteCount).toBe(0);
  expect(view.lastNote).toBeNull();
  // 固有操作が束縛個体の現割当てに届く。
  const send = companion.send;
  if (send === undefined) throw new Error("メモの送信口が無い。");
  await expect(send(assignment.instanceId, { note: "ダミー-001" })).resolves.toEqual({ count: 1 });
  expect((companion.readView(assignment.instanceId) as MemoView).noteCount).toBe(1);
  expect((companion.readView(assignment.instanceId) as MemoView).lastNote).toBe("ダミー-001");
  // 不正な引数は送らず、件数を進めない。
  expect(() => send(assignment.instanceId, { note: "" })).toThrowError(RangeError);
  expect((companion.readView(assignment.instanceId) as MemoView).noteCount).toBe(1);

  // 固有操作の解除が通る。
  const released = backend.unassignPlugin({
    instanceId: assignment.instanceId,
    localSessionId: assignment.localSessionId,
    portId: assignment.portId,
  });
  expect(released).toEqual({ released: true, issues: [] });
  expect(
    backend.getSnapshot().plugins.instances.find((item) => item.pluginKind === MEMO_MOUNT_KIND),
  ).toBeUndefined();
  expect(() => companion.readView(assignment.instanceId)).toThrowError(RangeError);
  // 未登録種別は拒否される。
  expect(() => backend.assignPlugin({ pluginKind: "ghost" })).toThrowError(RangeError);
  expect(backend.companionRegistry.get("ghost")).toBeUndefined();
});

test("第三種別で配置から結線と状態取得と送信pushが通る", async () => {
  const backend = await GuiBackend.create(
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
    { registerPlugins: registerMemoPlugin },
  );
  backends.push(backend);
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const before = backend.getSnapshot().sessions.length;
  await provider.tryCreateSession({
    sessionId: MEMO_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
  const assignment = backend.assignPlugin({ pluginKind: MEMO_MOUNT_KIND });

  // 新 registrar の解決経路で作った登録表を coordinator へ注入する。
  const registry = backend.companionRegistry;
  const fakes = setupMemoFactory(registry);
  const coordinator = new PluginUiCoordinator(7, backend, fakes.factory, () => 0, registry);

  // 現割当てに配置を作る。識別子は単調連番で使い回さない。
  expect(coordinator.syncNow()).toBe(true);
  const placement = coordinator.listPlacements()[0];
  if (placement === undefined) throw new Error("配置が無い。");
  expect(placement.mountId).toBe("plugin-memo-1");
  expect(placement.kind).toBe(MEMO_MOUNT_KIND);
  expect(placement.initialUrl).toBe(buildPluginBlankUrl("plugin-memo-1"));
  expect(placement.phase).toBe("pending");
  expect(placement.instanceId).toBe(assignment.instanceId);

  // タグ生成で結線する。読み込む先は companion の解決済み view パスである。
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
  expect(snapshot.instanceId).toBe(assignment.instanceId);
  expect(snapshot.noteCount).toBe(0);
  expect(snapshot.revision).toBe(0);
  expect(coordinator.listPlacements()[0]?.ready).toBe(true);

  // 固有操作が束縛個体の現割当てに届く。識別子の指定口は無い。
  const appendMemo = table["appendMemo"] as (params: { note: string }) => Promise<{
    count: number;
  }>;
  await expect(appendMemo({ note: "ダミー-002" })).resolves.toEqual({ count: 1 });

  // 結線済みの対応付けへ最新状態を送る。改訂は push でのみ進む。
  coordinator.pushBound();
  const pushed = fakes.pushes.get(placement.mountId);
  expect(pushed).toHaveLength(1);
  const message = pushed?.[0] as MemoChangedMessage;
  expect(message.revision).toBe(1);
  expect(message.snapshot.instanceId).toBe(assignment.instanceId);
  expect(message.snapshot.revision).toBe(1);
  expect(message.snapshot.noteCount).toBe(1);
  expect(coordinator.listPlacements()[0]?.revision).toBe(1);
});
