import { expect, test } from "vite-plus/test";
import { PROTOCOL_VERSION } from "../src/index.ts";

test("プロトコルバージョンがセマンティック形式である", () => {
  expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(PROTOCOL_VERSION).toBe("0.2.0");
});
