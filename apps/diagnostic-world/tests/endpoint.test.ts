/**
 * 接続先の組み立ての検証。loopback 固定と範囲検査を確かめる。
 */
import { expect, test } from "vite-plus/test";
import {
  BRIDGE_LOOPBACK_HOST,
  BRIDGE_PATH,
  DEFAULT_PORT,
  buildEndpoint,
  parsePortInput,
} from "../src/diagnostic/endpoint.ts";
import { captureWindowEnv } from "../src/diagnostic/env.ts";

test("既定ポートは期待値であり、接続先に載る", () => {
  expect(DEFAULT_PORT).toBe(3100);
  expect(buildEndpoint(DEFAULT_PORT)).toBe(
    `ws://${BRIDGE_LOOPBACK_HOST}:${DEFAULT_PORT}${BRIDGE_PATH}`,
  );
});

test("有効なポート入力を受け付ける", () => {
  expect(parsePortInput("3100")).toEqual({ ok: true, port: 3100 });
  expect(parsePortInput("  80 ")).toEqual({ ok: true, port: 80 });
  expect(parsePortInput("65535")).toEqual({ ok: true, port: 65535 });
});

test("無効なポート入力を理由つきで拒否する", () => {
  for (const text of ["", "   ", "0", "65536", "-1", "3.5", "abc", "12a"]) {
    const parsed = parsePortInput(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  }
});

test("範囲外のポートでは接続先を組み立てない", () => {
  expect(() => buildEndpoint(0)).toThrow(RangeError);
  expect(() => buildEndpoint(65536)).toThrow(RangeError);
});

test("window が無い実行系では不明値の環境を返す", () => {
  expect(typeof window).toBe("undefined");
  expect(captureWindowEnv()).toEqual({ origin: "unknown", secureContext: false, topLevel: false });
});
