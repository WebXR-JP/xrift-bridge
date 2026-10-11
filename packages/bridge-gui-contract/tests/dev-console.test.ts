import { expect, test } from "vite-plus/test";
import {
  checkDevHost,
  checkDevOrigin,
  DEV_CONSOLE_MAX_BODY_BYTES,
  extractBearerToken,
  isDevConsoleEnabled,
  isDevOpName,
  isDevLoopbackAddress,
  parseDevChannel,
  parseDevRequestBody,
  summarizeBusinessResult,
  verifyDevToken,
} from "bridge-gui-contract/dev-console";

// 開発接続口の契約（有効条件・認証・許可操作・制限）の固定。
// 秘密（比較コード本文・業務 payload・テキスト本文）は要約に載せない。

test("開発接続口は開発ビルドかつ明示opt-inの場合だけ開く", () => {
  expect(isDevConsoleEnabled("dev", true)).toBe(true);
  expect(isDevConsoleEnabled("dev", false)).toBe(false);
});

test("stable・canary・不明では環境変数を設定しても開かない", () => {
  expect(isDevConsoleEnabled("stable", true)).toBe(false);
  expect(isDevConsoleEnabled("canary", true)).toBe(false);
  expect(isDevConsoleEnabled("unknown", true)).toBe(false);
  expect(isDevConsoleEnabled("unknown", false)).toBe(false);
});

test("包装時チャンネルの表記不明はunknownに落とす", () => {
  expect(parseDevChannel("dev")).toBe("dev");
  expect(parseDevChannel("stable")).toBe("stable");
  expect(parseDevChannel("canary")).toBe("canary");
  expect(parseDevChannel(undefined)).toBe("unknown");
  expect(parseDevChannel("production")).toBe("unknown");
  expect(parseDevChannel("")).toBe("unknown");
});

test("許可操作は固定一覧に載るものだけである", () => {
  expect(isDevOpName("getSnapshot")).toBe(true);
  expect(isDevOpName("enableAcceptance")).toBe(true);
  expect(isDevOpName("disableAcceptance")).toBe(true);
  expect(isDevOpName("getPairingView")).toBe(true);
  expect(isDevOpName("approvePairing")).toBe(true);
  expect(isDevOpName("rejectPairing")).toBe(true);
  expect(isDevOpName("disconnectConnection")).toBe(true);
  expect(isDevOpName("assignDiagnostics")).toBe(true);
  expect(isDevOpName("assignText")).toBe(true);
  expect(isDevOpName("sendText")).toBe(true);
  expect(isDevOpName("unassignText")).toBe(true);
  expect(isDevOpName("spikeCreate")).toBe(true);
  expect(isDevOpName("spikeDestroy")).toBe(true);
  expect(isDevOpName("spikePush")).toBe(true);
  expect(isDevOpName("spikeList")).toBe(true);
  expect(isDevOpName("spikeReset")).toBe(true);
  expect(isDevOpName("retryPluginMounts")).toBe(true);
});

test("終了・任意名は許可操作に含めない", () => {
  expect(isDevOpName("quit")).toBe(false);
  expect(isDevOpName("eval")).toBe(false);
  expect(isDevOpName("")).toBe(false);
  expect(isDevOpName(undefined)).toBe(false);
  expect(isDevOpName(null)).toBe(false);
});

test("要求本文の形が正しければ操作・引数・相関を受け付ける", () => {
  const parsed = parseDevRequestBody(32, {
    op: "disableAcceptance",
    params: {},
    correlationId: "probe-1",
  });
  expect(parsed).toEqual({
    ok: true,
    op: "disableAcceptance",
    params: {},
    correlationId: "probe-1",
  });
});

test("要求本文の上限超過・許可外操作・形違いを拒否する", () => {
  expect(parseDevRequestBody(DEV_CONSOLE_MAX_BODY_BYTES + 1, { op: "getSnapshot" }).ok).toBe(false);
  expect(parseDevRequestBody(16, { op: "quit" }).ok).toBe(false);
  expect(parseDevRequestBody(16, { op: "getSnapshot", params: "x" }).ok).toBe(false);
  expect(parseDevRequestBody(16, null).ok).toBe(false);
  expect(parseDevRequestBody(16, []).ok).toBe(false);
  expect(parseDevRequestBody(16, { op: "getSnapshot", correlationId: "" }).ok).toBe(false);
  expect(parseDevRequestBody(16, { op: "getSnapshot", correlationId: "x".repeat(65) }).ok).toBe(
    false,
  );
});

test("Host頭は待受自身のloopbackだけを通す", () => {
  expect(checkDevHost("127.0.0.1:3210")).toBe(true);
  expect(checkDevHost("127.0.0.1")).toBe(true);
  expect(checkDevHost(null)).toBe(false);
  expect(checkDevHost("")).toBe(false);
  expect(checkDevHost("localhost:3210")).toBe(false);
  expect(checkDevHost("192.168.1.2:3210")).toBe(false);
});

test("Origin頭は非ブラウザか待受自身の起点だけを通す", () => {
  expect(checkDevOrigin(null, 3210)).toBe(true);
  expect(checkDevOrigin("", 3210)).toBe(true);
  expect(checkDevOrigin("null", 3210)).toBe(true);
  expect(checkDevOrigin("http://127.0.0.1:3210", 3210)).toBe(true);
  expect(checkDevOrigin("http://127.0.0.1:9999", 3210)).toBe(false);
  expect(checkDevOrigin("http://localhost:3210", 3210)).toBe(false);
  expect(checkDevOrigin("https://example.test", 3210)).toBe(false);
});

test("接続元はloopbackだけを通す", () => {
  expect(isDevLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isDevLoopbackAddress("::1")).toBe(true);
  expect(isDevLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isDevLoopbackAddress("192.168.1.2")).toBe(false);
  expect(isDevLoopbackAddress(null)).toBe(false);
  expect(isDevLoopbackAddress(undefined)).toBe(false);
});

test("token無し・誤りは検証に通らない", () => {
  expect(verifyDevToken("token-a", "token-a")).toBe(true);
  expect(verifyDevToken(null, "token-a")).toBe(false);
  expect(verifyDevToken("", "token-a")).toBe(false);
  expect(verifyDevToken("token-b", "token-a")).toBe(false);
  expect(verifyDevToken("token-a-x", "token-a")).toBe(false);
  expect(verifyDevToken("token-a", "")).toBe(false);
});

test("Bearer頭からtokenを取り出せる", () => {
  expect(extractBearerToken("Bearer token-a")).toBe("token-a");
  expect(extractBearerToken(null)).toBe(null);
  expect(extractBearerToken("Basic token-a")).toBe(null);
  expect(extractBearerToken("Bearer ")).toBe(null);
});

test("比較コード取得の要約は有無だけに落とし本文を捨てる", () => {
  const summary = summarizeBusinessResult("getPairingView", {
    available: true,
    requestId: "r1",
    code: "041003",
    displayCode: "041 003",
  });
  expect(summary).toEqual({ kind: "pairingAvailability", available: true });
  expect(JSON.stringify(summary)).not.toContain("041003");
  expect(JSON.stringify(summary)).not.toContain("041 003");
});

test("業務要約に秘密（本文・payload）が載らない", () => {
  const secret = "ひみつの本文041003";
  const cases = [
    summarizeBusinessResult("getSnapshot", {
      revision: 3,
      admission: { accepting: true },
      pending: [{ requestId: "r1" }],
      connections: [],
      sessions: [],
      text: secret,
    }),
    summarizeBusinessResult("approvePairing", {
      status: "APPROVED",
      connectionId: "c1",
      origin: "o",
    }),
    summarizeBusinessResult("sendText", { status: "acknowledged", id: "t1", text: secret }),
    summarizeBusinessResult("assignText", {
      localSessionId: "s1",
      instanceId: "i1",
      portId: "text",
    }),
    summarizeBusinessResult("spikeCreate", { mountId: "spike-1", initialUrl: secret }),
    summarizeBusinessResult("spikeList", [{ mountId: "spike-1" }]),
  ] as const;
  for (const summary of cases) {
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
});
