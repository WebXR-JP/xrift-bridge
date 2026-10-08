import { expect, test } from "vite-plus/test";
import { PROTOCOL_VERSION } from "bridge-protocol";
import { createWorldClient } from "../src/index.ts";

test("正規の endpoint を保持する", () => {
  const client = createWorldClient({ endpoint: "ws://127.0.0.1:3100/v1" });
  expect(client.endpoint).toBe("ws://127.0.0.1:3100/v1");
  client.close();
});

test("対応するプロトコルバージョンを持つ", () => {
  const client = createWorldClient({ endpoint: "ws://127.0.0.1:3100/v1" });
  expect(client.protocolVersion).toBe(PROTOCOL_VERSION);
  client.close();
});

test("初期状態は未接続である", () => {
  const client = createWorldClient({ endpoint: "ws://127.0.0.1:3100/v1" });
  expect(client.getState()).toBe("disconnected");
  client.close();
  expect(client.getState()).toBe("closed");
});

test("空の接続先では生成できない", () => {
  expect(() => createWorldClient({ endpoint: "" })).toThrow(RangeError);
});
