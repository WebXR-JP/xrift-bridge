import { expect, test } from "vite-plus/test";
import {
  isAllowedOrigin,
  isLoopbackAddress,
  parseAllowedOrigin,
  verifyUpgrade,
} from "../src/verify.ts";

const ALLOWED = new Set(["https://app.xrift.net", "http://localhost:5173"]);

test("loopback 判定ができる", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("127.0.0.2")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("192.168.1.2")).toBe(false);
  expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  expect(isLoopbackAddress("::")).toBe(false);
  expect(isLoopbackAddress(undefined)).toBe(false);
  expect(isLoopbackAddress("not-an-ip")).toBe(false);
});

test("Origin は完全一致のみ許可する", () => {
  expect(isAllowedOrigin("https://app.xrift.net", ALLOWED)).toBe(true);
  expect(isAllowedOrigin("http://localhost:5173", ALLOWED)).toBe(true);
  // 欠落・null・ワイルドカード・接尾辞は拒否する。
  expect(isAllowedOrigin(undefined, ALLOWED)).toBe(false);
  expect(isAllowedOrigin("null", ALLOWED)).toBe(false);
  expect(isAllowedOrigin("", ALLOWED)).toBe(false);
  expect(isAllowedOrigin("*", ALLOWED)).toBe(false);
  expect(isAllowedOrigin("https://*.xrift.net", ALLOWED)).toBe(false);
  expect(isAllowedOrigin("https://app.xrift.net.evil.example", ALLOWED)).toBe(false);
  expect(isAllowedOrigin("https://evil-app.xrift.net", ALLOWED)).toBe(false);
  expect(isAllowedOrigin(["https://app.xrift.net"], ALLOWED)).toBe(false);
});

test("昇格前検証が項目ごとに拒否する", () => {
  const base = {
    remoteAddress: "127.0.0.1",
    host: "127.0.0.1:3100",
    url: "/v1",
    origin: "https://app.xrift.net",
  };
  expect(verifyUpgrade(base, "127.0.0.1:3100", ALLOWED)).toEqual({ ok: true });
  expect(
    verifyUpgrade({ ...base, remoteAddress: "192.168.1.2" }, "127.0.0.1:3100", ALLOWED),
  ).toEqual({
    ok: false,
    reason: "non_loopback_remote",
  });
  expect(verifyUpgrade({ ...base, host: "evil.example:3100" }, "127.0.0.1:3100", ALLOWED)).toEqual({
    ok: false,
    reason: "host_mismatch",
  });
  expect(verifyUpgrade({ ...base, url: "/v2" }, "127.0.0.1:3100", ALLOWED)).toEqual({
    ok: false,
    reason: "path_mismatch",
  });
  expect(
    verifyUpgrade({ ...base, origin: "https://evil.example" }, "127.0.0.1:3100", ALLOWED),
  ).toEqual({ ok: false, reason: "origin_rejected" });
  expect(verifyUpgrade({ ...base, origin: undefined }, "127.0.0.1:3100", ALLOWED)).toEqual({
    ok: false,
    reason: "origin_rejected",
  });
});

test("許可 Origin の書式を検証する", () => {
  expect(parseAllowedOrigin("https://app.xrift.net")).toBe("https://app.xrift.net");
  expect(parseAllowedOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
  const bad = [
    "*",
    "https://*.xrift.net",
    "https://app.xrift.net/path",
    "not-a-url",
    "ws://127.0.0.1:3100",
  ];
  for (const origin of bad) {
    expect(() => parseAllowedOrigin(origin), origin).toThrow(RangeError);
  }
});
