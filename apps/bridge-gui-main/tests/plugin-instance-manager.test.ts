/**
 * 汎用プラグイン・インスタンス管理層の振る舞い検証。
 *
 * 偽 core・偽セッション・偽時計で割当て手続き・監視・照合・回収・終了を
 * 確かめる。具象プラグインの import は置かず、合成 `alpha`・`beta` だけを使う。
 * 各テスト名の末尾に対応する合格シナリオを記す。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  alphaDescriptor,
  betaDescriptor,
  FakeAlphaInstance,
  firstFitPolicy,
  makeSession,
  RELIABLE_BIDI,
  setupFixture,
  uniquePolicy,
  type ManagerFixture,
} from "./plugin-instance-manager-fakes.ts";

/**
 * 監視なしの `alpha` を登録した管理層を作る。
 *
 * @param fixture - 検証用の組み立て。
 * @param maxInstances - 同時所有の上限。
 * @returns 管理層。
 */
function setupAlphaNone(
  fixture: ManagerFixture,
  maxInstances: number | null = null,
): PluginInstanceManager {
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({ assignment: firstFitPolicy(maxInstances), observation: { mode: "none" } }),
  );
  return manager;
}

/**
 * 購読監視の `alpha` を登録し、開始と解除の事実を残す。
 *
 * @param fixture - 検証用の組み立て。
 * @param maxInstances - 同時所有の上限。
 * @returns 管理層と監視の記録。
 */
function setupAlphaSubscribed(
  fixture: ManagerFixture,
  maxInstances: number | null = null,
  options: { readonly syncChanged?: boolean } = {},
): {
  manager: PluginInstanceManager;
  started: { count: number };
  stops: { count: number };
  failStart: { error: unknown };
  changedCallbacks: Array<() => void>;
} {
  const started = { count: 0 };
  const stops = { count: 0 };
  const failStart: { error: unknown } = { error: null };
  const changedCallbacks: Array<() => void> = [];
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({
      assignment: firstFitPolicy(maxInstances),
      observation: {
        mode: "subscribe",
        start: (_handle, changed) => {
          if (failStart.error !== null) {
            throw failStart.error;
          }
          started.count += 1;
          changedCallbacks.push(changed);
          // 開始時の同期通知を再現する。未確定個体の公開抑止の検証に使う。
          if (options.syncChanged === true) {
            changed();
          }
          return () => {
            stops.count += 1;
          };
        },
      },
    }),
  );
  return { manager, started, stops, failStart, changedCallbacks };
}

/**
 * ポーリング監視の `alpha` を登録する。
 *
 * @param fixture - 検証用の組み立て。
 * @param maxInstances - 同時所有の上限。
 * @returns 管理層。
 */
function setupAlphaPolling(
  fixture: ManagerFixture,
  maxInstances: number | null = null,
): PluginInstanceManager {
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({
      assignment: firstFitPolicy(maxInstances),
      observation: {
        mode: "poll",
        intervalMs: 100,
        fingerprint: (state) => String(state.count),
      },
    }),
  );
  return manager;
}

test("接続をまたいだ一意な候補を選べる（selects_unique_candidate_across_connections）", () => {
  const fixture = setupFixture([
    makeSession("local-1", "conn-a"),
    makeSession("local-2", "conn-b"),
    makeSession("local-3", "conn-a"),
  ]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({ assignment: uniquePolicy(null), observation: { mode: "none" } }),
  );
  // 所有外の割当てで2件を塞ぎ、一意な候補だけを残す。
  const first = fixture.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }).definition,
  );
  const second = fixture.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }).definition,
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
        observation: { mode: "none" },
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
      observation: { mode: "none" },
    }),
  );
  const foreign = assigned.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }).definition,
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
  const manager = setupAlphaNone(fixture, 1);
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

test("割当てと監視の開始後に確定する（commits_after_assignment_and_observation）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const { manager, started } = setupAlphaSubscribed(fixture);
  const changedBefore = fixture.changed.count;
  const binding = manager.assign("alpha");
  expect(started.count).toBe(1);
  expect(manager.listOwned()).toEqual([{ ...binding, phase: "active" }]);
  expect(manager.requireBinding("alpha", binding.instanceId)).toEqual(binding);
  expect(manager.listBindings("alpha")).toEqual([binding]);
  expect(fixture.changed.count).toBe(changedBefore + 1);
  expect(fixture.core.listAssignments()).toEqual([
    { localSessionId: "local-1", instanceId: binding.instanceId, portId: "main" },
  ]);
});

test("生成・割当て・監視の失敗を巻き戻す（rolls_back_creation_assignment_and_observation_failures）", () => {
  // 生成の失敗では何も残さない。
  const created = setupFixture([makeSession("local-1", "conn-a")]);
  const createdManager = setupAlphaNone(created);
  created.core.failCreate = new Error("生成に失敗した。");
  expect(() => createdManager.assign("alpha")).toThrow("生成に失敗した。");
  expect(created.core.instances.size).toBe(0);
  expect(created.core.assignments.size).toBe(0);
  expect(createdManager.listOwned()).toHaveLength(0);
  // 割当ての失敗では生成分を回収する。
  const assigned = setupFixture([makeSession("local-1", "conn-a")]);
  const assignedManager = setupAlphaNone(assigned);
  assigned.core.failAssign = new Error("割当てに失敗した。");
  expect(() => assignedManager.assign("alpha")).toThrow("割当てに失敗した。");
  expect(assigned.core.instances.size).toBe(0);
  expect(assigned.core.assignments.size).toBe(0);
  expect(assignedManager.listOwned()).toHaveLength(0);
  // 購読開始の失敗では割当てと生成分を回収する。
  const observed = setupFixture([makeSession("local-1", "conn-a")]);
  const observedSetup = setupAlphaSubscribed(observed);
  observedSetup.failStart.error = new Error("購読に失敗した。");
  expect(() => observedSetup.manager.assign("alpha")).toThrow("購読に失敗した。");
  expect(observed.core.instances.size).toBe(0);
  expect(observed.core.assignments.size).toBe(0);
  expect(observedSetup.manager.listOwned()).toHaveLength(0);
  // 指紋の初回取得の失敗でも割当てと生成分を回収する。
  const polled = setupFixture([makeSession("local-1", "conn-a")]);
  const polledManager = new PluginInstanceManager(polled.dependencies);
  polledManager.register(
    alphaDescriptor({
      assignment: firstFitPolicy(null),
      observation: {
        mode: "poll",
        intervalMs: 100,
        fingerprint: (_state) => {
          throw new Error("指紋に失敗した。");
        },
      },
    }),
  );
  expect(() => polledManager.assign("alpha")).toThrow("指紋に失敗した。");
  expect(polled.core.instances.size).toBe(0);
  expect(polled.core.assignments.size).toBe(0);
  expect(polledManager.listOwned()).toHaveLength(0);
  expect(polled.clock.timers).toHaveLength(0);
});

test("同期の終了で初期化を無効化する（invalidates_initialization_on_synchronous_end）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const { manager, started, stops } = setupAlphaSubscribed(fixture);
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
  // 開始した監視は補償で止める。
  expect(started.count).toBe(1);
  expect(stops.count).toBe(1);
});

test("core の無音取消しを照合で回収する（reclaims_after_core_has_revoked_assignment）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlphaNone(fixture);
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
  const manager = setupAlphaNone(fixture);
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

test("解放後と終了後の古い callback を無視する（ignores_callbacks_after_release_and_close）", () => {
  // 購読の古い callback は解放後に届かない。
  const released = setupFixture([makeSession("local-1", "conn-a")]);
  const releasedSetup = setupAlphaSubscribed(released);
  const binding = releasedSetup.manager.assign("alpha");
  const changed = releasedSetup.changedCallbacks[0];
  if (changed === undefined) throw new Error("購読が始まらない。");
  releasedSetup.manager.unassign("alpha", binding.instanceId);
  const countAfterRelease = released.changed.count;
  changed();
  expect(released.changed.count).toBe(countAfterRelease);
  // ポーリングの停止済み callback を強制実行しても届かない。
  const polled = setupFixture([makeSession("local-1", "conn-a")]);
  const polledManager = setupAlphaPolling(polled);
  const polledBinding = polledManager.assign("alpha");
  polledManager.unassign("alpha", polledBinding.instanceId);
  const pollCount = polled.changed.count;
  polled.clock.runStopped();
  expect(polled.changed.count).toBe(pollCount);
  expect(polled.issues).toHaveLength(0);
  // 終了後の古い callback も届かない。
  const closed = setupFixture([makeSession("local-1", "conn-a")]);
  const closedSetup = setupAlphaSubscribed(closed);
  closedSetup.manager.assign("alpha");
  closedSetup.manager.close();
  const countAfterClose = closed.changed.count;
  closedSetup.changedCallbacks[0]?.();
  expect(closed.changed.count).toBe(countAfterClose);
});

test("変化した指紋だけを通知する（polls_only_changed_fingerprints）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlphaPolling(fixture);
  const access = manager.assign("alpha");
  void access;
  const baseline = fixture.changed.count;
  // 変化が無ければ通知しない。
  fixture.clock.runLive();
  expect(fixture.changed.count).toBe(baseline);
  // 変化があれば1回だけ通知する。
  const binding = manager.listBindings("alpha")[0];
  if (binding === undefined) throw new Error("束縛が無い。");
  const handle = fixture.core.instances.get(binding.instanceId);
  if (!(handle instanceof FakeAlphaInstance)) throw new Error("個体の型が違う。");
  handle.getOperations()?.add(1);
  fixture.clock.runLive();
  expect(fixture.changed.count).toBe(baseline + 1);
  fixture.clock.runLive();
  expect(fixture.changed.count).toBe(baseline + 1);
  // 確定後の取得失敗は解除せず問題報告に留める。
  handle.failNextGetState = true;
  fixture.clock.runLive();
  expect(manager.listBindings("alpha")).toHaveLength(1);
  expect(fixture.issues.at(-1)?.stage).toBe("poll");
  fixture.clock.runLive();
  expect(fixture.changed.count).toBe(baseline + 1);
});

test("古い読取りと操作を拒否する（rejects_stale_reads_and_operations）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  const access = manager.register(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }),
  );
  const binding = manager.assign("alpha");
  fixture.sessions.emitEnded("local-1");
  expect(manager.listOwned()).toHaveLength(0);
  expect(manager.listBindings("alpha")).toHaveLength(0);
  expect(() => manager.requireBinding("alpha", binding.instanceId)).toThrow(RangeError);
  expect(() => access.requireBinding(binding.instanceId)).toThrow(RangeError);
  expect(() => access.readView(binding.instanceId)).toThrow(RangeError);
  expect(() => access.operations.readCount(binding.instanceId)).toThrow(RangeError);
  expect(access.listBindings()).toHaveLength(0);
});

test("よその割当てを解除しない（does_not_unassign_foreign_binding）", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }),
  );
  manager.register(
    betaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }),
  );
  const binding = manager.assign("alpha");
  // 同セッションに別個体の割当てが載った。回収で触らない。
  const foreign = fixture.core.createInstance(
    betaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }).definition,
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
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(
    alphaDescriptor({
      assignment: firstFitPolicy(null),
      observation: {
        mode: "subscribe",
        start: (_handle, _changed) => () => {
          throw new Error("監視の解除に失敗した。");
        },
      },
    }),
  );
  const binding = manager.assign("alpha");
  fixture.core.failUnassign = new Error("割当ての解除に失敗した。");
  fixture.core.failRemove = new Error("削除に失敗した。");
  const result = manager.unassign("alpha", binding.instanceId);
  expect(result.released).toBe(true);
  expect(result.issues.map((issue) => issue.stage)).toEqual([
    "observation-stop",
    "unassign",
    "remove-instance",
  ]);
  expect(fixture.issues.map((issue) => issue.stage)).toEqual([
    "observation-stop",
    "unassign",
    "remove-instance",
  ]);
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
  const manager = setupAlphaNone(fixture);
  manager.assign("alpha");
  manager.assign("alpha", { mode: "session", localSessionId: "local-2" });
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

test("開始時の同期通知では未確定個体を公開せず確定する", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const { manager, started } = setupAlphaSubscribed(fixture, null, { syncChanged: true });
  const before = fixture.changed.count;
  const binding = manager.assign("alpha");
  // 同期通知は確定前のため捨てられ、確定の通知だけが届く。
  expect(started.count).toBe(1);
  expect(fixture.changed.count).toBe(before + 1);
  expect(fixture.issues).toHaveLength(0);
  expect(manager.listOwned()).toEqual([{ ...binding, phase: "active" }]);
  expect(manager.listBindings("alpha")).toEqual([binding]);
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
      observation: { mode: "none" },
    }),
  );
  expect(() => manager.assign("alpha", { mode: "session", localSessionId: "local-1" })).toThrow(
    RangeError,
  );
  expect(fixture.core.calls).not.toContain("createInstance");
  expect(fixture.core.instances.size).toBe(0);
  expect(manager.listOwned()).toHaveLength(0);
});

test("cleanupFailed残留後の古いcallbackを無視する", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const setup = setupAlphaSubscribed(fixture);
  const binding = setup.manager.assign("alpha");
  fixture.core.failRemove = new Error("削除に失敗した。");
  const result = setup.manager.unassign("alpha", binding.instanceId);
  expect(result.released).toBe(true);
  expect(setup.manager.listOwned()[0]?.phase).toBe("cleanupFailed");
  // 記録は表に残るが、段階がactiveでないため古いcallbackは捨てる。
  const countBefore = fixture.changed.count;
  const issuesBefore = fixture.issues.length;
  setup.changedCallbacks[0]?.();
  expect(fixture.changed.count).toBe(countBefore);
  expect(fixture.issues.length).toBe(issuesBefore);
  expect(setup.manager.listOwned()[0]?.phase).toBe("cleanupFailed");
});

test("初期化失敗の補償ではよその割当てを解除しない", () => {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = setupAlphaNone(fixture);
  const foreign = fixture.core.createInstance(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }).definition,
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
  manager.register(
    alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }),
  );
  expect(() =>
    manager.register(
      alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }),
    ),
  ).toThrow(Error);
  expect(() =>
    manager.register({
      ...alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } }),
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
