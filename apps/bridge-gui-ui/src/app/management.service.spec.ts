import { describe, expect, it, vi } from "vite-plus/test";
import { ManagementService } from "./management.service.ts";
import type { ManagementRpcClient, StateChangedHandler } from "./rpc.ts";
import { makeSnapshot } from "./snapshot-fixture.ts";

// 表示状態の採用と限定操作。RPC は代役に差し替え、実接続は作らない。

/** 試験用の接続口の代役。push 処理の受付けと送受信の記録だけを行う。 */
function prepareRpcStub() {
  let pushHandler: StateChangedHandler | null = null;
  const client = {
    setProbeHandler: vi.fn(),
    onStateChanged: vi.fn((handler: StateChangedHandler): (() => void) => {
      pushHandler = handler;
      return () => {};
    }),
    getSnapshot: vi.fn(async () => makeSnapshot({ revision: 3 })),
    enableAcceptance: vi.fn(async () => ({ accepting: true })),
    disableAcceptance: vi.fn(async () => ({ accepting: false })),
    notifyViewReady: vi.fn(),
    createSpike: vi.fn(),
    resetSpike: vi.fn(),
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

  it("準備完了の通知に文書題を載せる", () => {
    const { service, stub } = prepareService();
    document.title = "題の写し";
    service.notifyReady();
    expect(stub.client.notifyViewReady).toHaveBeenCalledWith("題の写し");
  });
});
