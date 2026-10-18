/**
 * 接続盤の文言と色の検証。
 */
import { expect, test } from "vite-plus/test";
import { connectionLineColor, formatConnectionLines, phaseColor, phaseLabel } from "../utils.ts";

test("進行の表示文言を返す", () => {
  expect(phaseLabel("idle")).toBe("未接続");
  expect(phaseLabel("connecting")).toBe("接続中");
  expect(phaseLabel("awaiting_approval")).toBe("承認待ち");
  expect(phaseLabel("authorized")).toBe("認証済み");
  expect(phaseLabel("ended")).toBe("終了");
});

test("接続先と進行を表示行に載せる", () => {
  expect(
    formatConnectionLines(
      { phase: "idle", endpoint: "ws://127.0.0.1:3100/v1", pairing: null, error: null },
      null,
    ),
  ).toEqual(["接続先 ws://127.0.0.1:3100/v1", "状態 未接続"]);
});

test("比較コードは承認待ちのあいだだけ表示行に載せる", () => {
  expect(
    formatConnectionLines(
      {
        phase: "awaiting_approval",
        endpoint: "ws://127.0.0.1:3100/v1",
        pairing: { requestId: "req-1", code: "123456" },
        error: null,
      },
      null,
    ),
  ).toEqual(["接続先 ws://127.0.0.1:3100/v1", "状態 承認待ち", "比較コード 123456"]);
});

test("接続手順の生成前は準備中の表示にする", () => {
  expect(formatConnectionLines(null, null)).toEqual(["ブリッジ 準備中…"]);
});

test("失敗とポート入力の不備を表示行に載せる", () => {
  const lines = formatConnectionLines(
    {
      phase: "ended",
      endpoint: "ws://127.0.0.1:3100/v1",
      pairing: null,
      error: { code: "ACCEPTANCE_CLOSED", message: "受付が有効でない。" },
    },
    "ポートは 1〜65535 の整数であること。",
  );
  expect(lines).toContain("失敗 ACCEPTANCE_CLOSED: 受付が有効でない。");
  expect(lines).toContain("ポート入力 ポートは 1〜65535 の整数であること。");
});

test("警告行は別の色にする", () => {
  expect(connectionLineColor("失敗 X: y")).not.toBe(connectionLineColor("状態 認証済み"));
  expect(phaseColor("authorized")).not.toBe(phaseColor(null));
});
