import { describe, expect, it, vi } from "vite-plus/test";
import type {
  LocalMcpStatus,
  ManagementSnapshot,
  OwnedPluginInstanceSummary,
} from "bridge-gui-contract/management";
import type { PairingViewResult } from "bridge-gui-contract/management";
import type { SetPluginViewResult } from "bridge-gui-contract/plugin-instance";
import { ManagementService } from "./management.service.ts";
import type { ManagementRpcClient, StateChangedHandler } from "./rpc.ts";
import { makeSnapshot } from "../snapshot-fixture.ts";

// 表示状態の採用と限定操作。RPC は代役に差し替え、実接続は作らない。
// 比較コード本文・業務 payload・テキスト本文は代役にも載せない。

/** 表示用の比較コード取得結果（試験用）。本文は試験内の定数に閉じる。 */
function makePairingView(requestId: string): PairingViewResult {
  return { available: true, requestId, code: "041003", displayCode: "041 003" };
}

/** 試験用の接続口の代役。push 処理の受付けと送受信の記録だけを行う。 */
function prepareRpcStub() {
  let pushHandler: StateChangedHandler | null = null;
  let mcpPushHandler: ((status: LocalMcpStatus) => void) | null = null;
  const client = {
    setProbeHandler: vi.fn(),
    setDevObserveHandler: vi.fn(),
    onStateChanged: vi.fn((handler: StateChangedHandler): (() => void) => {
      pushHandler = handler;
      return () => {};
    }),
    onLocalMcpChanged: vi.fn((handler: (status: LocalMcpStatus) => void): (() => void) => {
      mcpPushHandler = handler;
      return () => {};
    }),
    getSnapshot: vi.fn(async () => makeSnapshot({ revision: 3 })),
    enableAcceptance: vi.fn(async () => ({ accepting: true })),
    disableAcceptance: vi.fn(async () => ({ accepting: false })),
    getPairingView: vi.fn(async (requestId: string) => makePairingView(requestId)),
    approvePairing: vi.fn(async () => ({ status: "APPROVED", connectionId: "c1", origin: "o" })),
    rejectPairing: vi.fn(async () => ({ status: "REJECTED" })),
    disconnectConnection: vi.fn(async () => ({ ok: true as const })),
    assignPlugin: vi.fn(async (pluginKind: string, localSessionId?: string) => ({
      pluginKind,
      pluginId: pluginKind,
      localSessionId: localSessionId ?? "s1",
      instanceId: "i1",
      portId: pluginKind,
    })),
    unassignPlugin: vi.fn(async () => ({ released: true, issues: [] as Array<{ stage: string }> })),
    quit: vi.fn(async () => ({ ok: true as const })),
    // 既定では一発で採用する。基準世代に続く世代で採用済みを返す。
    setPluginView: vi.fn(
      async (request: {
        instanceId: string | null;
        baseViewGeneration: number;
      }): Promise<SetPluginViewResult> => ({
        adopted: true,
        current: {
          instanceId: request.instanceId,
          viewGeneration: request.baseViewGeneration + 1,
        },
      }),
    ),
    retryPluginMount: vi.fn(async (_instanceId: string) => ({ ok: true as const })),
    getLocalMcpStatus: vi.fn(async (): Promise<LocalMcpStatus> => ({
      enabled: false,
      port: null,
      url: null,
      startFailed: false,
      cleanupPending: false,
      revision: 0,
    })),
    enableLocalMcp: vi.fn(async (): Promise<LocalMcpStatus> => ({
      enabled: true,
      port: 4321,
      url: "http://127.0.0.1:4321/mcp",
      startFailed: false,
      cleanupPending: false,
      revision: 1,
    })),
    disableLocalMcp: vi.fn(async (): Promise<LocalMcpStatus> => ({
      enabled: false,
      port: null,
      url: null,
      startFailed: false,
      cleanupPending: false,
      revision: 2,
    })),
  };
  return {
    client,
    pushHandler: (): StateChangedHandler | null => pushHandler,
    mcpPushHandler: (): ((status: LocalMcpStatus) => void) | null => mcpPushHandler,
  };
}

// ADR: `as` は実行時の検証にならないため、主張する型が成立する根拠を残す。
// 代役は接続口の試験用であり、実接続（Electrobun）を持たない。主張（代役が
// 対象の操作で使う項目を満たす）は、代役表が送受信・購読・通知の全項目を
// 持つことで成り立つ。対象外の項目は空処理である。
function prepareService() {
  const stub = prepareRpcStub();
  const service = new ManagementService(stub.client as unknown as ManagementRpcClient);
  return { service, stub };
}

/** 試験用の所有個体。 */
function instanceOf(
  instanceId: string,
  overrides?: Partial<OwnedPluginInstanceSummary>,
): OwnedPluginInstanceSummary {
  return {
    pluginKind: "text",
    pluginId: "text",
    instanceId,
    localSessionId: "s1",
    portId: "text",
    phase: "active",
    ...overrides,
  };
}

/** 実プラグイン配置一覧の試験値。 */
function makePluginMount(mountId: string, overrides?: Record<string, unknown>) {
  return {
    mountId,
    kind: "text",
    initialUrl: `views://plugin-host/blank.html#mount=${mountId}`,
    phase: "bound" as const,
    viewGeneration: 1,
    pluginResponded: false,
    instanceId: "i1",
    localSessionId: "s1",
    portId: "text",
    ...overrides,
  };
}

/** 表示要求付きの試験 snapshot を作る。配置・失敗表示と世代を合わせる。 */
function makeViewSnapshot(
  instanceId: string | null,
  viewGeneration: number,
  overrides?: Parameters<typeof makeSnapshot>[0],
): ManagementSnapshot {
  return makeSnapshot({
    ...overrides,
    pluginView: { instanceId, viewGeneration },
  });
}

describe("表示状態の採用", () => {
  it("初回取得で新しい表示状態を採用する", async () => {
    const { service } = prepareService();
    await service.fetchInitial();
    expect(service.snapshot()?.revision).toBe(3);
  });

  it("push が届くと表示状態を更新し到達を残す", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    stub.pushHandler()?.({ revision: 4, snapshot: makeSnapshot({ revision: 4 }) });
    expect(service.snapshot()?.revision).toBe(4);
    expect(service.lastPushRevision()).toBe(4);
  });

  it("古い表示状態を受け取っても巻き戻さないが到達は残す", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    stub.pushHandler()?.({ revision: 2, snapshot: makeSnapshot({ revision: 2 }) });
    expect(service.snapshot()?.revision).toBe(3);
    expect(service.lastPushRevision()).toBe(2);
  });

  it("同一改訂の再取得では描画状態を保ち無視を記録する", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const adopted = service.snapshot();
    stub.pushHandler()?.({ revision: 3, snapshot: makeSnapshot({ revision: 3 }) });
    expect(service.snapshot()).toBe(adopted);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("無視");
  });

  it("改訂番号を文書題に反映する", async () => {
    const { service } = prepareService();
    await service.fetchInitial();
    expect(document.title).toContain("rev 3");
  });

  it("採用と無視を受信記録に残す", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    stub.pushHandler()?.({ revision: 2, snapshot: makeSnapshot({ revision: 2 }) });
    const log = service
      .eventLog()
      .map((entry) => entry.message)
      .join("\n");
    expect(log).toContain("更新");
    expect(log).toContain("無視");
  });
});

// 受信記録の時刻表示。時刻は記録時の付け置きであり、描画で作り直さない。
// backend の発生時刻ではなく、管理画面で受信・記録した時刻である。
describe("受信記録の時刻表示", () => {
  it("記録した時刻は `HH:mm:ss` 形式で再読み取りでも変わらない", async () => {
    const { service } = prepareService();
    await service.fetchInitial();
    const first = service.eventLog();
    expect(first.length).toBeGreaterThan(0);
    for (const entry of first) {
      expect(entry.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
    const second = service.eventLog();
    expect(second.map((entry) => entry.time)).toEqual(first.map((entry) => entry.time));
    expect(second.map((entry) => entry.message)).toEqual(first.map((entry) => entry.message));
  });

  it("同時刻に記録しても行キーは衝突しない", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    await service.enableAcceptance();
    await service.disableAcceptance();
    stub.pushHandler()?.({ revision: 2, snapshot: makeSnapshot({ revision: 2 }) });
    const entries = service.eventLog();
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("比較コード・本文を含む試験値が時刻付きの記録へ漏れない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    await service.approvePairing("r1");
    const dumped = JSON.stringify(service.eventLog());
    expect(dumped).not.toContain("041003");
    expect(dumped).not.toContain("041 003");
  });

  it("記録時刻は受信時のローカル時計であり backend の値を写さない", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
      const { service } = prepareService();
      await service.fetchInitial();
      const entries = service.eventLog();
      expect(entries.length).toBeGreaterThan(0);
      // snapshot の改訂番号（3）とは無関係に、記録時の時計だけが載る。
      expect(entries[0]?.time).toBe("03:04:05");
      expect(entries[0]?.message).not.toContain("03:04:05");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("限定操作の処理", () => {
  it("受付の有効化は要求後に再取得する", async () => {
    const { service, stub } = prepareService();
    await service.enableAcceptance();
    expect(stub.client.enableAcceptance).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot).toHaveBeenCalledTimes(1);
    expect(service.snapshot()?.revision).toBe(3);
  });

  it("受付の無効化は要求後に再取得する", async () => {
    const { service, stub } = prepareService();
    await service.disableAcceptance();
    expect(stub.client.disableAcceptance).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("承認・取り下げ・切断・割当て・終了は要求後に再取得する", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.approvePairing("r1");
    await service.rejectPairing("r1");
    await service.disconnectConnection("c1");
    await service.assignPlugin("diagnostic", "s1");
    expect(stub.client.approvePairing).toHaveBeenCalledTimes(1);
    expect(stub.client.approvePairing).toHaveBeenCalledWith("r1");
    expect(stub.client.rejectPairing).toHaveBeenCalledTimes(1);
    expect(stub.client.disconnectConnection).toHaveBeenCalledTimes(1);
    expect(stub.client.assignPlugin).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline + 4);
  });

  it("承認は要求識別子だけを送り比較コードを載せない", async () => {
    const { service, stub } = prepareService();
    await service.approvePairing("r1");
    expect(stub.client.approvePairing).toHaveBeenCalledTimes(1);
    expect(stub.client.approvePairing).toHaveBeenCalledWith("r1");
    // 要求識別子以外の引数は送らない。
    expect(stub.client.approvePairing.mock.calls[0]?.length).toBe(1);
  });

  it("プラグイン割当て・解除は要求後に再取得する", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.assignPlugin("text");
    await service.unassignPlugin("i1", "s1", "text");
    expect(stub.client.assignPlugin).toHaveBeenCalledTimes(1);
    expect(stub.client.unassignPlugin).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline + 2);
  });

  it("解除の不完全は成功と記録せず失敗表示に残す", async () => {
    const { service, stub } = prepareService();
    stub.client.unassignPlugin.mockResolvedValueOnce({ released: false, issues: [] });
    await service.unassignPlugin("i1", "s1", "text");
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("不完全");
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).not.toContain("割当てを外した");
    stub.client.unassignPlugin.mockResolvedValueOnce({
      released: true,
      issues: [{ stage: "unassign" }],
    });
    await service.unassignPlugin("i1", "s1", "text");
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("不完全");
    // 不完全な解除は一覧の失敗表示に残り、UI へ渡る。
    expect(service.pluginError()).toContain("不完全");
  });

  it("終了は要求だけ送り再取得しない", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.quit();
    expect(stub.client.quit).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("終了");
  });
});

describe("失敗時の表示", () => {
  it("受付の有効化に失敗しても受信記録に残す", async () => {
    const { service, stub } = prepareService();
    stub.client.enableAcceptance.mockRejectedValueOnce(new Error("hma-fail"));
    await service.enableAcceptance();
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("有効化に失敗");
  });

  it("プラグイン割当ての失敗は失敗理由を保持し本文は載せない", async () => {
    const { service, stub } = prepareService();
    stub.client.assignPlugin.mockRejectedValueOnce(new Error("割当て不可"));
    await service.assignPlugin("text");
    expect(service.pluginError()).toContain("割当て不可");
    expect(service.pluginError()).not.toContain("041003");
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("プラグイン割当てに失敗");
  });

  it("プラグイン割当て解除の失敗は失敗理由を保持する", async () => {
    const { service, stub } = prepareService();
    stub.client.unassignPlugin.mockRejectedValueOnce(new Error("解除不可"));
    await service.unassignPlugin("i1", "s1", "text");
    expect(service.pluginError()).toContain("解除不可");
  });

  it("プラグイン割当ての成功は失敗表示を消す", async () => {
    const { service, stub } = prepareService();
    stub.client.assignPlugin.mockRejectedValueOnce(new Error("割当て不可"));
    await service.assignPlugin("text");
    expect(service.pluginError()).not.toBe("");
    await service.assignPlugin("text");
    expect(service.pluginError()).toBe("");
  });
});

describe("二重操作の抑止", () => {
  it("同じ保留の承認を重ねても要求は一度だけ送る", async () => {
    const { service, stub } = prepareService();
    let release!: () => void;
    const gate = new Promise<{ status: "APPROVED"; connectionId: string; origin: string }>(
      (resolve) => {
        release = () => {
          resolve({ status: "APPROVED", connectionId: "c1", origin: "o" });
        };
      },
    );
    stub.client.approvePairing.mockReturnValueOnce(gate);
    const first = service.approvePairing("r1");
    const second = service.approvePairing("r1");
    release();
    await Promise.all([first, second]);
    expect(stub.client.approvePairing).toHaveBeenCalledTimes(1);
  });

  it("同じ接続の切断を重ねても要求は一度だけ送る", async () => {
    const { service, stub } = prepareService();
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => {
        resolve({ ok: true });
      };
    });
    stub.client.disconnectConnection.mockReturnValueOnce(gate);
    const first = service.disconnectConnection("c1");
    const second = service.disconnectConnection("c1");
    release();
    await Promise.all([first, second]);
    expect(stub.client.disconnectConnection).toHaveBeenCalledTimes(1);
  });
});

describe("保留コードの一時状態", () => {
  it("初回採用で比較コードを自動取得し承認RPCは送らない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(1);
    expect(stub.client.getPairingView).toHaveBeenCalledWith("r1");
    expect(service.pairingViews().get("r1")?.available).toBe(true);
    expect(service.pairingCodeStateFor("r1")).toBe("ready");
    // 取得から承認は自動で送らない。
    expect(stub.client.approvePairing).not.toHaveBeenCalled();
  });

  it("複数保留は行ごとに一度だけ自動取得する", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }, { requestId: "r2" }] }),
    );
    await service.fetchInitial();
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(2);
    expect(service.pairingViews().get("r1")?.available).toBe(true);
    expect(service.pairingViews().get("r2")?.available).toBe(true);
    expect(service.pairingCodeStateFor("r1")).toBe("ready");
    expect(service.pairingCodeStateFor("r2")).toBe("ready");
    expect(stub.client.approvePairing).not.toHaveBeenCalled();
  });

  it("新しい保留IDだけを追加で自動取得する", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(1);
    // 同じ ID の snapshot 更新では再取得しない。
    stub.pushHandler()?.({
      revision: 4,
      snapshot: makeSnapshot({ revision: 4, pending: [{ requestId: "r1" }] }),
    });
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(1);
    // 新しい ID の採用時にその分だけ追加で取得する。
    stub.pushHandler()?.({
      revision: 5,
      snapshot: makeSnapshot({ revision: 5, pending: [{ requestId: "r1" }, { requestId: "r2" }] }),
    });
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(2);
    expect(stub.client.getPairingView).toHaveBeenLastCalledWith("r2");
    expect(stub.client.approvePairing).not.toHaveBeenCalled();
  });

  it("実行中の重複取得は抑止する", async () => {
    const { service, stub } = prepareService();
    stub.client.getPairingView.mockRejectedValueOnce(new Error("取得不可"));
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(service.pairingCodeStateFor("r1")).toBe("failed");
    let release!: (value: PairingViewResult) => void;
    const gate = new Promise<PairingViewResult>((resolve) => {
      release = resolve;
    });
    stub.client.getPairingView.mockReturnValueOnce(gate);
    const first = service.retryPairingView("r1");
    const second = service.retryPairingView("r1");
    expect(service.pairingCodeStateFor("r1")).toBe("fetching");
    release(makePairingView("r1"));
    await Promise.all([first, second]);
    // 初回失敗の1回＋再試行の1回であり、重複分は送らない。
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(2);
    expect(service.pairingCodeStateFor("r1")).toBe("ready");
  });

  it("保留が消えたら一時状態を破棄する", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(service.pairingViews().has("r1")).toBe(true);
    stub.pushHandler()?.({ revision: 4, snapshot: makeSnapshot({ revision: 4, pending: [] }) });
    expect(service.pairingViews().has("r1")).toBe(false);
    expect(service.pairingFetchFailed()).not.toContain("r1");
  });

  it("保留消滅後の遅延応答は再表示しない", async () => {
    const { service, stub } = prepareService();
    let release!: (value: PairingViewResult) => void;
    const gate = new Promise<PairingViewResult>((resolve) => {
      release = resolve;
    });
    stub.client.getPairingView.mockReturnValueOnce(gate);
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    const fetched = service.fetchInitial();
    await fetched;
    // 自動取得の応答待ちの間に保留が消える。
    stub.pushHandler()?.({ revision: 4, snapshot: makeSnapshot({ revision: 4, pending: [] }) });
    release(makePairingView("r1"));
    // 自動取得は待ち合わせないため、遅延応答の破棄を待つ。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.pairingViews().has("r1")).toBe(false);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("破棄");
  });

  it("別保留の遅延応答は破棄する", async () => {
    const { service, stub } = prepareService();
    let release!: (value: PairingViewResult) => void;
    const gate = new Promise<PairingViewResult>((resolve) => {
      release = resolve;
    });
    stub.client.getPairingView.mockReturnValueOnce(gate);
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    const fetched = service.fetchInitial();
    await fetched;
    release(makePairingView("r2"));
    // 自動取得は待ち合わせないため、遅延応答の破棄を待つ。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.pairingViews().has("r1")).toBe(false);
    expect(service.pairingViews().has("r2")).toBe(false);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("破棄");
  });

  it("取得不能時は理由だけを残し本文は載せない", async () => {
    const { service, stub } = prepareService();
    stub.client.getPairingView.mockResolvedValueOnce({
      available: false,
      reason: "承認済みのため取得できない",
    });
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(service.pairingViews().get("r1")).toEqual({
      available: false,
      reason: "承認済みのため取得できない",
    });
    expect(service.pairingCodeStateFor("r1")).toBe("failed");
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("取得できない");
  });

  it("取得RPCの失敗は再試行できる状態を残し自動では取り直さない", async () => {
    const { service, stub } = prepareService();
    stub.client.getPairingView.mockRejectedValueOnce(new Error("取得不可"));
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(service.pairingViews().has("r1")).toBe(false);
    expect(service.pairingFetchFailed()).toContain("r1");
    expect(service.pairingCodeStateFor("r1")).toBe("failed");
    // 同じ ID の更新では自動リトライしない。
    stub.pushHandler()?.({
      revision: 4,
      snapshot: makeSnapshot({ revision: 4, pending: [{ requestId: "r1" }] }),
    });
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(1);
    // 明示の再試行で取り直す。
    await service.retryPairingView("r1");
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(2);
    expect(service.pairingViews().get("r1")?.available).toBe(true);
    expect(service.pairingFetchFailed()).not.toContain("r1");
    expect(service.pairingCodeStateFor("r1")).toBe("ready");
  });

  it("取得不能の再試行で取り直す", async () => {
    const { service, stub } = prepareService();
    stub.client.getPairingView.mockResolvedValueOnce({
      available: false,
      reason: "承認済みのため取得できない",
    });
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(service.pairingCodeStateFor("r1")).toBe("failed");
    await service.retryPairingView("r1");
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(2);
    expect(service.pairingViews().get("r1")?.available).toBe(true);
    expect(service.pairingCodeStateFor("r1")).toBe("ready");
  });
});

describe("秘密の非記録", () => {
  it("比較コード本文が受信記録に載らない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    await service.approvePairing("r1");
    const log = service
      .eventLog()
      .map((entry) => entry.message)
      .join("\n");
    expect(log).not.toContain("041003");
    expect(log).not.toContain("041 003");
  });

  it("比較コード本文が採用中の表示状態に載らない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    expect(JSON.stringify(service.snapshot())).not.toContain("041003");
    expect(JSON.stringify(service.snapshot())).not.toContain("041 003");
  });

  it("比較コード本文が段階観測の応答に載らない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    const observed = service.buildDevObservation();
    const dumped = JSON.stringify(observed);
    expect(dumped).not.toContain("041003");
    expect(dumped).not.toContain("041 003");
  });
});

// 子画面タグの照合。happy-dom では `electrobun-webview` は未知要素として
// 扱われるため、属性・同一ノード保持・個数で確かめる（描画は保証しない）。
// 本文は扱わない（mountId の要約だけを記録する）。
// タグの有無がそのまま表示であり、隠し置きはしない。配置・失敗表示は
// 表示要求の世代だけを正とする。

/** 照合試験用の配置先。文書に付け、試験後に外す。 */
function preparePluginHost() {
  const plugin = document.createElement("div");
  document.body.append(plugin);
  return {
    plugin,
    dispose(): void {
      plugin.remove();
    },
  };
}

/** 所有あり・表示要求なしの snapshot を採用し、表示対象を確立する。 */
async function prepareVisibleTarget(
  stub: ReturnType<typeof prepareRpcStub>,
  service: ManagementService,
  instanceId: string,
): Promise<void> {
  stub.client.getSnapshot.mockResolvedValueOnce(
    makeViewSnapshot(null, 0, {
      revision: 3,
      plugins: { kinds: [], instances: [instanceOf(instanceId)], assignments: [] },
    }),
  );
  await service.fetchInitial();
  await service.setPluginViewState(true, instanceId);
}

/** 表示要求の応答（同世代の配置）を採用する。 */
async function adoptViewMounts(
  stub: ReturnType<typeof prepareRpcStub>,
  service: ManagementService,
  revision: number,
  instanceId: string,
  viewGeneration: number,
  mounts: readonly ReturnType<typeof makePluginMount>[],
): Promise<void> {
  stub.client.getSnapshot.mockResolvedValueOnce(
    makeViewSnapshot(instanceId, viewGeneration, {
      revision,
      plugins: { kinds: [], instances: [instanceOf(instanceId)], assignments: [] },
      pluginMounts: [...mounts],
    }),
  );
  await service.fetchInitial();
}

describe("子画面タグの照合", () => {
  it("表示対象と同世代の配置だけタグを置き消えたものを外す", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [
        makePluginMount("plugin-text-1"),
        makePluginMount("plugin-text-2"),
      ]);
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(2);
      await adoptViewMounts(stub, service, 5, "i1", 1, [makePluginMount("plugin-text-2")]);
      const tags = hosts.plugin.querySelectorAll("electrobun-webview");
      expect(tags.length).toBe(1);
      expect(tags[0]?.id).toBe("plugin-plugin-text-2");
      expect(
        service
          .eventLog()
          .map((entry) => entry.message)
          .join("\n"),
      ).toContain("mountId=plugin-text-1");
    } finally {
      hosts.dispose();
    }
  });

  it("古い世代の配置ではタグを置かない", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      // 表示要求の世代は 1 のまま、古い世代 0 の配置だけが届く。
      await adoptViewMounts(stub, service, 4, "i1", 1, [
        { ...makePluginMount("plugin-text-1"), viewGeneration: 0 },
      ]);
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(0);
    } finally {
      hosts.dispose();
    }
  });

  it("更新でタグを作り直さず src を変えない", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [makePluginMount("plugin-text-1")]);
      const before = hosts.plugin.querySelector("electrobun-webview");
      // 所有一覧の URL 表記が変わっても既存は触らない。
      await adoptViewMounts(stub, service, 5, "i1", 1, [
        {
          ...makePluginMount("plugin-text-1"),
          initialUrl: "views://plugin-host/blank.html#mount=plugin-text-1x",
          pluginResponded: true,
        },
      ]);
      const after = hosts.plugin.querySelector("electrobun-webview");
      expect(after).toBe(before);
      expect(after?.getAttribute("src")).toBe("views://plugin-host/blank.html#mount=plugin-text-1");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
    } finally {
      hosts.dispose();
    }
  });

  it("タグは main 照合の属性だけを載せる", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [makePluginMount("plugin-text-1")]);
      const tag = hosts.plugin.querySelector("electrobun-webview");
      expect(tag?.getAttribute("src")).toBe("views://plugin-host/blank.html#mount=plugin-text-1");
      expect(tag?.getAttribute("renderer")).toBe("native");
      expect(tag?.getAttribute("navigation-rules")).toContain("plugin-text");
      expect(tag?.id).toBe("plugin-plugin-text-1");
      expect(tag?.hasAttribute("sandbox")).toBe(false);
    } finally {
      hosts.dispose();
    }
  });

  it("改訂進行で同一ノードを保ち配置消滅で外す", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [makePluginMount("plugin-text-1")]);
      const before = hosts.plugin.querySelector("electrobun-webview");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      // 改訂が進んでも同一ノードを保つ。
      await adoptViewMounts(stub, service, 5, "i1", 1, [makePluginMount("plugin-text-1")]);
      expect(hosts.plugin.querySelector("electrobun-webview")).toBe(before);
      // 配置が消えたら外す。
      await adoptViewMounts(stub, service, 6, "i1", 1, []);
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(0);
    } finally {
      hosts.dispose();
    }
  });

  it("応答の前後で host とタグ参照が保たれる", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      const hostBefore = hosts.plugin;
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [makePluginMount("plugin-text-1")]);
      const tagBefore = hosts.plugin.querySelector("electrobun-webview");
      expect(tagBefore).not.toBe(null);
      // 応答が届いても host・タグ参照は保たれる（作り直さない）。
      await adoptViewMounts(stub, service, 5, "i1", 1, [
        { ...makePluginMount("plugin-text-1"), pluginResponded: true },
      ]);
      expect(hosts.plugin).toBe(hostBefore);
      expect(hosts.plugin.querySelector("electrobun-webview")).toBe(tagBefore);
      expect(tagBefore?.getAttribute("src")).toBe(
        "views://plugin-host/blank.html#mount=plugin-text-1",
      );
    } finally {
      hosts.dispose();
    }
  });

  it("個体を切り替えると旧タグを直ちに外し新しい世代を送る", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [makePluginMount("plugin-text-1")]);
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      // 選択個体の所有に i2 を足して切り替える。応答待ちせず旧タグを外す。
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeViewSnapshot("i1", 1, {
          revision: 5,
          plugins: {
            kinds: [],
            instances: [instanceOf("i1"), instanceOf("i2", { localSessionId: "s2" })],
            assignments: [],
          },
          pluginMounts: [makePluginMount("plugin-text-1")],
        }),
      );
      await service.fetchInitial();
      await service.setPluginViewState(true, "i2");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(0);
      expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
        instanceId: "i2",
        baseViewGeneration: 1,
      });
    } finally {
      hosts.dispose();
    }
  });

  it("別画面へ離れると無しを新しい世代で送りタグを外す", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await prepareVisibleTarget(stub, service, "i1");
      await adoptViewMounts(stub, service, 4, "i1", 1, [makePluginMount("plugin-text-1")]);
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      await service.setPluginViewState(false, "i1");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(0);
      // 基準世代で送るため、無しでも採用中 snapshot の世代を使う。
      expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
        instanceId: null,
        baseViewGeneration: 1,
      });
      // 応答前の古い世代の配置では復活させない。
      await adoptViewMounts(stub, service, 5, "i1", 1, [makePluginMount("plugin-text-1")]);
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(0);
    } finally {
      hosts.dispose();
    }
  });
});

describe("段階観測の秘密の非含有", () => {
  it("入力値・本文が文書にあっても応答に載らない", () => {
    const secret = "ひみつの本文041003";
    const host = document.createElement("div");
    const field = document.createElement("input");
    field.value = secret;
    const text = document.createElement("p");
    text.textContent = secret;
    host.append(field, text);
    document.body.append(host);
    try {
      const { service } = prepareService();
      const observed = service.buildDevObservation();
      const dumped = JSON.stringify(observed);
      expect(dumped).not.toContain(secret);
      expect(dumped).not.toContain("041003");
    } finally {
      host.remove();
    }
  });

  it("helmボタン（hlmBtnはbutton）の無効化をdisabledで拾う", () => {
    // hlmBtn は `button[hlmBtn]` への指示子であり実体は `button` のため、
    // 無効化は素の `disabled` 属性に載り、`:disabled` で拾える。
    const host = document.createElement("app-acceptance-toggle");
    const button = document.createElement("button");
    button.setAttribute("hlmBtn", "");
    button.disabled = true;
    host.append(button);
    document.body.append(host);
    try {
      const { service } = prepareService();
      const observed = service.buildDevObservation();
      const target = observed.elements.find((element) => element.key === "acceptance-toggle");
      expect(target?.present).toBe(true);
      expect(target?.disabled).toBe(true);
      // 本文・入力値の置き場は無い（許可項目だけである）。
      expect(Object.keys(target ?? {}).sort()).toEqual([
        "disabled",
        "key",
        "present",
        "rect",
        "visible",
      ]);
    } finally {
      host.remove();
    }
  });
});

// スロット状態の導出。代替表示と可視制御で同じ判定を使うため、
// `pluginViewStateFor` の分岐をここで確かめる。本文は扱わない。
describe("スロット状態の導出", () => {
  it("未取得の間は読み込み中であり失敗後は再読み込みになる", async () => {
    const { service, stub } = prepareService();
    expect(service.pluginViewStateFor(null)).toEqual({ kind: "loading" });
    stub.client.getSnapshot.mockRejectedValueOnce(new Error("取得不可"));
    await service.fetchInitial();
    expect(service.initialFetchFailed()).toBe(true);
    expect(service.pluginViewStateFor(null)).toEqual({ kind: "loadFailed" });
    // 再読み込みの成功で失敗表示は消える。
    stub.client.getSnapshot.mockResolvedValueOnce(makeSnapshot({ revision: 3 }));
    await service.reloadSnapshot();
    expect(service.initialFetchFailed()).toBe(false);
    expect(service.pluginViewStateFor(null).kind).toBe("empty");
  });

  it("所有0件は起動無しになる", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(makeSnapshot({ revision: 3 }));
    await service.fetchInitial();
    expect(service.pluginViewStateFor(null)).toEqual({ kind: "empty" });
  });

  it("所有段階をマウント状態より優先する", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        revision: 3,
        plugins: {
          kinds: [],
          instances: [
            instanceOf("i-init", { phase: "initializing" }),
            instanceOf("i-rel", { phase: "releasing" }),
            instanceOf("i-clean", { phase: "cleanupFailed" }),
          ],
          assignments: [],
        },
      }),
    );
    await service.fetchInitial();
    expect(service.pluginViewStateFor("i-init")).toEqual({ kind: "starting" });
    expect(service.pluginViewStateFor("i-rel")).toEqual({ kind: "releasing" });
    expect(service.pluginViewStateFor("i-clean")).toEqual({ kind: "cleanupFailed" });
  });

  it("activeで配置なし・初期応答待ちは準備中であり応答で子画面だけになる", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, {
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    await service.fetchInitial();
    expect(service.pluginViewStateFor("i1")).toEqual({ kind: "preparing" });
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, {
        revision: 4,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
        pluginMounts: [{ ...makePluginMount("plugin-text-1"), pluginResponded: true }],
      }),
    );
    await service.fetchInitial();
    expect(service.pluginViewStateFor("i1")).toEqual({ kind: "answered" });
  });

  it("古い世代の配置・失敗表示では子を復活させない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 2, {
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
        pluginMounts: [{ ...makePluginMount("plugin-text-1"), viewGeneration: 1 }],
        pluginMountFailures: [
          {
            kind: "text",
            reason: "古い世代の失敗",
            instanceId: "i1",
            localSessionId: null,
            viewGeneration: 1,
          },
        ],
      }),
    );
    await service.fetchInitial();
    // 同世代の配置・失敗が無いため準備中であり、古い失敗は出さない。
    expect(service.pluginViewStateFor("i1")).toEqual({ kind: "preparing" });
  });

  it("activeで選択個体の失敗は再試行付きの失敗になる", async () => {
    const { service, stub } = prepareService();
    const failed: ManagementSnapshot = makeViewSnapshot("i1", 1, {
      revision: 3,
      plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      pluginMountFailures: [
        {
          kind: "text",
          reason: "生成待ちが失効した",
          instanceId: "i1",
          localSessionId: null,
          viewGeneration: 1,
        },
      ],
    });
    stub.client.getSnapshot.mockResolvedValueOnce(failed);
    await service.fetchInitial();
    expect(service.pluginViewStateFor("i1")).toEqual({
      kind: "failed",
      reason: "生成待ちが失効した",
      retryPending: false,
      retryRequestFailed: false,
    });
    // 他個体の失敗は選択個体に波及しない。
    expect(service.pluginViewStateFor("i2")).toEqual({ kind: "preparing" });
  });

  it("選択識別子が一時的に所有に無い間は準備中である", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    await service.fetchInitial();
    // 選択の移し替え前に古い識別子が残っても、失敗への読替えはしない。
    expect(service.pluginViewStateFor("i-gone")).toEqual({ kind: "preparing" });
    expect(service.pluginViewStateFor(null)).toEqual({ kind: "preparing" });
  });

  it("再試行要求中は失敗表示を残し要求自体の失敗は注記を足す", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, {
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
        pluginMountFailures: [
          {
            kind: "text",
            reason: "生成待ちが失効した",
            instanceId: "i1",
            localSessionId: null,
            viewGeneration: 1,
          },
        ],
      }),
    );
    await service.fetchInitial();
    let release!: (value: { ok: true }) => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    stub.client.retryPluginMount.mockReturnValueOnce(gate);
    const retried = service.retryPluginMount("i1");
    expect(service.retryPending()).toContain("i1");
    const pending = service.pluginViewStateFor("i1");
    expect(pending.kind).toBe("failed");
    if (pending.kind === "failed") {
      expect(pending.retryPending).toBe(true);
      expect(pending.reason).toBe("生成待ちが失効した");
    }
    release({ ok: true });
    await retried;
    expect(service.retryPending()).not.toContain("i1");
    // 要求自体の失敗は注記に残る。
    stub.client.retryPluginMount.mockRejectedValueOnce(new Error("受付不可"));
    await service.retryPluginMount("i1");
    expect(service.retryRequestFailed()).toContain("i1");
    const failed = service.pluginViewStateFor("i1");
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect(failed.retryRequestFailed).toBe(true);
      expect(failed.reason).toBe("生成待ちが失効した");
    }
  });
});

describe("個体限定の再試行", () => {
  it("対象個体の識別子だけを載せて送り最新状態を読み直す", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.retryPluginMount("i9");
    expect(stub.client.retryPluginMount).toHaveBeenCalledTimes(1);
    expect(stub.client.retryPluginMount).toHaveBeenCalledWith("i9");
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline + 1);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("再試行を要求した");
  });

  it("他個体の再試行状態に波及しない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, {
        revision: 3,
        plugins: {
          kinds: [],
          instances: [instanceOf("i1"), instanceOf("i2", { localSessionId: "s2" })],
          assignments: [],
        },
        pluginMountFailures: [
          {
            kind: "text",
            reason: "失敗1",
            instanceId: "i1",
            localSessionId: null,
            viewGeneration: 1,
          },
          {
            kind: "text",
            reason: "失敗2",
            instanceId: "i2",
            localSessionId: null,
            viewGeneration: 1,
          },
        ],
      }),
    );
    await service.fetchInitial();
    stub.client.retryPluginMount.mockRejectedValueOnce(new Error("受付不可"));
    await service.retryPluginMount("i1");
    expect(service.retryRequestFailed()).toEqual(["i1"]);
    const other = service.pluginViewStateFor("i2");
    expect(other.kind).toBe("failed");
    if (other.kind === "failed") {
      expect(other.retryRequestFailed).toBe(false);
    }
  });

  it("同じ個体の再試行を重ねても要求は一度だけ送る", async () => {
    const { service, stub } = prepareService();
    let release!: (value: { ok: true }) => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    stub.client.retryPluginMount.mockReturnValueOnce(gate);
    const first = service.retryPluginMount("i1");
    const second = service.retryPluginMount("i1");
    release({ ok: true });
    await Promise.all([first, second]);
    expect(stub.client.retryPluginMount).toHaveBeenCalledTimes(1);
  });

  it("失敗が消えた後に別原因で再失敗しても古い注記を載せない", async () => {
    const { service, stub } = prepareService();
    const owned = { kinds: [], instances: [instanceOf("i1")], assignments: [] };
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, {
        revision: 3,
        plugins: owned,
        pluginMountFailures: [
          {
            kind: "text",
            reason: "古い失敗",
            instanceId: "i1",
            localSessionId: null,
            viewGeneration: 1,
          },
        ],
      }),
    );
    await service.fetchInitial();
    stub.client.retryPluginMount.mockRejectedValueOnce(new Error("受付不可"));
    await service.retryPluginMount("i1");
    expect(service.retryRequestFailed()).toContain("i1");
    // 採用中 snapshot から失敗が消えたら注記も消える。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, { revision: 4, plugins: owned, pluginMountFailures: [] }),
    );
    await service.fetchInitial();
    expect(service.retryRequestFailed()).not.toContain("i1");
    // 別原因で再失敗しても古い注記は載らない。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, {
        revision: 5,
        plugins: owned,
        pluginMountFailures: [
          {
            kind: "text",
            reason: "新しい失敗",
            instanceId: "i1",
            localSessionId: null,
            viewGeneration: 1,
          },
        ],
      }),
    );
    await service.fetchInitial();
    expect(service.retryRequestFailed()).not.toContain("i1");
    const state = service.pluginViewStateFor("i1");
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.reason).toBe("新しい失敗");
      expect(state.retryRequestFailed).toBe(false);
    }
  });
});

// 表示要求の送出。表示意図の変化で採用中 snapshot の基準世代とともに
// `setPluginView` を送り、採用済み一致・同一基準の送出済みでは再送しない。
// 世代の採番は main が行い、Angular は行わない。切替で送信・UDP 開始・
// 割当て操作は送らない。native の見え方自体は自動検証できない
// （RPC・タグの有無の水準までである）。

/** 所有ありの snapshot を採用する。表示要求は含めない。 */
async function adoptInstances(
  stub: ReturnType<typeof prepareRpcStub>,
  service: ManagementService,
  revision: number,
  instances: readonly OwnedPluginInstanceSummary[],
): Promise<void> {
  stub.client.getSnapshot.mockResolvedValueOnce(
    makeViewSnapshot(null, 0, {
      revision,
      plugins: { kinds: [], instances: [...instances], assignments: [] },
    }),
  );
  await service.fetchInitial();
}

describe("表示要求の送出", () => {
  it("操作選択とactive選択で基準世代付きの表示要求を送る", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    // 操作画面の選択前は送らない（表示対象が定まらない）。
    expect(stub.client.setPluginView).not.toHaveBeenCalled();
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
    expect(stub.client.setPluginView).toHaveBeenCalledWith({
      instanceId: "i1",
      baseViewGeneration: 0,
    });
  });

  it("同一表示期間のsnapshot更新では再送しない", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
    // 改訂進行・再描画では対象が変わらないため送らない。
    await adoptInstances(stub, service, 4, [instanceOf("i1")]);
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
  });

  it("個体タブ切替で新しい表示意図を送る", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [
      instanceOf("i1"),
      instanceOf("i2", { localSessionId: "s2" }),
    ]);
    await service.setPluginViewState(true, "i1");
    await service.setPluginViewState(true, "i2");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(2);
    expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
      instanceId: "i2",
      baseViewGeneration: 0,
    });
  });

  it("所有段階がactiveでない間は対象にしない", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1", { phase: "initializing" })]);
    await service.setPluginViewState(true, "i1");
    // 無しのまま変わらないため送らない（失効させる旧世代が無い）。
    expect(stub.client.setPluginView).not.toHaveBeenCalled();
    // 所有段階が active になれば対象にして送る（採用時の合わせで進む）。
    await adoptInstances(stub, service, 4, [instanceOf("i1")]);
    expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
      instanceId: "i1",
      baseViewGeneration: 0,
    });
  });

  it("snapshot未取得の間は送らない", async () => {
    const { service, stub } = prepareService();
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).not.toHaveBeenCalled();
  });

  it("送出の失敗は記録に残し次回送り直す", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    stub.client.setPluginView.mockRejectedValueOnce(new Error("受付不可"));
    await service.setPluginViewState(true, "i1");
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("表示要求に失敗");
    // 送出済みとして扱わないため、次回の切替で送り直す（永久抑止しない）。
    // 基準世代は採用中 snapshot から取り直すため、採番は進まない。
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(2);
    expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
      instanceId: "i1",
      baseViewGeneration: 0,
    });
  });

  it("再試行では表示要求を送り直さない（世代を維持する）", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    await service.setPluginViewState(true, "i1");
    const sent = stub.client.setPluginView.mock.calls.length;
    await service.retryPluginMount("i1");
    expect(stub.client.retryPluginMount).toHaveBeenCalledWith("i1");
    expect(stub.client.setPluginView.mock.calls.length).toBe(sent);
  });

  it("表示切替で送信・割当て操作を送らない", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    await service.setPluginViewState(true, "i1");
    await service.setPluginViewState(false, "i1");
    await service.setPluginViewState(true, "i1");
    expect(stub.client.assignPlugin).not.toHaveBeenCalled();
    expect(stub.client.unassignPlugin).not.toHaveBeenCalled();
    expect(stub.client.getPairingView).toHaveBeenCalledTimes(0);
  });
});

// 基準世代と採用・stale の扱い。Angular は採番せず、採用中 snapshot の世代を
// 基準に送り、応答の `current` を正とする。mainview リロード後の高い世代から
// 始めても一発で採用され、stale では巻き戻さず一度だけ送り直す。
describe("表示要求の基準世代と採用・stale", () => {
  it("高い世代のsnapshotから始めても最初の表示切替が一発で採用される", async () => {
    const { service, stub } = prepareService();
    // mainview リロード後の回復を模し、世代 5 の採用済みから始める。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot(null, 5, {
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    await service.fetchInitial();
    await service.setPluginViewState(true, "i1");
    // 観測した基準世代 5 のまま送り、採用される（世代 0 に戻さない）。
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
    expect(stub.client.setPluginView).toHaveBeenCalledWith({
      instanceId: "i1",
      baseViewGeneration: 5,
    });
  });

  it("staleでは現在の採用世代を基準に最新の表示意図で一度だけ送り直す", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    stub.client.setPluginView
      .mockResolvedValueOnce({ adopted: false, current: { instanceId: null, viewGeneration: 4 } })
      .mockResolvedValueOnce({ adopted: true, current: { instanceId: "i1", viewGeneration: 5 } });
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(2);
    expect(stub.client.setPluginView.mock.calls[0]?.[0]).toEqual({
      instanceId: "i1",
      baseViewGeneration: 0,
    });
    // 送り直しは応答の `current` 世代を基準にする。
    expect(stub.client.setPluginView.mock.calls[1]?.[0]).toEqual({
      instanceId: "i1",
      baseViewGeneration: 4,
    });
  });

  it("staleでも最新の表示意図が採用済みなら再送しない", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    stub.client.setPluginView.mockResolvedValueOnce({
      adopted: false,
      current: { instanceId: "i1", viewGeneration: 4 },
    });
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("採用されなかった");
  });

  it("送り直しもstaleなら追送しない（無制限ループにしない）", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [instanceOf("i1")]);
    stub.client.setPluginView
      .mockResolvedValueOnce({ adopted: false, current: { instanceId: null, viewGeneration: 4 } })
      .mockResolvedValueOnce({ adopted: false, current: { instanceId: null, viewGeneration: 6 } });
    await service.setPluginViewState(true, "i1");
    // 初送＋一度の送り直しで止まる。
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(2);
    expect(
      service
        .eventLog()
        .map((entry) => entry.message)
        .join("\n"),
    ).toContain("送り直しも古い");
  });

  it("表示終了と再表示は対象が同じでも新要求として送る", async () => {
    const { service, stub } = prepareService();
    const owned = { kinds: [], instances: [instanceOf("i1")], assignments: [] };
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot(null, 0, { revision: 3, plugins: owned }),
    );
    await service.fetchInitial();
    await service.setPluginViewState(true, "i1");
    // 採用 `{i1, 1}` を反映する。採用済み一致のため再送は起きない。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot("i1", 1, { revision: 4, plugins: owned }),
    );
    await service.fetchInitial();
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
    // 表示終了は無しを現基準で送る（表示期間の終了）。
    await service.setPluginViewState(false, "i1");
    expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
      instanceId: null,
      baseViewGeneration: 1,
    });
    // 終了の採用 `{無し, 2}` を反映する。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeViewSnapshot(null, 2, { revision: 5, plugins: owned }),
    );
    await service.fetchInitial();
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(2);
    // 離脱後の同一個体への再表示は新要求として送る（省略しない）。
    await service.setPluginViewState(true, "i1");
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(3);
    expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
      instanceId: "i1",
      baseViewGeneration: 2,
    });
  });

  it("送出中の切替は多重送出せず完了後に最新の表示意図を送る", async () => {
    const { service, stub } = prepareService();
    await adoptInstances(stub, service, 3, [
      instanceOf("i1"),
      instanceOf("i2", { localSessionId: "s2" }),
    ]);
    let release!: (value: {
      adopted: true;
      current: { instanceId: string; viewGeneration: number };
    }) => void;
    const gate = new Promise<{
      adopted: true;
      current: { instanceId: string; viewGeneration: number };
    }>((resolve) => {
      release = resolve;
    });
    stub.client.setPluginView.mockReturnValueOnce(gate);
    const first = service.setPluginViewState(true, "i1");
    const second = service.setPluginViewState(true, "i2");
    // 送出中の重なりでは重ねて送らない。
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(1);
    release({ adopted: true, current: { instanceId: "i1", viewGeneration: 1 } });
    await Promise.all([first, second]);
    // 完了後の追随（直列）を待つ。追送は最新の表示意図だけである。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.client.setPluginView).toHaveBeenCalledTimes(2);
    expect(stub.client.setPluginView).toHaveBeenLastCalledWith({
      instanceId: "i2",
      baseViewGeneration: 0,
    });
  });
});

describe("製品向け MCP の公開状態", () => {
  /** 試験用の公開状態。 */
  function statusOf(overrides?: Partial<LocalMcpStatus>): LocalMcpStatus {
    return {
      enabled: true,
      port: 4321,
      url: "http://127.0.0.1:4321/mcp",
      startFailed: false,
      cleanupPending: false,
      revision: 0,
      ...overrides,
    };
  }

  /** 受信記録の全文を取り出す。秘密の混入検査にも使う。 */
  function logText(service: Pick<ManagementService, "eventLog">): string {
    return service
      .eventLog()
      .map((entry) => entry.message)
      .join("\n");
  }

  it("初回に公開状態を読み未取得を残さない", async () => {
    const { service, stub } = prepareService();
    expect(service.localMcpStatus()).toBe(null);
    stub.client.getLocalMcpStatus.mockResolvedValueOnce(statusOf({ enabled: false }));
    await service.fetchLocalMcpStatus();
    expect(stub.client.getLocalMcpStatus).toHaveBeenCalledTimes(1);
    expect(service.localMcpStatus()).toEqual(statusOf({ enabled: false }));
  });

  it("push で追従する", async () => {
    const { service, stub } = prepareService();
    stub.mcpPushHandler()?.(statusOf());
    expect(service.localMcpStatus()?.enabled).toBe(true);
    stub.mcpPushHandler()?.(statusOf({ enabled: true, revision: 1 }));
    expect(service.localMcpStatus()?.port).toBe(4321);
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 2 }));
    expect(service.localMcpStatus()?.enabled).toBe(false);
  });

  it("有効化で公開状態を採用する", async () => {
    const { service, stub } = prepareService();
    await service.enableLocalMcp();
    expect(stub.client.enableLocalMcp).toHaveBeenCalledTimes(1);
    expect(service.localMcpStatus()?.enabled).toBe(true);
    expect(service.localMcpError()).toBe("");
  });

  it("停止は公開状態を返し解放を確認したあとだけ停止を記録する", async () => {
    const { service, stub } = prepareService();
    await service.enableLocalMcp();
    stub.client.disableLocalMcp.mockResolvedValueOnce(
      statusOf({ enabled: false, port: null, url: null, revision: 2 }),
    );
    await service.disableLocalMcp();
    expect(stub.client.disableLocalMcp).toHaveBeenCalledTimes(1);
    expect(service.localMcpStatus()?.enabled).toBe(false);
    expect(service.localMcpError()).toBe("");
    expect(logText(service)).toContain("製品向け MCP を停止した");
  });

  it("停止の未完了は未完了を示し再試行を促す", async () => {
    const { service, stub } = prepareService();
    await service.enableLocalMcp();
    stub.client.disableLocalMcp.mockResolvedValueOnce(
      statusOf({ enabled: false, port: null, url: null, cleanupPending: true, revision: 2 }),
    );
    await service.disableLocalMcp();
    expect(service.localMcpStatus()?.cleanupPending).toBe(true);
    // 「停止した」とは記録せず、未完了を示す。
    expect(logText(service)).not.toContain("製品向け MCP を停止した");
    expect(logText(service)).toContain("停止が未完了である");
    expect(service.localMcpError()).toContain("もう一度停止する");
  });

  it("停止通知の後に届く古い取得応答を採用しない", async () => {
    const { service, stub } = prepareService();
    let release!: (value: LocalMcpStatus) => void;
    const gate = new Promise<LocalMcpStatus>((resolve) => {
      release = resolve;
    });
    stub.client.getLocalMcpStatus.mockImplementationOnce(() => gate);
    // 取得を開始し、完了前に停止通知が届く。
    const fetching = service.fetchLocalMcpStatus();
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 5 }));
    expect(service.localMcpStatus()?.enabled).toBe(false);
    release(statusOf({ enabled: true, revision: 1 }));
    await fetching;
    // 遅延した応答は捨てる。
    expect(service.localMcpStatus()).toEqual(
      statusOf({ enabled: false, port: null, url: null, revision: 5 }),
    );
  });

  it("停止をまたぐ旧応答は再有効化後に採用しない", async () => {
    const { service, stub } = prepareService();
    let releaseFirst!: (value: LocalMcpStatus) => void;
    const gate = new Promise<LocalMcpStatus>((resolve) => {
      releaseFirst = resolve;
    });
    stub.client.getLocalMcpStatus.mockImplementationOnce(() => gate);
    const pending = service.fetchLocalMcpStatus();
    stub.client.getLocalMcpStatus.mockResolvedValueOnce(statusOf({ enabled: false, revision: 4 }));
    await service.disableLocalMcp();
    // 再有効化の一環で新しい公開状態を取得する。
    stub.client.enableLocalMcp.mockResolvedValueOnce(statusOf({ enabled: true, revision: 6 }));
    await service.enableLocalMcp();
    expect(service.localMcpStatus()?.revision).toBe(6);
    // 遅延した旧応答が届いても採用しない。
    releaseFirst(statusOf({ enabled: true, revision: 1 }));
    await pending;
    expect(service.localMcpStatus()?.revision).toBe(6);
  });

  it("開始失敗は公開状態に載り再有効化で消える", async () => {
    const { service, stub } = prepareService();
    // 開始失敗は例外ではなく公開状態（無効・開始失敗あり）の正常応答で届く。
    stub.client.enableLocalMcp.mockResolvedValueOnce(
      statusOf({ enabled: false, port: null, url: null, startFailed: true, revision: 1 }),
    );
    await service.enableLocalMcp();
    // 成功とは記録せず、失敗表示を残す。
    expect(service.localMcpStatus()?.startFailed).toBe(true);
    expect(service.localMcpError()).toContain("操作に失敗した");
    expect(logText(service)).not.toContain("製品向け MCP を有効化した");
    expect(logText(service)).toContain("有効化に失敗した");
    // 成功時は開始失敗が消える（新しい版として届く）。
    stub.client.enableLocalMcp.mockResolvedValueOnce(statusOf({ enabled: true, revision: 2 }));
    await service.enableLocalMcp();
    expect(service.localMcpStatus()?.startFailed).toBe(false);
    expect(service.localMcpError()).toBe("");
    expect(logText(service)).toContain("製品向け MCP を有効化した");
  });

  it("開始失敗の正常応答では有効化したと記録せず失敗表示を残す（応答先着）", async () => {
    const { service, stub } = prepareService();
    stub.client.enableLocalMcp.mockResolvedValueOnce(
      statusOf({ enabled: false, port: null, url: null, startFailed: true, revision: 1 }),
    );
    await service.enableLocalMcp();
    expect(service.localMcpStatus()?.enabled).toBe(false);
    expect(service.localMcpStatus()?.startFailed).toBe(true);
    expect(logText(service)).not.toContain("製品向け MCP を有効化した");
    expect(logText(service)).toContain("有効化に失敗した");
    expect(service.localMcpError()).toContain("操作に失敗した");
  });

  it("開始失敗の正常応答では有効化したと記録せず失敗表示を残す（push先着）", async () => {
    const { service, stub } = prepareService();
    let release!: (value: LocalMcpStatus) => void;
    const gate = new Promise<LocalMcpStatus>((resolve) => {
      release = resolve;
    });
    stub.client.enableLocalMcp.mockReturnValueOnce(gate);
    const pending = service.enableLocalMcp();
    // main は状態を公開してから応答を返すため、開始失敗の push が先に着く。
    stub.mcpPushHandler()?.(
      statusOf({ enabled: false, port: null, url: null, startFailed: true, revision: 1 }),
    );
    release(statusOf({ enabled: false, port: null, url: null, startFailed: true, revision: 1 }));
    await pending;
    expect(service.localMcpStatus()?.startFailed).toBe(true);
    expect(logText(service)).not.toContain("製品向け MCP を有効化した");
    expect(logText(service)).toContain("有効化に失敗した");
    expect(service.localMcpError()).toContain("操作に失敗した");
  });

  it("古い版の push を捨て同じ版の push を捨てる", async () => {
    const { service, stub } = prepareService();
    stub.mcpPushHandler()?.(statusOf({ enabled: true, revision: 2 }));
    expect(service.localMcpStatus()?.revision).toBe(2);
    // 古い版は捨てる。
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 1 }));
    expect(service.localMcpStatus()).toEqual(statusOf({ enabled: true, revision: 2 }));
    // 同じ版は捨てる（内容が違っても上書きしない）。
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 2 }));
    expect(service.localMcpStatus()).toEqual(statusOf({ enabled: true, revision: 2 }));
    // 新しい版だけ採用する。
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 3 }));
    expect(service.localMcpStatus()?.revision).toBe(3);
    expect(service.localMcpStatus()?.enabled).toBe(false);
  });

  it("push が先に着いても有効化の完了を反映する", async () => {
    const { service, stub } = prepareService();
    let release!: (value: LocalMcpStatus) => void;
    const gate = new Promise<LocalMcpStatus>((resolve) => {
      release = resolve;
    });
    stub.client.enableLocalMcp.mockReturnValueOnce(gate);
    const pending = service.enableLocalMcp();
    // main は状態を公開してから応答を返すため push が先に着く。
    stub.mcpPushHandler()?.(statusOf({ enabled: true, revision: 1 }));
    expect(service.localMcpStatus()?.url).toBe("http://127.0.0.1:4321/mcp");
    release(statusOf({ enabled: true, revision: 1 }));
    await pending;
    // 同じ版の応答は状態を巻き戻さないが、完了表示は反映する。
    expect(service.localMcpStatus()?.enabled).toBe(true);
    expect(service.localMcpStatus()?.url).toBe("http://127.0.0.1:4321/mcp");
    expect(service.localMcpError()).toBe("");
    expect(logText(service)).toContain("製品向け MCP を有効化した");
  });

  it("push が先に着いても停止の完了を反映する", async () => {
    const { service, stub } = prepareService();
    let release!: (value: LocalMcpStatus) => void;
    const gate = new Promise<LocalMcpStatus>((resolve) => {
      release = resolve;
    });
    stub.client.disableLocalMcp.mockReturnValueOnce(gate);
    const pending = service.disableLocalMcp();
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 4 }));
    release(statusOf({ enabled: false, port: null, url: null, revision: 4 }));
    await pending;
    expect(service.localMcpStatus()?.enabled).toBe(false);
    expect(service.localMcpError()).toBe("");
    expect(logText(service)).toContain("製品向け MCP を停止した");
    expect(logText(service)).not.toContain("未完了");
  });

  it("push が先に着いても停止の未完了を反映し停止したとは記録しない", async () => {
    const { service, stub } = prepareService();
    let release!: (value: LocalMcpStatus) => void;
    const gate = new Promise<LocalMcpStatus>((resolve) => {
      release = resolve;
    });
    stub.client.disableLocalMcp.mockReturnValueOnce(gate);
    const pending = service.disableLocalMcp();
    stub.mcpPushHandler()?.(
      statusOf({ enabled: false, port: null, url: null, cleanupPending: true, revision: 4 }),
    );
    release(statusOf({ enabled: false, port: null, url: null, cleanupPending: true, revision: 4 }));
    await pending;
    expect(service.localMcpStatus()?.cleanupPending).toBe(true);
    expect(service.localMcpError()).toContain("もう一度停止する");
    expect(logText(service)).toContain("停止が未完了である");
    expect(logText(service)).not.toContain("製品向け MCP を停止した");
  });

  it("push が先に着いても有効化の失敗を反映する", async () => {
    const { service, stub } = prepareService();
    let release!: (value: unknown) => void;
    const gate = new Promise<LocalMcpStatus>((_resolve, reject) => {
      release = reject as (value: unknown) => void;
    });
    stub.client.enableLocalMcp.mockReturnValueOnce(gate);
    const pending = service.enableLocalMcp();
    stub.mcpPushHandler()?.(statusOf({ enabled: false, revision: 3 }));
    release(new Error("束縛できない"));
    await pending;
    expect(service.localMcpStatus()?.revision).toBe(3);
    expect(service.localMcpError()).toContain("操作に失敗した");
    expect(logText(service)).toContain("有効化に失敗した");
  });

  it("新しい操作が始まったら古い操作の失敗で上書きしない", async () => {
    const { service, stub } = prepareService();
    let releaseEnable!: (value: unknown) => void;
    const enableGate = new Promise<LocalMcpStatus>((_resolve, reject) => {
      releaseEnable = reject as (value: unknown) => void;
    });
    stub.client.enableLocalMcp.mockReturnValueOnce(enableGate);
    const first = service.enableLocalMcp();
    // 新しい停止操作が始まり成功する。
    stub.client.disableLocalMcp.mockResolvedValueOnce(
      statusOf({ enabled: false, port: null, url: null, revision: 5 }),
    );
    await service.disableLocalMcp();
    expect(service.localMcpError()).toBe("");
    // 古い有効化の失敗が遅れて届いても上書きしない。
    releaseEnable(new Error("束縛できない"));
    await first;
    expect(service.localMcpStatus()?.revision).toBe(5);
    expect(service.localMcpError()).toBe("");
    expect(logText(service)).not.toContain("有効化に失敗した");
  });

  it("古い版の操作応答で新しい公開状態を巻き戻さない", async () => {
    const { service, stub } = prepareService();
    stub.client.enableLocalMcp.mockResolvedValueOnce(statusOf({ enabled: true, revision: 1 }));
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 5 }));
    await service.enableLocalMcp();
    // 完了表示は自分の操作として反映するが、版は新しい方を保つ。
    expect(service.localMcpStatus()?.revision).toBe(5);
    expect(service.localMcpStatus()?.enabled).toBe(false);
    expect(service.localMcpError()).toBe("");
  });

  it("三連続操作では実行中は送らず応答後に新しい停止を送り古い応答で上書きしない", async () => {
    const { service, stub } = prepareService();
    // 停止Aの応答を保留する。
    let releaseFirst!: (value: LocalMcpStatus) => void;
    const firstGate = new Promise<LocalMcpStatus>((resolve) => {
      releaseFirst = resolve;
    });
    stub.client.disableLocalMcp.mockReturnValueOnce(firstGate);
    const first = service.disableLocalMcp();
    // 実行中は停止の実行中旗が立ち、二重押下は送らない。
    expect(service.localMcpDisablePending()).toBe(true);
    await service.disableLocalMcp();
    expect(stub.client.disableLocalMcp).toHaveBeenCalledTimes(1);
    // 停止完了の push が届く。
    stub.mcpPushHandler()?.(statusOf({ enabled: false, port: null, url: null, revision: 4 }));
    // 有効化Bは種類が異なるため実行でき、完了する。
    stub.client.enableLocalMcp.mockResolvedValueOnce(statusOf({ enabled: true, revision: 5 }));
    await service.enableLocalMcp();
    expect(service.localMcpStatus()?.enabled).toBe(true);
    expect(service.localMcpError()).toBe("");
    // 応答前に新しい停止を押しても実行中のため送らない。
    await service.disableLocalMcp();
    expect(stub.client.disableLocalMcp).toHaveBeenCalledTimes(1);
    expect(service.localMcpDisablePending()).toBe(true);
    // 停止Aの古い応答が返っても新しい表示（有効）を上書きしない。
    releaseFirst(statusOf({ enabled: false, port: null, url: null, revision: 4 }));
    await first;
    expect(service.localMcpDisablePending()).toBe(false);
    expect(service.localMcpStatus()).toEqual(statusOf({ enabled: true, revision: 5 }));
    expect(logText(service)).not.toContain("製品向け MCP を停止した");
    // 応答後は新しい停止Cを送れる。
    stub.client.disableLocalMcp.mockResolvedValueOnce(
      statusOf({ enabled: false, port: null, url: null, revision: 6 }),
    );
    await service.disableLocalMcp();
    expect(stub.client.disableLocalMcp).toHaveBeenCalledTimes(2);
    expect(service.localMcpStatus()?.enabled).toBe(false);
    expect(logText(service)).toContain("製品向け MCP を停止した");
  });
});
