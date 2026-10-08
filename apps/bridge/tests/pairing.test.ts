import { expect, test } from "vite-plus/test";
import { PairingStore } from "../src/pairing.ts";
import { PAIRING_TTL_MS } from "../src/config.ts";

test("発行・消費ができる", () => {
  const store = new PairingStore(() => 1_000);
  const issued = store.issue("https://app.xrift.net");
  expect(issued.secret.length).toBeGreaterThanOrEqual(32);
  expect(issued.expiresAt).toBe(1_000 + PAIRING_TTL_MS);
  expect(store.consume(issued.secret, "https://app.xrift.net")).toEqual({ status: "ok" });
});

test("再利用・未知値・期限切れ・Origin 不一致を区別する", () => {
  let now = 1_000;
  const store = new PairingStore(() => now);
  const issued = store.issue("https://app.xrift.net");
  expect(store.consume("no-such-secret", "https://app.xrift.net")).toEqual({ status: "unknown" });
  expect(store.consume(issued.secret, "https://evil.example")).toEqual({
    status: "origin_mismatch",
  });
  expect(store.consume(issued.secret, "https://app.xrift.net")).toEqual({ status: "ok" });
  // 一度だけ使用できる。
  expect(store.consume(issued.secret, "https://app.xrift.net")).toEqual({ status: "reused" });

  const second = store.issue("https://app.xrift.net");
  now += PAIRING_TTL_MS + 1;
  expect(store.consume(second.secret, "https://app.xrift.net")).toEqual({ status: "expired" });
});

test("秘密値は128ビット以上の乱数である", () => {
  const store = new PairingStore();
  const secrets = new Set(
    Array.from({ length: 32 }, () => store.issue("https://app.xrift.net").secret),
  );
  // 32文字hex = 128ビット。衝突なく一意である。
  expect(secrets.size).toBe(32);
  for (const secret of secrets) {
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
  }
});
