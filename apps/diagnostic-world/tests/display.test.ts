/**
 * 診断表示の文言の検証。秘密値・payload が混ざらないことを確かめる。
 */
import { expect, test } from "vite-plus/test";
import {
  DISPLAY_LINE_LIMIT,
  echoLabel,
  formatDiagnosticLines,
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
    lastError: null,
    echo: { status: "none" },
    ping: { status: "none" },
    env: { origin: "http://localhost:5173", secureContext: false, topLevel: true },
    build: BUILD,
  };
}

test("進行・応答の文言を返す", () => {
  expect(phaseLabel("idle")).toBe("未接続");
  expect(phaseLabel("connecting")).toBe("接続中");
  expect(phaseLabel("authorized")).toBe("認証済み");
  expect(phaseLabel("ended")).toBe("終了（切断・失敗）");
  expect(echoLabel({ status: "none" })).toBe("未実行");
  expect(echoLabel({ status: "matched", seq: 3, bytes: 36 })).toContain("一致");
  expect(pingLabel({ status: "none" })).toBe("未実行");
  expect(pingLabel({ status: "pong" })).toBe("pong");
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

test("表示行に秘密値を混ぜない", () => {
  // 快照の型自体が秘密値を持たない。ここでは表示整形が余計な語を
  // 足さないこと（secret・payload・password の語）を確かめる。
  const snapshot = idleSnapshot();
  const text = formatDiagnosticLines(snapshot).join("\n");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("payload");
  expect(text).not.toContain("password");
  expect(text).not.toContain("s3cr3t-value");
});

test("長い行を指定幅に収める", () => {
  const long = `失敗 UNAUTHORIZED: ${"あ".repeat(100)}`;
  const cut = truncateLine(long);
  expect(cut.length).toBeLessThanOrEqual(DISPLAY_LINE_LIMIT);
  expect(cut.endsWith("…")).toBe(true);
  expect(truncateLine("短い行")).toBe("短い行");
});
