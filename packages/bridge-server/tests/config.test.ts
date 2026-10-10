import { expect, test } from "vite-plus/test";
import { DEFAULT_LIMITS, resolveLimits } from "../src/config.ts";

test("既定値は設計決定の値である", () => {
  expect(resolveLimits()).toEqual({
    maxWebSocketMessageBytes: 1_048_576,
    maxConnections: 8,
    pairingStartTimeoutMs: 10_000,
    pairingApprovalTimeoutMs: 120_000,
    acceptanceDurationMs: 120_000,
    maxUnauthorizedConnections: 2,
    maxPendingPairings: 2,
    pairingRateWindowMs: 60_000,
    maxPairingRequestsPerOrigin: 5,
    maxPairingRequestsTotal: 10,
    maxPairingCodeGenerationAttempts: 16,
    connectionCloseGraceMs: 1_000,
  });
  expect(DEFAULT_LIMITS.maxWebSocketMessageBytes).toBe(1_048_576);
});

test("部分指定は既定値と突き合わせて上書きする", () => {
  const limits = resolveLimits({ maxConnections: 2, maxUnauthorizedConnections: 2 });
  expect(limits.maxConnections).toBe(2);
  expect(limits.maxWebSocketMessageBytes).toBe(DEFAULT_LIMITS.maxWebSocketMessageBytes);
});

test("正でない・整数でない・安全でない値は拒否する", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    expect(() => resolveLimits({ maxWebSocketMessageBytes: bad })).toThrow(RangeError);
    expect(() => resolveLimits({ maxPairingRequestsTotal: bad })).toThrow(RangeError);
  }
});

test("タイマーはNodeタイマーの範囲に収める", () => {
  expect(resolveLimits({ pairingStartTimeoutMs: 2_147_483_647 }).pairingStartTimeoutMs).toBe(
    2_147_483_647,
  );
  expect(() => resolveLimits({ pairingStartTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
  expect(() => resolveLimits({ acceptanceDurationMs: 2_147_483_648 })).toThrow(RangeError);
  expect(() => resolveLimits({ connectionCloseGraceMs: 2_147_483_648 })).toThrow(RangeError);
});

test("保留数・未認可数・全接続数の関係を保証する", () => {
  // 境界ちょうどは許す。
  expect(
    resolveLimits({
      maxConnections: 2,
      maxUnauthorizedConnections: 2,
      maxPendingPairings: 2,
    }).maxPendingPairings,
  ).toBe(2);
  expect(() => resolveLimits({ maxPendingPairings: 3, maxUnauthorizedConnections: 2 })).toThrow(
    RangeError,
  );
  expect(() => resolveLimits({ maxUnauthorizedConnections: 3, maxConnections: 2 })).toThrow(
    RangeError,
  );
});

test("レート上限の関係を保証する", () => {
  expect(
    resolveLimits({ maxPairingRequestsPerOrigin: 10, maxPairingRequestsTotal: 10 })
      .maxPairingRequestsPerOrigin,
  ).toBe(10);
  expect(() =>
    resolveLimits({ maxPairingRequestsPerOrigin: 11, maxPairingRequestsTotal: 10 }),
  ).toThrow(RangeError);
});

test("承認待ちと受付時間の大小は制限しない", () => {
  expect(
    resolveLimits({ pairingApprovalTimeoutMs: 1, acceptanceDurationMs: 2_147_483_647 })
      .pairingApprovalTimeoutMs,
  ).toBe(1);
  expect(
    resolveLimits({ pairingApprovalTimeoutMs: 2_147_483_647, acceptanceDurationMs: 1 })
      .acceptanceDurationMs,
  ).toBe(1);
});
