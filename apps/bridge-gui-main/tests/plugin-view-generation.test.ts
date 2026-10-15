/**
 * 実 backend の表示世代の採番・採用／stale 判定の検証。
 *
 * 本物の `GuiBackend` だけを使い、`setPluginView` の採用／stale 判定、
 * 世代の単調増加、応答順逆転での巻き戻し防止、表示期間の切替えごとの
 * 新世代化、管理画面遷移での表示期間の終了を観測する。プラグインの登録は
 * 要らず、表示要求の所有と採番だけを見る。native 実行はしない。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { GuiBackend } from "../src/main/backend.ts";

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

/** 試験用のバックエンドを生成する。待ち受けは空きポート自動選択である。 */
async function startBackend(): Promise<GuiBackend> {
  const backend = await GuiBackend.create({ port: 0 });
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  return backend;
}

/**
 * 世代を指定値まで進める。同一対象の連続は採用されないため、
 * 対象を交互に替えて進める。
 *
 * @param backend - 対象のバックエンド。
 * @param targetGeneration - 進める先の世代。
 */
function advanceTo(backend: GuiBackend, targetGeneration: number): void {
  let useInstance = true;
  while (backend.getPluginView().viewGeneration < targetGeneration) {
    const base = backend.getPluginView().viewGeneration;
    const instanceId = useInstance ? "instance-a" : null;
    useInstance = !useInstance;
    const result = backend.setPluginView({ instanceId, baseViewGeneration: base });
    expect(result.adopted).toBe(true);
  }
}

test("高い世代でのリロード後も基準世代の一致で採用しstaleでは変えない", async () => {
  const backend = await startBackend();
  advanceTo(backend, 87);
  const before = backend.getPluginView();
  expect(before.viewGeneration).toBe(87);
  // 古い基準世代は stale とし、高い世代でも状態を変更しない。
  const stale = backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 80 });
  expect(stale.adopted).toBe(false);
  expect(stale.current).toEqual(before);
  expect(backend.getSnapshot().pluginView).toEqual(before);
  // 一致した基準世代では最初の表示から回復できる。
  const other = before.instanceId === null ? "instance-a" : null;
  const adopted = backend.setPluginView({ instanceId: other, baseViewGeneration: 87 });
  expect(adopted).toEqual({
    adopted: true,
    current: { instanceId: other, viewGeneration: 88 },
  });
  expect(backend.getSnapshot().pluginView).toEqual({
    instanceId: other,
    viewGeneration: 88,
  });
});

test("応答順逆転では古い要求で巻き戻らない", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 0 }).adopted).toBe(
    true,
  );
  expect(backend.setPluginView({ instanceId: "instance-b", baseViewGeneration: 1 }).adopted).toBe(
    true,
  );
  expect(backend.getPluginView()).toEqual({ instanceId: "instance-b", viewGeneration: 2 });
  // 遅れて届いた古い基準世代の要求は stale であり、現在値を保つ。
  for (const params of [
    { instanceId: "instance-a", baseViewGeneration: 0 },
    { instanceId: "instance-a", baseViewGeneration: 1 },
    { instanceId: "instance-b", baseViewGeneration: 1 },
    { instanceId: null, baseViewGeneration: 0 },
  ]) {
    const result = backend.setPluginView(params);
    expect(result.adopted).toBe(false);
    expect(result.current).toEqual({ instanceId: "instance-b", viewGeneration: 2 });
  }
  expect(backend.getSnapshot().pluginView).toEqual({
    instanceId: "instance-b",
    viewGeneration: 2,
  });
});

test("無しを挟んだ再表示は新しい世代になる", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 0 })).toEqual({
    adopted: true,
    current: { instanceId: "instance-a", viewGeneration: 1 },
  });
  expect(backend.setPluginView({ instanceId: null, baseViewGeneration: 1 })).toEqual({
    adopted: true,
    current: { instanceId: null, viewGeneration: 2 },
  });
  // 対象が同じでも省略せず、新世代で扱う。
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 2 })).toEqual({
    adopted: true,
    current: { instanceId: "instance-a", viewGeneration: 3 },
  });
});

test("対象を替えて戻すと新しい世代になる", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 0 }).adopted).toBe(
    true,
  );
  expect(backend.setPluginView({ instanceId: "instance-b", baseViewGeneration: 1 })).toEqual({
    adopted: true,
    current: { instanceId: "instance-b", viewGeneration: 2 },
  });
  // 戻しても世代は進み、ゼロへ戻さない。
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 2 })).toEqual({
    adopted: true,
    current: { instanceId: "instance-a", viewGeneration: 3 },
  });
});

test("管理画面の遷移では対象の有無にかかわらず表示期間を終了する", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 0 }).adopted).toBe(
    true,
  );
  // 表示中の遷移は無し・新しい世代へ進める。
  expect(backend.endPluginViewForNavigation()).toEqual({ instanceId: null, viewGeneration: 2 });
  expect(backend.getSnapshot().pluginView).toEqual({ instanceId: null, viewGeneration: 2 });
  // 既に無しでも進め、旧要求を失効させる。
  expect(backend.endPluginViewForNavigation()).toEqual({ instanceId: null, viewGeneration: 3 });
  // 失効した基準世代では採用しない。
  const stale = backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 2 });
  expect(stale).toEqual({
    adopted: false,
    current: { instanceId: null, viewGeneration: 3 },
  });
  // 新しい基準世代では採用できる。
  const adopted = backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 3 });
  expect(adopted).toEqual({
    adopted: true,
    current: { instanceId: "instance-a", viewGeneration: 4 },
  });
});

test("外形不正は拒否し状態を変えない", async () => {
  const backend = await startBackend();
  expect(backend.setPluginView({ instanceId: "instance-a", baseViewGeneration: 0 }).adopted).toBe(
    true,
  );
  const before = backend.getPluginView();
  const badShapes: readonly unknown[] = [
    { instanceId: "instance-b" },
    { baseViewGeneration: 1 },
    { instanceId: "", baseViewGeneration: 1 },
    { instanceId: 7, baseViewGeneration: 1 },
    { instanceId: "instance-b", baseViewGeneration: -1 },
    { instanceId: "instance-b", baseViewGeneration: 1.5 },
    { instanceId: "instance-b", baseViewGeneration: Number.NaN },
    { instanceId: "instance-b", baseViewGeneration: "1" },
    null,
    "instance-b",
  ];
  for (const shape of badShapes) {
    expect(() =>
      backend.setPluginView(shape as { instanceId: unknown; baseViewGeneration: unknown }),
    ).toThrowError(RangeError);
  }
  expect(backend.getPluginView()).toEqual(before);
  expect(backend.getSnapshot().pluginView).toEqual(before);
});
