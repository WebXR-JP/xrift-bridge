import { describe, expect, it, vi } from "vite-plus/test";
import type { PairingViewResult } from "bridge-gui-contract/management";
import type { SpikeMountSummary } from "bridge-gui-contract/plugin-spike";
import { ManagementService } from "./management.service.ts";
import type { ManagementRpcClient, StateChangedHandler } from "./rpc.ts";
import { makeSnapshot } from "./snapshot-fixture.ts";

// 表示状態の採用と限定操作。RPC は代役に差し替え、実接続は作らない。
// 比較コード本文・業務 payload・テキスト本文は代役にも載せない。

/** 表示用の比較コード取得結果（試験用）。本文は試験内の定数に閉じる。 */
function makePairingView(requestId: string): PairingViewResult {
  return { available: true, requestId, code: "041003", displayCode: "041 003" };
}

/** 試験用の接続口の代役。push 処理の受付けと送受信の記録だけを行う。 */
function prepareRpcStub() {
  let pushHandler: StateChangedHandler | null = null;
  const noSpikes: readonly SpikeMountSummary[] = [];
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
    assignDiagnostics: vi.fn(async (localSessionId: string) => ({
      localSessionId,
      instanceId: "i1",
      portId: "diagnostic",
    })),
    assignText: vi.fn(async () => ({
      localSessionId: "s1",
      instanceId: "i1",
      portId: "text",
    })),
    sendText: vi.fn(async () => ({ status: "acknowledged" as const })),
    unassignText: vi.fn(async () => ({ ok: true as const })),
    quit: vi.fn(async () => ({ ok: true as const })),
    notifyViewReady: vi.fn(),
    createSpike: vi.fn(async () => ({
      mountId: "spike-1",
      initialUrl: "views://plugin-host/blank.html#mount=spike-1",
    })),
    destroySpike: vi.fn(async () => ({ ok: true as const })),
    pushSpike: vi.fn(async () => ({ revision: 2 })),
    listSpikes: vi.fn(async (): Promise<readonly SpikeMountSummary[]> => noSpikes),
    resetSpike: vi.fn(async () => ({ ok: true as const })),
    retryPluginMounts: vi.fn(async () => ({ ok: true as const })),
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
    expect(service.eventLog().join("\n")).toContain("無視");
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
    const log = service.eventLog().join("\n");
    expect(log).toContain("更新");
    expect(log).toContain("無視");
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
    await service.approvePairing("r1", "041003");
    await service.rejectPairing("r1");
    await service.disconnectConnection("c1");
    await service.assignDiagnostics("s1");
    expect(stub.client.approvePairing).toHaveBeenCalledTimes(1);
    expect(stub.client.rejectPairing).toHaveBeenCalledTimes(1);
    expect(stub.client.disconnectConnection).toHaveBeenCalledTimes(1);
    expect(stub.client.assignDiagnostics).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline + 4);
  });

  it("テキスト割当て・解除は要求後に再取得する", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.assignText();
    await service.unassignText();
    expect(stub.client.assignText).toHaveBeenCalledTimes(1);
    expect(stub.client.unassignText).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline + 2);
  });

  it("終了は要求だけ送り再取得しない", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.quit();
    expect(stub.client.quit).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline);
    expect(service.eventLog().join("\n")).toContain("終了");
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
    expect(service.eventLog().join("\n")).toContain("有効化に失敗");
  });

  it("テキスト割当ての失敗はカードの説明に出し本文は載せない", async () => {
    const { service, stub } = prepareService();
    stub.client.assignText.mockRejectedValueOnce(new Error("割当て不可"));
    await service.assignText();
    expect(service.textError()).toContain("割当て不可");
    expect(service.textError()).not.toContain("041003");
    expect(service.eventLog().join("\n")).toContain("テキスト割当てに失敗");
  });

  it("テキスト割当て解除の失敗はカードの説明に出す", async () => {
    const { service, stub } = prepareService();
    stub.client.unassignText.mockRejectedValueOnce(new Error("解除不可"));
    await service.unassignText();
    expect(service.textError()).toContain("解除不可");
  });

  it("テキスト割当ての成功は失敗表示を消す", async () => {
    const { service, stub } = prepareService();
    stub.client.assignText.mockRejectedValueOnce(new Error("割当て不可"));
    await service.assignText();
    expect(service.textError()).not.toBe("");
    await service.assignText();
    expect(service.textError()).toBe("");
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
    const first = service.approvePairing("r1", "041003");
    const second = service.approvePairing("r1", "041003");
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
  it("取得した表示は保留行の一時状態に残る", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    await service.showPairingView("r1");
    expect(service.pairingViews().get("r1")?.available).toBe(true);
  });

  it("保留が消えたら一時状態を破棄する", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    await service.showPairingView("r1");
    expect(service.pairingViews().has("r1")).toBe(true);
    stub.pushHandler()?.({ revision: 4, snapshot: makeSnapshot({ revision: 4, pending: [] }) });
    expect(service.pairingViews().has("r1")).toBe(false);
  });

  it("保留消滅後の遅延応答は再表示しない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    let release!: (value: PairingViewResult) => void;
    const gate = new Promise<PairingViewResult>((resolve) => {
      release = resolve;
    });
    stub.client.getPairingView.mockReturnValueOnce(gate);
    const shown = service.showPairingView("r1");
    // 応答待ちの間に保留が消える。
    stub.pushHandler()?.({ revision: 4, snapshot: makeSnapshot({ revision: 4, pending: [] }) });
    release(makePairingView("r1"));
    await shown;
    expect(service.pairingViews().has("r1")).toBe(false);
    expect(service.eventLog().join("\n")).toContain("破棄");
  });

  it("取得不能時は理由だけを残し本文は載せない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    stub.client.getPairingView.mockResolvedValueOnce({
      available: false,
      reason: "承認済みのため取得できない",
    });
    await service.showPairingView("r1");
    expect(service.pairingViews().get("r1")).toEqual({
      available: false,
      reason: "承認済みのため取得できない",
    });
    expect(service.eventLog().join("\n")).toContain("取得できない");
  });
});

describe("秘密の非記録", () => {
  it("比較コード本文が受信記録に載らない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    await service.showPairingView("r1");
    await service.approvePairing("r1", "041003");
    const log = service.eventLog().join("\n");
    expect(log).not.toContain("041003");
    expect(log).not.toContain("041 003");
  });

  it("比較コード本文が採用中の表示状態に載らない", async () => {
    const { service, stub } = prepareService();
    stub.client.getSnapshot.mockResolvedValueOnce(
      makeSnapshot({ revision: 3, pending: [{ requestId: "r1" }] }),
    );
    await service.fetchInitial();
    await service.showPairingView("r1");
    expect(JSON.stringify(service.snapshot())).not.toContain("041003");
    expect(JSON.stringify(service.snapshot())).not.toContain("041 003");
  });
});

// 子画面タグの照合。happy-dom では `electrobun-webview` は未知要素として
// 扱われるため、属性・同一ノード保持・個数で確かめる（描画は保証しない）。
// 本文は扱わない（mountId の要約だけを記録する）。

/** 照合試験用の配置先。文書に付け、試験後に外す。 */
function prepareMountHosts() {
  const spike = document.createElement("div");
  const plugin = document.createElement("div");
  document.body.append(spike, plugin);
  return {
    spike,
    plugin,
    dispose(): void {
      spike.remove();
      plugin.remove();
    },
  };
}

/** 段0所有一覧の試験値。 */
function makeSpikeMount(mountId: string, revision = 1) {
  return {
    mountId,
    initialUrl: `views://plugin-host/blank.html#mount=${mountId}`,
    phase: "pending" as const,
    ready: false,
    revision,
  };
}

/** 実プラグイン配置一覧の試験値。 */
function makePluginMount(mountId: string) {
  return {
    mountId,
    kind: "text" as const,
    initialUrl: `views://plugin-host/blank.html#mount=${mountId}`,
    phase: "pending" as const,
    ready: false,
    revision: 1,
    instanceId: "i1",
    localSessionId: "s1",
    portId: "text",
  };
}

describe("子画面タグの照合", () => {
  it("段0所有一覧に従ってタグを置き消えたものを外す", () => {
    const hosts = prepareMountHosts();
    try {
      const { service } = prepareService();
      service.registerMountHosts(hosts.spike, hosts.plugin);
      service.reconcileSpikeTags([makeSpikeMount("spike-1"), makeSpikeMount("spike-2")]);
      expect(hosts.spike.querySelectorAll("electrobun-webview").length).toBe(2);
      service.reconcileSpikeTags([makeSpikeMount("spike-2")]);
      const tags = hosts.spike.querySelectorAll("electrobun-webview");
      expect(tags.length).toBe(1);
      expect(tags[0]?.id).toBe("spike-spike-2");
      expect(service.eventLog().join("\n")).toContain("mountId=spike-1");
    } finally {
      hosts.dispose();
    }
  });

  it("更新でタグを作り直さず src を変えない", () => {
    const hosts = prepareMountHosts();
    try {
      const { service } = prepareService();
      service.registerMountHosts(hosts.spike, hosts.plugin);
      service.reconcileSpikeTags([makeSpikeMount("spike-1")]);
      const before = hosts.spike.querySelector("electrobun-webview");
      // 所有一覧の URL 表記が変わっても既存は触らない。
      service.reconcileSpikeTags([
        {
          ...makeSpikeMount("spike-1", 2),
          initialUrl: "views://plugin-host/blank.html#mount=spike-1x",
          ready: true,
        },
      ]);
      const after = hosts.spike.querySelector("electrobun-webview");
      expect(after).toBe(before);
      expect(after?.getAttribute("src")).toBe("views://plugin-host/blank.html#mount=spike-1");
      expect(hosts.spike.querySelectorAll("electrobun-webview").length).toBe(1);
    } finally {
      hosts.dispose();
    }
  });

  it("段0タグは main 照合の属性だけを載せる", () => {
    const hosts = prepareMountHosts();
    try {
      const { service } = prepareService();
      service.registerMountHosts(hosts.spike, hosts.plugin);
      service.reconcileSpikeTags([makeSpikeMount("spike-1")]);
      const tag = hosts.spike.querySelector("electrobun-webview");
      expect(tag?.getAttribute("src")).toBe("views://plugin-host/blank.html#mount=spike-1");
      expect(tag?.getAttribute("renderer")).toBe("native");
      expect(tag?.getAttribute("navigation-rules")).toContain("plugin-spike");
      expect(tag?.id).toBe("spike-spike-1");
      expect(tag?.hasAttribute("sandbox")).toBe(false);
    } finally {
      hosts.dispose();
    }
  });

  it("実プラグイン配置一覧に従ってタグを置き更新で作り直さない", async () => {
    const hosts = prepareMountHosts();
    try {
      const { service, stub } = prepareService();
      service.registerMountHosts(hosts.spike, hosts.plugin);
      stub.client.getSnapshot.mockResolvedValueOnce(
        makeSnapshot({ revision: 3, pluginMounts: [makePluginMount("plugin-text-1")] }),
      );
      await service.fetchInitial();
      const before = hosts.plugin.querySelector("electrobun-webview");
      expect(hosts.plugin.querySelectorAll("electrobun-webview").length).toBe(1);
      expect(before?.getAttribute("renderer")).toBe("native");
      expect(before?.getAttribute("navigation-rules")).toContain("plugin-text");
      expect(before?.id).toBe("plugin-plugin-text-1");
      expect(before?.hasAttribute("sandbox")).toBe(false);
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

  it("配置した段0タグが文書に残れば同一性保持になる", () => {
    const hosts = prepareMountHosts();
    try {
      const { service } = prepareService();
      expect(service.isSpikeTagKept()).toBe(false);
      service.registerMountHosts(hosts.spike, hosts.plugin);
      service.reconcileSpikeTags([makeSpikeMount("spike-1")]);
      expect(service.isSpikeTagKept()).toBe(true);
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
});

describe("子画面操作の要求送出", () => {
  it("子画面の作成は要求後に所有一覧を読み直す", async () => {
    const hosts = prepareMountHosts();
    try {
      const { service, stub } = prepareService();
      service.registerMountHosts(hosts.spike, hosts.plugin);
      stub.client.listSpikes.mockResolvedValueOnce([makeSpikeMount("spike-1")]);
      await service.createSpike();
      expect(stub.client.createSpike).toHaveBeenCalledTimes(1);
      expect(stub.client.listSpikes).toHaveBeenCalledTimes(1);
      expect(hosts.spike.querySelectorAll("electrobun-webview").length).toBe(1);
      expect(service.spikeMounts().map((mount) => mount.mountId)).toEqual(["spike-1"]);
    } finally {
      hosts.dispose();
    }
  });

  it("子画面への送信・破棄・全破棄は識別子を載せて送る", async () => {
    const { service, stub } = prepareService();
    await service.pushSpike("spike-1");
    await service.destroySpike("spike-1");
    await service.resetSpikes();
    expect(stub.client.pushSpike).toHaveBeenCalledWith("spike-1");
    expect(stub.client.destroySpike).toHaveBeenCalledWith("spike-1");
    expect(stub.client.resetSpike).toHaveBeenCalledTimes(1);
    // いずれも所有一覧の読直しを伴う。
    expect(stub.client.listSpikes).toHaveBeenCalledTimes(3);
    expect(service.eventLog().join("\n")).toContain("mountId=spike-1");
  });

  it("実プラグインの再試行は要求後に最新状態を読み直す", async () => {
    const { service, stub } = prepareService();
    await service.fetchInitial();
    const baseline = stub.client.getSnapshot.mock.calls.length;
    await service.retryPluginMounts();
    expect(stub.client.retryPluginMounts).toHaveBeenCalledTimes(1);
    expect(stub.client.getSnapshot.mock.calls.length).toBe(baseline + 1);
    expect(service.eventLog().join("\n")).toContain("再試行を要求した");
  });
});
