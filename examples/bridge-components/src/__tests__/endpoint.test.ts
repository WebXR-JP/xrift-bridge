/**
 * 接続先の組み立てとポート入力の検証。
 */
import { expect, test } from "vite-plus/test";
import { DEFAULT_PORT, buildEndpoint, parsePortInput } from "../endpoint.ts";

test("既定ポートは bridge-cli の既定とそろえる", () => {
  expect(DEFAULT_PORT).toBe(3100);
});

test("ポート番号から正規の loopback 接続先を組み立てる", () => {
  expect(buildEndpoint(3100)).toBe("ws://127.0.0.1:3100/v1");
});

test("範囲外のポートでは組み立てを拒否する", () => {
  expect(() => buildEndpoint(0)).toThrow(RangeError);
  expect(() => buildEndpoint(70000)).toThrow(RangeError);
});

test("ポート入力を解釈する", () => {
  expect(parsePortInput(" 3100 ")).toEqual({ ok: true, port: 3100 });
  expect(parsePortInput("")).toEqual({ ok: false, error: "ポートを入力すること。" });
  expect(parsePortInput("abc")).toEqual({
    ok: false,
    error: "ポートは 1〜65535 の整数であること。",
  });
});
