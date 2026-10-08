import { expect, test } from "vite-plus/test";
import { parseBridgeEndpoint } from "../src/index.ts";

test("正規の loopback endpoint を受け付ける", () => {
  expect(parseBridgeEndpoint("ws://127.0.0.1:3100/v1")).toBe("ws://127.0.0.1:3100/v1");
});

test("非 loopback・名前解決・scheme 違いを拒否する", () => {
  const bad = [
    "",
    "not-a-url",
    "http://127.0.0.1:3100/v1",
    "wss://127.0.0.1:3100/v1",
    "ws://localhost:3100/v1",
    "ws://[::1]:3100/v1",
    "ws://0.0.0.0:3100/v1",
    "ws://192.168.1.2:3100/v1",
    "ws://127.0.0.1/v1",
    "ws://127.0.0.1:99999/v1",
    "ws://127.0.0.1:3100/",
    "ws://127.0.0.1:3100/v2",
    "ws://127.0.0.1:3100/v1?token=secret",
    "ws://127.0.0.1:3100/v1#frag",
    "ws://user:pass@127.0.0.1:3100/v1",
    "ws://127.0.0.2:3100/v1",
  ];
  for (const endpoint of bad) {
    expect(() => parseBridgeEndpoint(endpoint), endpoint).toThrow(RangeError);
  }
});
