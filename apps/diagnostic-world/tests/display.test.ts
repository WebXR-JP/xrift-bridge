/**
 * 診断表示の文言の検証。機微値が混ざらないことを確かめる。
 */
import { expect, test } from "vite-plus/test";
import {
  DISPLAY_LINE_LIMIT,
  echoLabel,
  formatDiagnosticLines,
  formatPairingCode,
  phaseLabel,
  pingLabel,
  truncateLine,
} from "../src/diagnostic/display.ts";
import type { DiagnosticSnapshot } from "../src/diagnostic/session.ts";
import type { DiagnosticBuildInfo } from "../src/build-info.ts";

const BUILD: DiagnosticBuildInfo = {
  version: "0.0.0-test",
  commit: "test",
  builtAt: "2026-01-01T00:00:00.000Z",
};

function idleSnapshot(): DiagnosticSnapshot {
  return {
    phase: "idle",
    connectionState: "disconnected",
    endpoint: "ws://127.0.0.1:3100/v1",
    connectTimeoutMs: 120_000,
    pairing: null,
    lastError: null,
    echo: { status: "none" },
    ping: { status: "none" },
    env: { origin: "http://localhost:5173", secureContext: false, topLevel: true },
    build: BUILD,
  };
}

function pairingSnapshot(): DiagnosticSnapshot {
  return {
    ...idleSnapshot(),
    phase: "awaiting_approval",
    connectionState: "awaiting_approval",
    pairing: {
      requestId: "pair-1",
      code: "123456",
      expiresAt: 9_999_999_999_999,
      expiresInMs: 120_000,
    },
  };
}

test("進行・応答の文言を返す", () => {
  expect(phaseLabel("idle")).toBe("未接続");
  expect(phaseLabel("connecting")).toBe("接続中");
  expect(phaseLabel("awaiting_approval")).toBe("承認待ち");
  expect(phaseLabel("authorized")).toBe("認証済み");
  expect(phaseLabel("ended")).toBe("終了（切断・失敗）");
  expect(echoLabel({ status: "none" })).toBe("未実行");
  expect(echoLabel({ status: "matched", seq: 3, bytes: 36 })).toContain("一致");
  expect(pingLabel({ status: "none" })).toBe("未実行");
  expect(pingLabel({ status: "pong" })).toBe("pong");
});

test("比較コードを3桁区切りで表示する", () => {
  expect(formatPairingCode("123456")).toBe("123 456");
  expect(formatPairingCode("000001")).toBe("000 001");
  // 想定外の書式はそのまま返し、表示側で落とさない。
  expect(formatPairingCode("abc")).toBe("abc");
});

test("快照の表示行に環境・ビルド識別子を含める", () => {
  const lines = formatDiagnosticLines(idleSnapshot());
  const text = lines.join("\n");
  expect(text).toContain("ws://127.0.0.1:3100/v1");
  expect(text).toContain("未接続");
  expect(text).toContain("http://localhost:5173");
  expect(text).toContain("top-level");
  expect(text).toContain("0.0.0-test");
});

test("承認待ちでは区切り表示の比較コードを載せる", () => {
  const text = formatDiagnosticLines(pairingSnapshot()).join("\n");
  expect(text).toContain("承認待ち");
  expect(text).toContain("123 456");
  expect(text).not.toContain("123456");
});

test("表示行に機微な語を混ぜない", () => {
  // 比較コードは区切り表示の行にだけ載せ、証拠・ログ用の語
  //（secret・payload・password）を足さないことを確かめる。
  const text = formatDiagnosticLines(pairingSnapshot()).join("\n");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("payload");
  expect(text).not.toContain("password");
});

test("長い行を指定幅に収める", () => {
  const long = `失敗 PAIRING_REJECTED: ${"あ".repeat(100)}`;
  const cut = truncateLine(long);
  expect(cut.length).toBeLessThanOrEqual(DISPLAY_LINE_LIMIT);
  expect(cut.endsWith("…")).toBe(true);
  expect(truncateLine("短い行")).toBe("短い行");
});
