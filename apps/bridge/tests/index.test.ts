import { expect, test } from "vite-plus/test";
import { PROTOCOL_VERSION } from "bridge-protocol";

test("共有プロトコルを参照できる", () => {
  expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
