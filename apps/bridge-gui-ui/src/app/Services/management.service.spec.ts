import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ManagementSnapshot,
  OwnedPluginInstanceSummary,
} from "bridge-gui-contract/management";
import type { PairingViewResult } from "bridge-gui-contract/management";
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
  const client = {
    setProbeHandler: vi.fn(),
    setDevObserveHandler: vi.fn(),
    onStateChanged: vi.fn((handler: StateChangedHandler): (() => void) => {
      pushHandler = handler;
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
    notifyViewReady: vi.fn(),
    retryPluginMount: vi.fn(async (_instanceId: string) => ({ ok: true as const })),
  };
  return { client, pushHandler: (): StateChangedHandler | null => pushHandler };
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
    ready: false,
    revision: 1,
    instanceId: "i1",
    localSessionId: "s1",
    portId: "text",
    ...overrides,
  };
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

  it("準備完了の通知に文書題を載せる", () => {
    const { service, stub } = prepareService();
    document.title = "題の写し";
    service.notifyReady();
    expect(stub.client.notifyViewReady).toHaveBeenCalledWith("題の写し");
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

describe("子画面タグの照合", () => {
  it("配置一覧に従ってタグを置き消えたものを外す", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({
          revision: 3,
          pluginMounts: [makePluginMount("plugin-text-1"), makePluginMount("plugin-text-2")],
        }),
      );
      await service.fetchInitial();
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(2);
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 4, pluginMounts: [makePluginMount("plugin-text-2")] }),
      );
      await service.fetchInitial();
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

  it("更新でタグを作り直さず src を変えない", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 3, pluginMounts: [makePluginMount("plugin-text-1")] }),
      );
      await service.fetchInitial();
      const before = hosts.plugin.querySelector("electrobun-webview");
      // 所有一覧の URL 表記が変わっても既存は触らない。
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({
          revision: 4,
          pluginMounts: [
            {
              ...makePluginMount("plugin-text-1"),
              initialUrl: "views://plugin-host/blank.html#mount=plugin-text-1x",
              ready: true,
              revision: 2,
            },
          ],
        }),
      );
      await service.fetchInitial();
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
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 3, pluginMounts: [makePluginMount("plugin-text-1")] }),
      );
      await service.fetchInitial();
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
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 3, pluginMounts: [makePluginMount("plugin-text-1")] }),
      );
      await service.fetchInitial();
      const before = hosts.plugin.querySelector("electrobun-webview");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      // 改訂が進んでも同一ノードを保つ。
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 4, pluginMounts: [makePluginMount("plugin-text-1")] }),
      );
      await service.fetchInitial();
      expect(hosts.plugin.querySelector("electrobun-webview")).toBe(before);
      // 配置が消えたら外す。
      stub.client.getSnapshot.mockResolvedValueOnce(makeSnapshot({ revision: 5 }));
      await service.fetchInitial();
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(0);
    } finally {
      hosts.dispose();
    }
  });

  it("ready 前後で host とタグ参照が保たれる", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      const hostBefore = hosts.plugin;
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 3, pluginMounts: [makePluginMount("plugin-text-1")] }),
      );
      await service.fetchInitial();
      const tagBefore = hosts.plugin.querySelector("electrobun-webview");
      expect(tagBefore).not.toBe(null);
      // ready になっても host・タグ参照は保たれる（作り直さない）。
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({
          revision: 4,
          pluginMounts: [{ ...makePluginMount("plugin-text-1"), ready: true, revision: 2 }],
        }),
      );
      await service.fetchInitial();
      expect(hosts.plugin).toBe(hostBefore);
      expect(hosts.plugin.querySelector("electrobun-webview")).toBe(tagBefore);
      expect(tagBefore?.getAttribute("src")).toBe(
        "views://plugin-host/blank.html#mount=plugin-text-1",
      );
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

  it("activeで配置なし・未readyは準備中でありreadyで見せる", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      }),
    );
    await service.fetchInitial();
    expect(service.pluginViewStateFor("i1")).toEqual({ kind: "preparing" });
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        revision: 4,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
        pluginMounts: [{ ...makePluginMount("plugin-text-1"), ready: true, revision: 2 }],
      }),
    );
    await service.fetchInitial();
    expect(service.pluginViewStateFor("i1")).toEqual({ kind: "ready" });
  });

  it("activeで選択個体の失敗は再試行付きの失敗になる", async () => {
    const { service, stub } = prepareService();
    const failed: ManagementSnapshot = makeSnapshot({
      revision: 3,
      plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
      pluginMountFailures: [
        { kind: "text", reason: "生成待ちが失効した", instanceId: "i1", localSessionId: null },
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
      makeSnapshot({
        revision: 3,
        plugins: { kinds: [], instances: [instanceOf("i1")], assignments: [] },
        pluginMountFailures: [
          { kind: "text", reason: "生成待ちが失効した", instanceId: "i1", localSessionId: null },
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
      makeSnapshot({
        revision: 3,
        plugins: {
          kinds: [],
          instances: [instanceOf("i1"), instanceOf("i2", { localSessionId: "s2" })],
          assignments: [],
        },
        pluginMountFailures: [
          { kind: "text", reason: "失敗1", instanceId: "i1", localSessionId: null },
          { kind: "text", reason: "失敗2", instanceId: "i2", localSessionId: null },
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
      makeSnapshot({
        revision: 3,
        plugins: owned,
        pluginMountFailures: [
          { kind: "text", reason: "古い失敗", instanceId: "i1", localSessionId: null },
        ],
      }),
    );
    await service.fetchInitial();
    stub.client.retryPluginMount.mockRejectedValueOnce(new Error("受付不可"));
    await service.retryPluginMount("i1");
    expect(service.retryRequestFailed()).toContain("i1");
    // 採用中 snapshot から失敗が消えたら注記も消える。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 4, plugins: owned, pluginMountFailures: [] }),
    );
    await service.fetchInitial();
    expect(service.retryRequestFailed()).not.toContain("i1");
    // 別原因で再失敗しても古い注記は載らない。
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        revision: 5,
        plugins: owned,
        pluginMountFailures: [
          { kind: "text", reason: "新しい失敗", instanceId: "i1", localSessionId: null },
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

// 子画面の表示制御。native 表示は `toggleHidden` でのみ切り替え、
// HTML の `hidden` 属性・CSS・矩形 0x0 では保証しないことを前提にする。
// happy-dom では未知要素のため fake（`toggleHidden` と `webviewId`）で
// desired の算出・適用・再試行・RPC 不送出・非再生成を確かめる。
// native の見え方自体は自動検証できない。

/** 実プラグイン配置の試験値（個体を指定できる）。 */
function makePluginMountWithInstance(mountId: string, instanceId: string) {
  return {
    ...makePluginMount(mountId),
    instanceId,
  };
}

/** 配置済みタグへ fake の表示口を付ける。初期化済みとして扱う。 */
function attachVisibilityFake(tag: Element | null | undefined) {
  if (tag === null || tag === undefined) {
    throw new Error("表示対象のタグが無い");
  }
  const fake = tag as unknown as { toggleHidden: ReturnType<typeof vi.fn>; webviewId: number };
  fake.toggleHidden = vi.fn();
  fake.webviewId = 7;
  return fake;
}

/** 全 stub 呼び出し回数の写し。表示切替が業務 RPC を送らないことの照合用である。 */
function rpcCallCounts(stub: ReturnType<typeof prepareRpcStub>["client"]) {
  return [
    stub.getSnapshot.mock.calls.length,
    stub.enableAcceptance.mock.calls.length,
    stub.disableAcceptance.mock.calls.length,
    stub.getPairingView.mock.calls.length,
    stub.approvePairing.mock.calls.length,
    stub.rejectPairing.mock.calls.length,
    stub.disconnectConnection.mock.calls.length,
    stub.assignPlugin.mock.calls.length,
    stub.unassignPlugin.mock.calls.length,
    stub.quit.mock.calls.length,
    stub.retryPluginMount.mock.calls.length,
  ];
}

/** 所有付き snapshot を採用する。 */
async function adoptOwned(
  stub: ReturnType<typeof prepareRpcStub>,
  revision: number,
  instances: readonly OwnedPluginInstanceSummary[],
  mounts: readonly ReturnType<typeof makePluginMount>[] = [],
) {
  stub.client.getSnapshot.mockResolvedValueOnce(
    makeSnapshot({
      revision,
      plugins: { kinds: [], instances: [...instances], assignments: [] },
      pluginMounts: [...mounts],
    }),
  );
}

describe("子画面の表示制御", () => {
  it("可視条件は操作選択かつ選択個体かつactiveかつ当該マウントreadyである", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1")],
        [makePluginMountWithInstance("plugin-text-1", "i1")],
      );
      await service.fetchInitial();
      const tag = attachVisibilityFake(hosts.plugin.querySelector("electrobun-webview"));
      // 未 ready では操作選択・個体一致でも隠す（生成は継続する）。
      service.setPluginViewState(true, "i1");
      expect(tag.toggleHidden).toHaveBeenCalledWith(true);
      // ready で初めて見せる。
      await adoptOwned(
        stub,
        4,
        [instanceOf("i1")],
        [{ ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true, revision: 2 }],
      );
      await service.fetchInitial();
      expect(tag.toggleHidden).toHaveBeenLastCalledWith(false);
    } finally {
      hosts.dispose();
    }
  });

  it("表示対象だけを見せ他を隠す", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1"), instanceOf("i2", { localSessionId: "s2" })],
        [
          { ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true },
          { ...makePluginMountWithInstance("plugin-text-2", "i2"), ready: true },
        ],
      );
      await service.fetchInitial();
      const first = attachVisibilityFake(hosts.plugin.querySelector("#plugin-plugin-text-1"));
      const second = attachVisibilityFake(hosts.plugin.querySelector("#plugin-plugin-text-2"));
      service.setPluginViewState(true, "i1");
      expect(first.toggleHidden).toHaveBeenCalledWith(false);
      expect(second.toggleHidden).toHaveBeenCalledWith(true);
    } finally {
      hosts.dispose();
    }
  });

  it("operations 未選択・対象無し・非activeでは全て隠す", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1")],
        [{ ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true }],
      );
      await service.fetchInitial();
      const tag = attachVisibilityFake(hosts.plugin.querySelector("electrobun-webview"));
      service.setPluginViewState(false, "i1");
      expect(tag.toggleHidden).toHaveBeenCalledWith(true);
      service.setPluginViewState(true, null);
      expect(tag.toggleHidden).toHaveBeenLastCalledWith(true);
      // 所有段階が active でなければ ready 配置があっても隠す。
      await adoptOwned(
        stub,
        4,
        [instanceOf("i1", { phase: "cleanupFailed" })],
        [{ ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true, revision: 2 }],
      );
      await service.fetchInitial();
      service.setPluginViewState(true, "i1");
      expect(tag.toggleHidden).toHaveBeenLastCalledWith(true);
    } finally {
      hosts.dispose();
    }
  });

  it("切替でタグを作り直さず src を変えず業務RPCを送らない", async () => {
    const hosts = preparePluginHost();
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1")],
        [{ ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true }],
      );
      await service.fetchInitial();
      const before = hosts.plugin.querySelector("electrobun-webview");
      attachVisibilityFake(before);
      const baseline = rpcCallCounts(stub.client);
      service.setPluginViewState(true, "i1");
      service.setPluginViewState(false, null);
      service.setPluginViewState(true, "i1");
      const after = hosts.plugin.querySelector("electrobun-webview");
      expect(after).toBe(before);
      expect(after?.getAttribute("src")).toBe("views://plugin-host/blank.html#mount=plugin-text-1");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      expect(rpcCallCounts(stub.client)).toEqual(baseline);
    } finally {
      hosts.dispose();
    }
  });

  it("toggleHidden未定義でも有限再試行し上限で諦める", async () => {
    const hosts = preparePluginHost();
    const frames: FrameRequestCallback[] = [];
    const original = (globalThis as { requestAnimationFrame?: unknown })["requestAnimationFrame"];
    (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = (
      callback: FrameRequestCallback,
    ): number => {
      frames.push(callback);
      return frames.length;
    };
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1")],
        [makePluginMountWithInstance("plugin-text-1", "i1")],
      );
      await service.fetchInitial();
      // happy-dom の未知要素のまま（`toggleHidden` が無い）で呼ぶ。
      expect(() => service.setPluginViewState(true, "i1")).not.toThrow();
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      // 未定義経路も有限再試行を予約する。
      expect(frames.length).toBeGreaterThan(0);
      // 上限まで枠を進めても確実に終わる（無制限ループにしない）。
      for (let step = 0; step < 200; step += 1) {
        if (frames.length === 0) {
          break;
        }
        frames.splice(0).forEach((callback) => {
          callback(0);
        });
      }
      expect(frames.length).toBe(0);
      expect(
        service
          .eventLog()
          .map((entry) => entry.message)
          .join("\n"),
      ).toContain("諦めた");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
    } finally {
      if (original === undefined) {
        delete (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"];
      } else {
        (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = original;
      }
      hosts.dispose();
    }
  });

  it("後からtoggleHiddenが生えた要素にdesiredを適用する", async () => {
    const hosts = preparePluginHost();
    const frames: FrameRequestCallback[] = [];
    const original = (globalThis as { requestAnimationFrame?: unknown })["requestAnimationFrame"];
    (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = (
      callback: FrameRequestCallback,
    ): number => {
      frames.push(callback);
      return frames.length;
    };
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1")],
        [{ ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true }],
      );
      await service.fetchInitial();
      const tag = hosts.plugin.querySelector("electrobun-webview") as unknown as {
        toggleHidden?: ReturnType<typeof vi.fn>;
        webviewId?: number | null;
      };
      // custom element の upgrade 前であり、`toggleHidden` は未定義である。
      expect(tag.toggleHidden).toBe(undefined);
      const before = hosts.plugin.querySelector("electrobun-webview");
      service.setPluginViewState(true, "i1");
      expect(frames.length).toBeGreaterThan(0);
      // upgrade 後に初期化が済むと、保持した desired（対象一致のため見せる）を適用する。
      tag.toggleHidden = vi.fn();
      tag.webviewId = 9;
      frames.splice(0).forEach((callback) => {
        callback(0);
      });
      expect(tag.toggleHidden).toHaveBeenCalledWith(false);
      expect(hosts.plugin.querySelector("electrobun-webview")).toBe(before);
      expect(before?.getAttribute("src")).toBe(
        "views://plugin-host/blank.html#mount=plugin-text-1",
      );
    } finally {
      if (original === undefined) {
        delete (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"];
      } else {
        (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = original;
      }
      hosts.dispose();
    }
  });

  it("未初期化ではrAFで再試行し初期化後に適用する", async () => {
    const hosts = preparePluginHost();
    const frames: FrameRequestCallback[] = [];
    const original = (globalThis as { requestAnimationFrame?: unknown })["requestAnimationFrame"];
    (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = (
      callback: FrameRequestCallback,
    ): number => {
      frames.push(callback);
      return frames.length;
    };
    try {
      const { service, stub } = prepareService();
      service.registerPluginHost(hosts.plugin);
      await adoptOwned(
        stub,
        3,
        [instanceOf("i1")],
        [{ ...makePluginMountWithInstance("plugin-text-1", "i1"), ready: true }],
      );
      await service.fetchInitial();
      const tag = hosts.plugin.querySelector("electrobun-webview") as unknown as {
        toggleHidden: ReturnType<typeof vi.fn>;
        webviewId: number | null;
      };
      tag.toggleHidden = vi.fn();
      tag.webviewId = null;
      const before = hosts.plugin.querySelector("electrobun-webview");
      service.setPluginViewState(true, "i1");
      // 未初期化のため何も送らず、再試行を予約する。
      expect(tag.toggleHidden).not.toHaveBeenCalled();
      expect(frames.length).toBeGreaterThan(0);
      // 初期化後に枠を進めると適用する。タグは作り直さない。
      tag.webviewId = 11;
      frames.splice(0).forEach((callback) => {
        callback(0);
      });
      expect(tag.toggleHidden).toHaveBeenCalledWith(false);
      expect(hosts.plugin.querySelector("electrobun-webview")).toBe(before);
    } finally {
      if (original === undefined) {
        delete (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"];
      } else {
        (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = original;
      }
      hosts.dispose();
    }
  });
});
