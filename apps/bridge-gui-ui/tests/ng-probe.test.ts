import { expect, test } from "vite-plus/test";
import { buildNgDebugProbeResult } from "../src/app/ng-probe.ts";

// 観測口の応答組み立て。表示するのは可否・件数・改訂番号のみである。

test("開発条件が揃い部品が取れるとき観測口が有効になる", () => {
  const result = buildNgDebugProbeResult({
    devMode: true,
    hasNg: true,
    componentMounted: true,
    revision: 3,
    webviewTagCount: 1,
    spikeTagKept: true,
    execMark: true,
    hasGetComponent: true,
    resolvedComponent: true,
    getFailed: false,
  });
  expect(result.available).toBe(true);
  expect(result.reason).toBe("");
  expect(result.hasNg).toBe(true);
  expect(result.componentMounted).toBe(true);
  expect(result.hasGetComponent).toBe(true);
  expect(result.resolvedComponent).toBe(true);
  expect(result.revision).toBe(3);
  expect(result.webviewTagCount).toBe(1);
  expect(result.spikeTagKept).toBe(true);
  expect(result.execMark).toBe(true);
});

test("製品ビルドでは観測口が無効になる", () => {
  const result = buildNgDebugProbeResult({
    devMode: false,
    hasNg: false,
    componentMounted: true,
    revision: 3,
    webviewTagCount: 1,
    spikeTagKept: true,
    execMark: false,
    hasGetComponent: false,
    resolvedComponent: false,
    getFailed: false,
  });
  expect(result.available).toBe(false);
  expect(result.revision).toBe(3);
});

test("未描画では観測口が無効になる", () => {
  const result = buildNgDebugProbeResult({
    devMode: true,
    hasNg: true,
    componentMounted: false,
    revision: null,
    webviewTagCount: 0,
    spikeTagKept: false,
    execMark: false,
    hasGetComponent: true,
    resolvedComponent: false,
    getFailed: false,
  });
  expect(result.available).toBe(false);
  expect(result.revision).toBe(null);
});

test("取得の呼び出しに失敗しても有効性は保ち定型の理由になる", () => {
  const result = buildNgDebugProbeResult({
    devMode: true,
    hasNg: true,
    componentMounted: true,
    revision: 3,
    webviewTagCount: 1,
    spikeTagKept: true,
    execMark: true,
    hasGetComponent: true,
    resolvedComponent: false,
    getFailed: true,
  });
  expect(result.available).toBe(true);
  expect(result.reason).toBe("部品の取得に失敗した。");
  expect(result.hasGetComponent).toBe(true);
  expect(result.resolvedComponent).toBe(false);
});
