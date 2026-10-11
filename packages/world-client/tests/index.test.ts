import { expect, test } from "vite-plus/test";
import { PROTOCOL_VERSION } from "bridge-protocol";
import { createConnectionRequest } from "../src/index.ts";

test("接続要求は比較コードと管理口の約束を返す", () => {
  const request = createConnectionRequest({ endpoint: "ws://127.0.0.1:3100/v1" });
  expect(request.pairingInfo).toBeInstanceOf(Promise);
  expect(request.sessionProvider).toBeInstanceOf(Promise);
  // 接続先がなく失敗するが、未処理の拒否を残さない。
  request.pairingInfo.catch(() => undefined);
  request.sessionProvider.catch(() => undefined);
});

test("対応するプロトコルバージョンは0.4である", () => {
  expect(PROTOCOL_VERSION).toBe("0.4.0");
});
