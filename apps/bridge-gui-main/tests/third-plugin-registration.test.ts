/**
 * 第三プラグインの新 registrar 経由の登録検証。
 *
 * text/diagnostic と異なる種別・型・中継（`getMemoState`・`appendMemo`・
 * `memoStateChanged`）を持つメモプラグインを、汎用ホストの変更なしに新
 * registrar へ登録し、種別一覧・割当て・解決 URL と遷移規則の snapshot
 * 配布・配置→結線→中継までが通ることを確かめる。
 * `plugin-third-companion.test.ts` が登録表直結の結線単位を固定するのに対し、
 * ここでは backend 生成（registrar 注入）から coordinator 結線までの解決経路
 * 全体を固定する。`plugin-registration.test.ts` が空構成・同梱順・失敗時の
 * 回収を固定するのに対し、ここでは第三種別の追加可能性を固定する（役割分担で
 * あり、保証内容の重複削除ではない）。
 *
 * 保証の射程: プラグイン実装（管理記述子・companion 宣言・endpoint 工場）と
 * 同梱 composition 宣言（＋資産宣言・package dependency・静的同梱宣言。
 * 本試験では解決済み view パス相当の最小宣言で代用する）を追加すれば、
 * 汎用ホスト・共有契約・Angular を変更しなくてよい。試験 fixture 自体は
 * テスト専用であり、実 UI 資産・config 登録は要らない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import type { PluginDefinition, PluginInstance } from "bridge-app-core/core";
import {
  buildPluginBlankUrl,
  buildPluginNavigationRules,
  buildPluginViewUrl,
  type PluginRelayResult,
} from "bridge-gui-contract/plugin-instance";
import type { PluginEmissionPort, PluginEndpoint } from "bridge-gui-plugin-sdk/companion";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";
import type { GuiPluginRegistrar } from "bridge-gui-plugin-sdk/registration";
import { GuiBackend } from "../src/main/backend.ts";
import { PluginCompanionRegistry } from "../src/main/plugin-companions.ts";
import {
  PluginUiCoordinator,
  type PluginUiChannel,
  type PluginUiChannelFactory,
  type PluginUiChildView,
} from "../src/main/plugin-ui-mounts.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import { setupFixture, makeSession } from "./plugin-instance-manager-fakes.ts";

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

/** メモ個体の UI 非依存の状態。件数だけを持つ。 */
interface MemoState {
  /** 追加済みメモの件数。 */
  readonly noteCount: number;
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

/** 検証用のメモ個体。 */
class FakeMemoInstance implements PluginInstance<MemoState, MemoOperations> {
  private count = 0;
  attach(portId: string): void {
    if (portId !== MEMO_PORT_ID) {
      throw new RangeError("不明な接続口である。");
    }
  }
  getState(): MemoState {
    return { noteCount: this.count };
  }
  getOperations(): MemoOperations {
    return {
      append: (note: string) => {
        if (note.length === 0) {
          throw new RangeError("note は空でない文字列であること。");
        }
        this.count += 1;
        return this.count;
      },
    };
  }
  dispose(): void {}
}

/** 第三種別の生成元。 */
const memoDefinition: PluginDefinition<MemoState, MemoOperations> = {
  pluginId: "memo",
  ports: [
    {
      portId: MEMO_PORT_ID,
      accepts: [{ kind: "reliable", direction: "bidirectional" }],
    },
  ],
  create: () => new FakeMemoInstance(),
};

/**
 * 第三種別の登録関数。管理記述子・companion 宣言・endpoint 工場の組である。
 * 汎用ホストの変更なしに登録できることの材料である。
 *
 * @param registrar - backend が渡す汎用の登録口。
 */
function registerMemoPlugin(registrar: GuiPluginRegistrar): void {
  registrar.registerPlugin<MemoState, MemoOperations>({
    management: {
      kind: MEMO_MOUNT_KIND,
      definition: memoDefinition,
      assignment: {
        maxInstances: null,
        select: ({ request, candidates }) => {
          const eligible = candidates.filter(
            (candidate) =>
              candidate.alive &&
              candidate.assignment === null &&
              candidate.sessionId === MEMO_SESSION_ID &&
              candidate.capability.kind === "reliable" &&
              candidate.capability.direction === "bidirectional",
          );
          if (request.mode === "session") {
            const found = eligible.find(
              (candidate) => candidate.localSessionId === request.localSessionId,
            );
            if (found === undefined) {
              throw new RangeError("指定した候補が使えない。");
            }
            return { localSessionId: found.localSessionId, portId: MEMO_PORT_ID };
          }
          if (eligible.length !== 1) {
            throw new RangeError("一意な割当て候補が無い。");
          }
          const only = eligible[0];
          if (only === undefined) {
            throw new RangeError("一意な割当て候補が無い。");
          }
          return { localSessionId: only.localSessionId, portId: MEMO_PORT_ID };
        },
      },
    },
    companion: { kind: MEMO_MOUNT_KIND, label: MEMO_LABEL, viewEntry: MEMO_VIEW_ENTRY },
    createEndpoint(
      ref: BoundPluginRef<MemoState, MemoOperations>,
      emission: PluginEmissionPort,
    ): PluginEndpoint {
      let disposed = false;
      return {
        async handleRequest(request): Promise<unknown> {
          if (disposed) {
            throw new Error("終了済みの endpoint である。");
          }
          if (request.method === "getMemoState") {
            const state = ref.readState();
            const binding = ref.getBinding();
            return { instanceId: binding.instanceId, noteCount: state.noteCount };
          }
          if (request.method === "appendMemo") {
            const params = request.params as { note: unknown };
            if (typeof params.note !== "string" || params.note.length === 0) {
              return { error: "note は空でない文字列であること。" };
            }
            const count = ref.withOperations((operations) =>
              operations.append(params.note as string),
            );
            emission.emit({ event: "memoStateChanged", payload: { noteCount: count } });
            return { count };
          }
          return { error: `未知の要求である: ${request.method}` };
        },
        dispose(): void {
          disposed = true;
        },
      };
    },
  });
}

const backends: GuiBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

/** 検証用の偽子画面。 */
class FakeView implements PluginUiChildView {
  removed = false;
  loaded: string[] = [];
  constructor(
    readonly viewId: number,
    readonly hostWebviewId: number | undefined,
    readonly currentUrl: string | null,
    readonly renderer = "native",
    readonly sandbox = false,
    readonly preload: string | null = null,
    // 省略時は静的登録の期待規則と一致する正規値を載せる。
    readonly navigationRules: string | null = JSON.stringify(
      buildPluginNavigationRules([MEMO_VIEW_PATH]),
    ),
  ) {}
  loadPluginUrl(url: string): void {
    this.loaded.push(url);
  }
  removeView(): void {
    this.removed = true;
  }
}

test("第三種別は汎用ホストの変更なしに登録できる", async () => {
  const backend = await GuiBackend.create(
    { port: 0 },
    {
      registerPlugins: registerMemoPlugin,
      resolvePluginViewPath: (kind, viewEntry) => {
        expect(kind).toBe(MEMO_MOUNT_KIND);
        expect(viewEntry).toBe(MEMO_VIEW_ENTRY);
        return MEMO_VIEW_PATH;
      },
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  // 種別表は登録内容から生成される。
  expect(backend.getSnapshot().plugins.kinds).toEqual([
    { pluginKind: MEMO_MOUNT_KIND, pluginId: "memo", label: MEMO_LABEL, maxInstances: null },
  ]);
  // 解決済み view パスが登録表に載り、遷移規則に配布される。
  expect(backend.companionRegistry.getCompanion(MEMO_MOUNT_KIND)?.viewPath).toBe(MEMO_VIEW_PATH);
  expect(backend.getSnapshot().pluginNavigationRules).toEqual(
    buildPluginNavigationRules([MEMO_VIEW_PATH]),
  );
  // 配置 URL の組立ては汎用の共有手段で行う。
  expect(buildPluginViewUrl(MEMO_VIEW_PATH, "plugin-memo-1")).toBe(
    `${MEMO_VIEW_PATH}#mount=plugin-memo-1`,
  );
  expect(buildPluginBlankUrl("plugin-memo-1")).toBe(
    "views://plugin-host/blank.html#mount=plugin-memo-1",
  );
});

test("第三種別の endpoint は表示要求駆動の結線で中継できる", async () => {
  const fixture = setupFixture([
    makeSession("local-1", "conn-a", MEMO_SESSION_ID, {
      kind: "reliable",
      direction: "bidirectional",
    }),
  ]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  const registry = new PluginCompanionRegistry();
  const registrar: GuiPluginRegistrar = {
    registerPlugin: (registration) => {
      manager.register(registration.management);
      const viewPath = MEMO_VIEW_PATH;
      registry.register({ ...registration.companion, viewPath }, (ref, emission) =>
        registration.createEndpoint(
          ref as Parameters<typeof registration.createEndpoint>[0],
          emission,
        ),
      );
    },
  };
  registerMemoPlugin(registrar);
  const binding = manager.assign(MEMO_MOUNT_KIND);
  const relays = new Map<string, (request: unknown) => Promise<PluginRelayResult>>();
  const pushes: unknown[] = [];
  const factory: PluginUiChannelFactory = (_view, mountId, onRelay) => {
    relays.set(mountId, onRelay);
    const channel: PluginUiChannel = {
      push: (event) => {
        pushes.push(event);
      },
    };
    return channel;
  };
  let view: { instanceId: string | null; viewGeneration: number } = {
    instanceId: binding.instanceId,
    viewGeneration: 1,
  };
  const coordinator = new PluginUiCoordinator(
    7,
    { notifyExternalChange: () => {} },
    factory,
    Date.now,
    registry,
    manager,
    () => ({ ...view }),
  );
  expect(coordinator.syncNow()).toBe(true);
  const placements = coordinator.listPlacements();
  expect(placements).toHaveLength(1);
  const placement = placements[0];
  if (placement === undefined) throw new Error("配置が無い。");
  coordinator.handleTagCreated(new FakeView(11, 7, placement.initialUrl));
  const relay = relays.get(placement.mountId);
  if (relay === undefined) throw new Error("中継口が無い。");
  const got = (await relay({ method: "getMemoState", params: {} })) as PluginRelayResult;
  expect(got.ok).toBe(true);
  expect(coordinator.listPlacements()[0]?.pluginResponded).toBe(true);
  const appended = (await relay({
    method: "appendMemo",
    params: { note: "メモ1" },
  })) as PluginRelayResult;
  expect(appended.ok).toBe(true);
  expect(pushes).toHaveLength(1);
  void view;
});
