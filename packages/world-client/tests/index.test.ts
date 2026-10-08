import { expect, test } from "vite-plus/test";
import { PROTOCOL_VERSION } from "bridge-protocol";
import { createWorldClient } from "../src/index.ts";

test("末尾のスラッシュを除去して保持する", () => {
  const client = createWorldClient({ baseUrl: "http://localhost:3100///" });
  expect(client.baseUrl).toBe("http://localhost:3100");
});

test("対応するプロトコルバージョンを持つ", () => {
  const client = createWorldClient({ baseUrl: "http://localhost:3100" });
  expect(client.protocolVersion).toBe(PROTOCOL_VERSION);
});

test("空の接続先では生成できない", () => {
  expect(() => createWorldClient({ baseUrl: "///" })).toThrow(RangeError);
});
