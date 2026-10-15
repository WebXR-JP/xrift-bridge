/**
 * 束縛個体限定の参照口の検証。
 *
 * `createBoundPluginRef` が各利用時に所有段階・現割当てを照合し、対象識別子を
 * 引数に取る到達口・管理 backend・全個体一覧を渡さないことを確かめる。
 * 実バックエンドでは割当て・解除と参照口の失効の連動を通す。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import { createConnectionRequest, type SessionProvider } from "world-client";
import { GuiBackend } from "../src/main/backend.ts";
import {
  registerBundledPlugins,
  resolveBundledPluginViewPath,
} from "../src/composition/bundled-plugins.ts";
import { createBoundPluginRef } from "../src/main/plugin-instances.ts";
import { PluginInstanceManager } from "../src/main/plugin-instance-manager.ts";
import {
  alphaDescriptor,
  firstFitPolicy,
  makeSession,
  setupFixture,
  type AlphaOperations,
  type AlphaState,
} from "./plugin-instance-manager-fakes.ts";

/** 検証用の組み立て。 */
function setupRef() {
  const fixture = setupFixture([makeSession("local-1", "conn-a")]);
  const manager = new PluginInstanceManager(fixture.dependencies);
  manager.register(alphaDescriptor({ assignment: firstFitPolicy(null) }));
  const binding = manager.assign("alpha");
  return { fixture, manager, binding };
}

test("参照口は束縛個体の状態と操作にだけ届く", () => {
  const { manager, binding } = setupRef();
  const ref = manager.createBoundRef<AlphaState, AlphaOperations>("alpha", binding.instanceId);
  expect(ref.getBinding()).toEqual(binding);
  expect(ref.readState()).toEqual({ count: 0 });
  expect(ref.withOperations((operations) => operations.add(3))).toBe(3);
  expect(ref.readState()).toEqual({ count: 3 });
});

test("参照口は各利用時に照合し失効後は拒否する", () => {
  const { fixture, manager, binding } = setupRef();
  const ref = manager.createBoundRef<AlphaState, AlphaOperations>("alpha", binding.instanceId);
  fixture.sessions.emitEnded("local-1");
  expect(() => ref.getBinding()).toThrow(RangeError);
  expect(() => ref.readState()).toThrow(RangeError);
  expect(() => ref.withOperations((operations) => operations.add(1))).toThrow(RangeError);
});

test("参照口は対象識別子を引数に取る到達口を持たない", () => {
  const { manager, binding } = setupRef();
  const ref = manager.createBoundRef<AlphaState, AlphaOperations>("alpha", binding.instanceId);
  const surface = ref as unknown as Record<string, unknown>;
  expect(surface["getBinding"]).toBeDefined();
  expect(surface["readState"]).toBeDefined();
  expect(surface["withOperations"]).toBeDefined();
  expect(surface["requireBinding"]).toBeUndefined();
  expect(surface["listBindings"]).toBeUndefined();
  expect(surface["manager"]).toBeUndefined();
});

test("直接組み立ての参照口も照合に従う", () => {
  const { manager, binding } = setupRef();
  let calls = 0;
  const ref = createBoundPluginRef<AlphaState, AlphaOperations>({
    readBinding: () => {
      calls += 1;
      return manager.requireBinding("alpha", binding.instanceId);
    },
    readStateValue: () => {
      const record = manager.requireBinding("alpha", binding.instanceId);
      void record;
      return { count: 7 } as AlphaState;
    },
    useOperationsValue: (use) => use({ add: () => 9 } as unknown as AlphaOperations, binding),
  });
  expect(ref.getBinding()).toEqual(binding);
  expect(calls).toBe(1);
  expect(ref.readState()).toEqual({ count: 7 });
});

const TEST_ORIGIN = "https://gui-instance-test.invalid";

const backends: GuiBackend[] = [];
const providers: SessionProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      provider.close();
    } catch {
      // 後処理の閉塞失敗は無視する。
    }
  }
  for (const backend of backends.splice(0)) {
    try {
      await backend.close();
    } catch {
      // 後処理の終了失敗は無視する。
    }
  }
});

/** 試験用のバックエンドを生成する。待ち受けは空きポート自動選択である。 */
async function startBackend(): Promise<GuiBackend> {
  const backend = await GuiBackend.create(
    { port: 0, allowedOrigins: [TEST_ORIGIN] },
    {
      registerPlugins: registerBundledPlugins,
      resolvePluginViewPath: resolveBundledPluginViewPath,
    },
  );
  backends.push(backend);
  expect(backend.getSnapshot().backend).toBe("ready");
  return backend;
}

/** 出来事の到達を待つ。時刻の長さではなく到達で確定する。 */
async function waitForArrival(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} を観測できない。`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 受付→承認→管理口の解決まで進める。
 *
 * 両方の約束に扱いを付け、未処理の拒否を残さない。
 */
async function approveConnection(backend: GuiBackend): Promise<SessionProvider> {
  const endpoint = backend.getSnapshot().endpoint;
  if (endpoint === null) throw new Error("公開先が無い。");
  const request = createConnectionRequest({
    endpoint: endpoint.url,
    origin: TEST_ORIGIN,
  });
  void request.sessionProvider.catch(() => {});
  const pairing = await request.pairingInfo;
  const approved = backend.approvePairing({ requestId: pairing.requestId });
  expect(approved.status).toBe("APPROVED");
  const provider = await request.sessionProvider;
  providers.push(provider);
  return provider;
}

test("実バックエンドの参照口は解除後に失効する", async () => {
  const backend = await startBackend();
  backend.enableAcceptance();
  const provider = await approveConnection(backend);
  const before = backend.getSnapshot().sessions.length;
  const session = await provider.tryCreateSession({
    sessionId: TEXT_SESSION_ID,
    kind: "reliable",
    direction: "bidirectional",
  });
  await waitForArrival(
    () => backend.getSnapshot().sessions.length === before + 1,
    "生存セッションの公開",
  );
  session.onMessage((payload) => {
    if (typeof payload === "object" && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (record["op"] === "show" && typeof record["id"] === "string") {
        void session.sendReliable({ op: "shown", id: record["id"] });
      }
    }
  });

  const assignment = backend.assignPlugin({ pluginKind: "text" });
  const manager = backend.instanceManager;
  if (manager === null) throw new Error("管理層が無い。");
  const ref = manager.createBoundRef<unknown, unknown>("text", assignment.instanceId);
  expect(ref.getBinding().instanceId).toBe(assignment.instanceId);

  // 解除後は失効として拒否し、古い割当てへ転送しない。
  backend.unassignPlugin({
    instanceId: assignment.instanceId,
    localSessionId: assignment.localSessionId,
    portId: assignment.portId,
  });
  expect(() => ref.getBinding()).toThrow(RangeError);
  expect(() => ref.readState()).toThrow(RangeError);
});
