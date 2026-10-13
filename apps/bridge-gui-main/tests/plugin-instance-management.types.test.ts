/**
 * インスタンス管理層の型検査。互いに異なる状態・操作・表示型を持つ
 * 合成プラグイン2種（`alpha`・`beta`）を登録できること、登録戻り値の
 * 型が保たれること、誤った型を拒否することを確かめる。
 *
 * 実行の検証は振る舞いテストに任せ、ここでは登録と到達の型を固定する。
 * 具象プラグインの import は置かない。
 *
 * @packageDocumentation
 */
import { expect, test } from "vite-plus/test";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import type {
  GuiPluginAccess,
  GuiPluginManagementDescriptor,
} from "bridge-gui-plugin-sdk/management";
import {
  alphaDescriptor,
  betaDescriptor,
  firstFitPolicy,
  setupFixture,
  type AlphaApi,
  type AlphaOperations,
  type AlphaState,
  type AlphaView,
  type BetaApi,
  type BetaView,
} from "./plugin-instance-manager-fakes.ts";

/** 型検査用の `alpha` 記述子。表示に計数を持つ。 */
const alpha: GuiPluginManagementDescriptor<AlphaState, AlphaOperations, AlphaView, AlphaApi> =
  alphaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } });

/** 型検査用の `beta` 記述子。`alpha` と異なる状態・操作・表示を持つ。 */
const beta = betaDescriptor({ assignment: firstFitPolicy(null), observation: { mode: "none" } });

test("合成プラグイン2種を登録できる", () => {
  const fixture = setupFixture();
  const manager = new PluginInstanceManager(fixture.dependencies);
  const alphaAccess: GuiPluginAccess<AlphaView, AlphaApi> = manager.register(alpha);
  const betaAccess = manager.register(beta);
  expect(alphaAccess.kind).toBe("alpha");
  expect(betaAccess.kind).toBe("beta");
  expect(typeof alphaAccess.operations.readCount).toBe("function");
  expect(typeof alphaAccess.operations.writeCount).toBe("function");
  expect(typeof betaAccess.operations.readLabel).toBe("function");
  // 参照口の型が保たれる。実行はしない。
  const readAlphaView: (instanceId: string) => AlphaView = alphaAccess.readView;
  void readAlphaView;
  const readBetaLabel: (instanceId: string) => string = betaAccess.operations.readLabel;
  void readBetaLabel;
});

test("登録戻り値の型が保たれる", () => {
  const fixture = setupFixture();
  const manager = new PluginInstanceManager(fixture.dependencies);
  const alphaAccess = manager.register(alpha);
  // 表示型・操作型が呼び側で保たれる。
  const view: AlphaView | null = null;
  void view;
  const count: (instanceId: string) => number = alphaAccess.operations.readCount;
  void count;
  // `alpha` の口に `beta` の表示は載らない。別表で確かめる。
  const other = new PluginInstanceManager(fixture.dependencies);
  // @ts-expect-error `alpha` の表示を `beta` の口で受けない。
  const mismatch: GuiPluginAccess<BetaView, BetaApi> = other.register(alpha);
  void mismatch;
});

test("誤った型の記述子を拒否する", () => {
  const fixture = setupFixture();
  const manager = new PluginInstanceManager(fixture.dependencies);
  // 操作口の構築結果が一致しない記述子は型検査で拒否する。
  // 実行時は型消去のため通るが、検査の固定が目的である。
  const bad: GuiPluginManagementDescriptor<AlphaState, AlphaOperations, AlphaView, AlphaApi> = {
    ...alpha,
    // @ts-expect-error 操作口の構築結果が `AlphaApi` と一致しない。
    buildOperations: (_access) => 123,
  };
  const access = manager.register(bad);
  expect(access.kind).toBe("alpha");
});
