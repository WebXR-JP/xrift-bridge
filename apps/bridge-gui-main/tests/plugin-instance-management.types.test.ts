/**
 * インスタンス管理層の型検査。互いに異なる状態・操作型を持つ
 * 合成プラグイン2種（`alpha`・`beta`）を登録できること、参照口の型が
 * 保たれること、誤った型を拒否することを確かめる。
 *
 * 実行の検証は振る舞いテストに任せ、ここでは登録と到達の型を固定する。
 * 具象プラグインの import は置かない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import type { GuiPluginManagementDescriptor } from "bridge-gui-plugin-sdk/management";
import {
  alphaDescriptor,
  betaDescriptor,
  firstFitPolicy,
  setupFixture,
  type AlphaOperations,
  type AlphaState,
  type BetaOperations,
  type BetaState,
} from "./plugin-instance-manager-fakes.ts";

/** 型検査用の `alpha` 記述子。 */
const alpha: GuiPluginManagementDescriptor<AlphaState, AlphaOperations> = alphaDescriptor({
  assignment: firstFitPolicy(null),
});

/** 型検査用の `beta` 記述子。`alpha` と異なる状態・操作を持つ。 */
const beta: GuiPluginManagementDescriptor<BetaState, BetaOperations> = betaDescriptor({
  assignment: firstFitPolicy(null),
});

test("合成プラグイン2種を登録できる", () => {
  const fixture = setupFixture();
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alpha);
  manager.register(beta);
  // 登録は値を返さず、重複登録は拒否する。
  expect(() => manager.register(alpha)).toThrow(Error);
});

test("参照口の型が保たれる", () => {
  const fixture = setupFixture();
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alpha);
  // 参照口の型が呼び側で保たれる。実行は振る舞いテストに任せる。
  const refOf = (instanceId: string) =>
    manager.createBoundRef<AlphaState, AlphaOperations>("alpha", instanceId);
  void refOf;
  const readState: (instanceId: string) => AlphaState = (instanceId) =>
    manager.createBoundRef<AlphaState, AlphaOperations>("alpha", instanceId).readState();
  void readState;
  expect(typeof manager.createBoundRef).toBe("function");
});

test("誤った型の記述子を拒否する", () => {
  const fixture = setupFixture();
  const manager = new PluginInstanceManager(fixture.dependencies);
  // 種別の形式外は登録で拒否する（実行時の検証であり型では表さない）。
  expect(() => manager.register({ ...alpha, kind: "Bad-kind" })).toThrow(Error);
  // 記述子の欠けも登録で拒否する。
  expect(() =>
    manager.register({
      kind: "alpha",
      definition: null,
      assignment: firstFitPolicy(null),
    } as never),
  ).toThrow(Error);
});
