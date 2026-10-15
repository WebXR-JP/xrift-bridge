/**
 * 汎用プラグイン・インスタンス管理層の振る舞い検証。
 *
 * 偽 core・偽セッションで割当て手続き・照合・回収・終了と束縛個体限定の
 * 参照口を確かめる。具象プラグインの import は置かず、合成 `alpha`・`beta`
 * だけを使う。表示内容の射影・監視方式・固有操作の汎用表は持たない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  alphaDescriptor,
  betaDescriptor,
  firstFitPolicy,
  makeSession,
  RELIABLE_BIDI,
  setupFixture,
  uniquePolicy,
  type AlphaOperations,
  type AlphaState,
  type ManagerFixture,
} from "./plugin-instance-manager-fakes.ts";

/**
 * 監視なしの `alpha` を登録した管理層を作る。
 *
 * @param fixture - 検証用の組み立て。
 * @param maxInstances - 同時所有の上限。
 * @returns 管理層。
 */
function setupAlpha(
  fixture: ManagerFixture,
  maxInstances: number | null = null,
): PluginInstanceManager {
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(maxInstances) }));
  return manager;
}

test("接続をまたいだ一意な候補を選べる（selects_unique_candidate_across_connections）", () => {
  const fixture = setupFixture([
    makeSession("local-1", "conn-a"),
    makeSession("local-2", "conn-b"),
    makeSession("local-3", "conn-a"),
  ]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: uniquePolicy(null) }));
  // 所有外の割当てで2件を塞ぎ、一意な候補だけを残す。
  const first = fixture.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null) }).definition,
  );
  const second = fixture.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null) }).definition,
  );
  fixture.core.assign("local-2", first.instanceId, "main");
  fixture.core.assign("local-3", second.instanceId, "main");
  const binding = manager.assign("alpha");
  expect(binding.localSessionId).toBe("local-1");
  expect(binding.portId).toBe("main");
  expect(binding.kind).toBe("alpha");
  expect(binding.pluginId).toBe("alpha");
  expect(manager.listBindings("alpha")).toHaveLength(1);
});

test("不正な割当て先は生成前に拒否する（rejects_invalid_policy_target_before_creation）", () => {
  const cases: Array<{
    name: string;
    target: { readonly localSessionId: string; readonly portId: string };
    sessions: ReturnType<typeof makeSession>[];
  }> = [
    {
      name: "候補に無い",
      target: { localSessionId: "ghost", portId: "main" },
      sessions: [makeSession("local-1", "conn-a")],
    },
    {
      name: "生存していない",
      target: { localSessionId: "local-1", portId: "main" },
      sessions: [makeSession("local-1", "conn-a", "session", RELIABLE_BIDI, false)],
    },
    {
      name: "定義に無い接続口",
      target: { localSessionId: "local-1", portId: "ghost-port" },
      sessions: [makeSession("local-1", "conn-a")],
    },
    {
      name: "適合しない接続口",
      target: { localSessionId: "local-1", portId: "main" },
      sessions: [
        makeSession("local-1", "conn-a", "session", { kind: "latest", direction: "to_server" }),
      ],
    },
  ];
  for (const kase of cases) {
    const fixture = setupFixture(kase.sessions);
    const manager = new PluginInstanceManager(fixture.dependencies);
    manager.register(
      alphaDescriptor({
        assignment: {
          maxInstances: null,
          select: () => kase.target,
        },
      }),
    );
    expect(() => manager.assign("alpha"), kase.name).toThrow(RangeError);
    expect(fixture.core.calls, kase.name).not.toContain("createInstance");
    expect(fixture.core.instances.size, kase.name).toBe(0);
    expect(manager.listOwned(), kase.name).toHaveLength(0);
  }
  // 割当て済みの候補も生成前に拒否する。
  const assigned = setupFixture([makeSession("local-1", "conn-a")]);
  const assignedManager = new PluginInstanceManager(assigned.dependencies);
  assignedManager.register(
    alphaDescriptor({
      assignment: {
        maxInstances: null,
        select: () => ({ localSessionId: "local-1", portId: "main" }),
      },
    }),
  );
  const foreign = assigned.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null) }).definition,
  );
  assigned.core.assign("local-1", foreign.instanceId, "main");
  const before = assigned.core.countCalls("createInstance");
  expect(() => assignedManager.assign("alpha")).toThrow(RangeError);
  expect(assigned.core.countCalls("createInstance")).toBe(before);
});

test("個体数の上限を守る（enforces_instance_limit）", () => {
  const fixture = setupFixture([
    makeSession("local-1", "conn-a"),
    makeSession("local-2", "conn-a"),
    makeSession("local-3", "conn-a"),
  ]);
  const manager = setupAlpha(fixture, 1);
  const first = manager.assign("alpha");
  expect(first.localSessionId).toBe("local-1");
  expect(() => manager.assign("alpha")).toThrow(RangeError);
  expect(manager.listOwned()).toHaveLength(1);
  // 回収失敗で残った個体も上限に算入し、再利用しない。
  fixture.core.failRemove = new Error("削除に失敗した。");
  const released = manager.unassign("alpha", first.instanceId);
  expect(released.released).toBe(true);
  expect(manager.listOwned()[0]?.phase).toBe("cleanupFailed");
  expect(() => manager.assign("alpha")).toThrow(RangeError);
});

test("割当て後に確定する（commits_after_assignment）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const changedBefore = fixture.changed.count;
  const binding = manager.assign("alpha");
  expect(manager.listOwned()).toEqual([{ ...binding, phase: "active" }]);
  expect(manager.requireBinding("alpha", binding.instanceId)).toEqual(binding);
  expect(manager.listBindings("alpha")).toEqual([binding]);
  expect(fixture.changed.count).toBe(changedBefore + 1);
  expect(fixture.core.listAssignments()).toEqual([
    { localSessionId: "local-1", instanceId: binding.instanceId, portId: "main" },
  ]);
});

test("生成・割当ての失敗を巻き戻す（rolls_back_creation_and_assignment_failures）", () => {
  // 生成の失敗では何も残さない。
  const created = setupFixture([makeSession("local-1", "conn-a")]);
  const createdManager = setupAlpha(created);
  created.core.failCreate = new Error("生成に失敗した。");
  expect(() => createdManager.assign("alpha")).toThrow("生成に失敗した。");
  expect(created.core.instances.size).toBe(0);
  expect(created.core.assignments.size).toBe(0);
  expect(createdManager.listOwned()).toHaveLength(0);
  // 割当ての失敗では生成分を回収する。
  const assigned = setupFixture([makeSession("local-1", "conn-a")]);
  const assignedManager = setupAlpha(assigned);
  assigned.core.failAssign = new Error("割当てに失敗した。");
  expect(() => assignedManager.assign("alpha")).toThrow("割当てに失敗した。");
  expect(assigned.core.instances.size).toBe(0);
  expect(assigned.core.assignments.size).toBe(0);
  expect(assignedManager.listOwned()).toHaveLength(0);
});

test("同期の終了で初期化を無効化する（invalidates_initialization_on_synchronous_end）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  fixture.core.onAssignSync = () => {
    // core 操作に伴う終了通知を同期に受ける。現割当ても同時に失効する。
    fixture.core.revokeSilently("local-1");
    fixture.sessions.emitEnded("local-1");
  };
  expect(() => manager.assign("alpha")).toThrow(RangeError);
  expect(manager.listOwned()).toHaveLength(0);
  expect(manager.listBindings("alpha")).toHaveLength(0);
  expect(fixture.core.instances.size).toBe(0);
  expect(fixture.core.assignments.size).toBe(0);
});

test("core の無音取消しを照合で回収する（reclaims_after_core_has_revoked_assignment）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const binding = manager.assign("alpha");
  fixture.core.revokeSilently("local-1");
  // 読み取りは拒否するが、回収の副作用は付けない。
  expect(manager.listBindings("alpha")).toHaveLength(0);
  expect(() => manager.requireBinding("alpha", binding.instanceId)).toThrow(RangeError);
  expect(manager.listOwned()).toHaveLength(1);
  const removedBefore = fixture.core.countCalls("removeInstance");
  manager.reconcile();
  expect(fixture.core.countCalls("removeInstance")).toBe(removedBefore + 1);
  expect(manager.listOwned()).toHaveLength(0);
  // 完全一致する割当てが無いため、よその解除はしない。
  expect(fixture.core.calls.filter((call) => call.startsWith("unassign"))).toHaveLength(0);
});

test("再入の終了でも一度だけ解放する（releases_once_during_reentrant_end）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const binding = manager.assign("alpha");
  fixture.core.onUnassignSync = () => {
    fixture.sessions.emitEnded("local-1");
  };
  const result = manager.unassign("alpha", binding.instanceId);
  expect(result.released).toBe(true);
  expect(fixture.core.countCalls("unassign:local-1")).toBe(1);
  expect(fixture.core.countCalls(`removeInstance:${binding.instanceId}`)).toBe(1);
  expect(manager.listOwned()).toHaveLength(0);
  expect(manager.unassign("alpha", binding.instanceId)).toEqual({ released: false, issues: [] });
});

test("束縛個体限定の参照口は各利用時に照合する", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const binding = manager.assign("alpha");
  const ref = manager.createBoundRef<AlphaState, AlphaOperations>("alpha", binding.instanceId);
  expect(ref.getBinding()).toEqual(binding);
  expect(ref.readState()).toEqual({ count: 0 });
  expect(ref.withOperations((operations) => operations.add(2))).toBe(2);
  expect(ref.readState()).toEqual({ count: 2 });
  // 失効後は参照口の各利用で拒否する。
  fixture.sessions.emitEnded("local-1");
  expect(() => ref.getBinding()).toThrow(RangeError);
  expect(() => ref.readState()).toThrow(RangeError);
  expect(() => ref.withOperations((operations) => operations.add(1))).toThrow(RangeError);
});

test("参照口は対象識別子を引数に取らない", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const binding = manager.assign("alpha");
  const ref = manager.createBoundRef<AlphaState, AlphaOperations>("alpha", binding.instanceId);
  const surface = ref as unknown as Record<string, unknown>;
  expect(surface["getBinding"]).toBeDefined();
  expect(surface["readState"]).toBeDefined();
  expect(surface["withOperations"]).toBeDefined();
  // 到達口・管理 backend・全個体一覧は渡さない。
  expect(surface["requireBinding"]).toBeUndefined();
  expect(surface["listBindings"]).toBeUndefined();
  expect(surface["manager"]).toBeUndefined();
});

test("古い読取りを拒否する（rejects_stale_reads）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  const binding = manager.assign("alpha");
  fixture.sessions.emitEnded("local-1");
  expect(manager.listOwned()).toHaveLength(0);
  expect(manager.listBindings("alpha")).toHaveLength(0);
  expect(() => manager.requireBinding("alpha", binding.instanceId)).toThrow(RangeError);
  expect(() => manager.createBoundRef("alpha", binding.instanceId).getBinding()).toThrow(
    RangeError,
  );
});

test("よその割当てを解除しない（does_not_unassign_foreign_binding）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  manager.register(betaDescriptor({ assignment: firstFitPolicy(null) }));
  const binding = manager.assign("alpha");
  // 同セッションに別個体の割当てが載った。回収で触らない。
  const foreign = fixture.core.createInstance(
    betaDescriptor({ assignment: firstFitPolicy(null) }).definition,
  );
  fixture.core.plantForeign("local-1", foreign.instanceId, "main");
  const result = manager.unassign("alpha", binding.instanceId);
  expect(result.released).toBe(true);
  expect(fixture.core.calls.filter((call) => call.startsWith("unassign"))).toHaveLength(0);
  expect(fixture.core.countCalls(`removeInstance:${binding.instanceId}`)).toBe(1);
  expect(fixture.core.assignments.get("local-1")?.instanceId).toBe(foreign.instanceId);
  expect(manager.listOwned()).toHaveLength(0);
});

test("清掃の失敗を報告して続ける（reports_cleanup_failures_and_continues）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const binding = manager.assign("alpha");
  fixture.core.failUnassign = new Error("割当ての解除に失敗した。");
  fixture.core.failRemove = new Error("削除に失敗した。");
  const result = manager.unassign("alpha", binding.instanceId);
  expect(result.released).toBe(true);
  expect(result.issues.map((issue) => issue.stage)).toEqual(["unassign", "remove-instance"]);
  expect(fixture.issues.map((issue) => issue.stage)).toEqual(["unassign", "remove-instance"]);
  // 途中失敗で後続を止めず、失敗した個体は残して再利用しない。
  expect(fixture.core.countCalls("removeInstance")).toBe(1);
  expect(manager.listOwned()[0]?.phase).toBe("cleanupFailed");
  expect(manager.listBindings("alpha")).toHaveLength(0);
  expect(manager.unassign("alpha", binding.instanceId)).toEqual({ released: false, issues: [] });
});

test("終了は冪等で core を閉じない（closes_idempotently_without_closing_core）", () => {
  const fixture = setupFixture([
    makeSession("local-1", "conn-a"),
    makeSession("local-2", "conn-b"),
  ]);
  const manager = setupAlpha(fixture);
  manager.assign("alpha");
  manager.assign("alpha", { mode: "session", localSessionId: "local-2" });
  // 上限なしのため2件所有できる。
  expect(manager.listOwned()).toHaveLength(2);
  manager.close();
  expect(manager.listOwned()).toHaveLength(0);
  expect(fixture.core.instances.size).toBe(0);
  // 二度目は副作用なしで、終了通知の購読だけ外す。
  const callsAfterFirst = fixture.core.calls.length;
  manager.close();
  expect(fixture.core.calls.length).toBe(callsAfterFirst);
  expect(fixture.sessions.stops).toBe(1);
  expect(fixture.core.closedByManager).toBe(false);
  expect(() => manager.assign("alpha")).toThrow(Error);
  fixture.sessions.emitEnded("local-1");
  expect(manager.listOwned()).toHaveLength(0);
});

test("session指定と異なる選択結果は生成前に拒否する", () => {
  const fixture = setupFixture([
    makeSession("local-1", "conn-a"),
    makeSession("local-2", "conn-a"),
  ]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({
      assignment: {
        maxInstances: null,
        select: () => ({ localSessionId: "local-2", portId: "main" }),
      },
    }),
  );
  expect(() => manager.assign("alpha", { mode: "session", localSessionId: "local-1" })).toThrow(
    RangeError,
  );
  expect(fixture.core.calls).not.toContain("createInstance");
  expect(fixture.core.instances.size).toBe(0);
  expect(manager.listOwned()).toHaveLength(0);
});

test("初期化失敗の補償ではよその割当てを解除しない", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlpha(fixture);
  const foreign = fixture.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null) }).definition,
  );
  fixture.core.onAssignSync = () => {
    // 割当て直後に同セッションが別個体で上書きされた。確定の再確認で
    // 不一致となり、補償では触らない。
    fixture.core.plantForeign("local-1", foreign.instanceId, "main");
  };
  expect(() => manager.assign("alpha")).toThrow(RangeError);
  expect(fixture.core.calls.filter((call) => call.startsWith("unassign"))).toHaveLength(0);
  expect(fixture.core.assignments.get("local-1")?.instanceId).toBe(foreign.instanceId);
  expect(manager.listOwned()).toHaveLength(0);
});

test("登録の重複と形式外と未登録の操作を拒否する", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  expect(() => manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }))).toThrow(
    Error,
  );
  expect(() =>
    manager.register({
      ...alphaDescriptor({ assignment: firstFitPolicy(null) }),
      kind: "Bad-kind",
    }),
  ).toThrow(Error);
  expect(() => manager.assign("ghost")).toThrow(RangeError);
  expect(() => manager.listBindings("ghost")).toThrow(RangeError);
  expect(() => manager.requireBinding("ghost", "instance-1")).toThrow(RangeError);
  expect(manager.unassign("alpha", "instance-9")).toEqual({ released: false, issues: [] });
  expect(() => manager.unassign("ghost", "instance-9")).toThrow(RangeError);
  // catch-all dispatcher と unregister は作らない。
  const surface = manager as unknown as Record<string, unknown>;
  expect(surface["unregister"]).toBeUndefined();
  expect(surface["dispatch"]).toBeUndefined();
  expect(surface["send"]).toBeUndefined();
});
