/**
 * 接続手順の検証。接続開始の差し替え口に偽の管理口を渡し、
 * 進行・比較コードの表示・認可・切断の反映を確かめる。
 */
import { expect, test } from "vite-plus/test";
import { WorldClientError, type PairingInfo, type SessionProvider } from "world-client";
import { BridgeConnection } from "../connection.ts";

/** 手で解決できる約束。 */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 接続終端だけを持つ偽の管理口。 */
function createFakeProvider(): {
  readonly provider: SessionProvider;
  readonly close: () => void;
} {
  let alive = true;
  const closedHandlers = new Set<(cause: Error) => void>();
  const close = (): void => {
    if (!alive) return;
    alive = false;
    for (const handler of closedHandlers) {
      handler(new WorldClientError("CONNECTION_CLOSED", "閉じた"));
    }
  };
  const provider = {
    connectionId: "conn-1",
    get isAlive(): boolean {
      return alive;
    },
    tryCreateSession: (): Promise<never> => Promise.reject(new Error("接続の試験では使わない。")),
    onSession: (): (() => void) => () => undefined,
    onClosed: (handler: (cause: Error) => void): (() => void) => {
      closedHandlers.add(handler);
      return () => {
        closedHandlers.delete(handler);
      };
    },
    close,
  };
  return { provider: provider as unknown as SessionProvider, close };
}

test("接続先が正規の loopback でなければ生成を拒否する", () => {
  expect(() => new BridgeConnection({ endpoint: "ws://localhost:3100/v1" })).toThrow(RangeError);
});

test("接続開始から比較コード表示、認可までの進行を写しに反映する", async () => {
  const pairing = deferred<PairingInfo>();
  const provider = deferred<SessionProvider>();
  const connection = new BridgeConnection({
    endpoint: "ws://127.0.0.1:3100/v1",
    createRequest: () => ({ pairingInfo: pairing.promise, sessionProvider: provider.promise }),
  });
  expect(connection.getSnapshot().phase).toBe("idle");

  connection.connect();
  expect(connection.getSnapshot().phase).toBe("connecting");

  pairing.resolve({ requestId: "req-1", code: "123456" });
  await Promise.resolve();
  expect(connection.getSnapshot().phase).toBe("awaiting_approval");
  expect(connection.getSnapshot().pairing).toEqual({ requestId: "req-1", code: "123456" });

  const fake = createFakeProvider();
  provider.resolve(fake.provider);
  await Promise.resolve();
  expect(connection.getSnapshot().phase).toBe("authorized");
  expect(connection.getSnapshot().pairing).toBeNull();
  expect(connection.getAuthorizedProvider()).toBe(fake.provider);
});

test("取消は承認待ちを取り消して終了にする", () => {
  const pairing = deferred<PairingInfo>();
  const provider = deferred<SessionProvider>();
  const connection = new BridgeConnection({
    endpoint: "ws://127.0.0.1:3100/v1",
    createRequest: () => ({ pairingInfo: pairing.promise, sessionProvider: provider.promise }),
  });
  connection.connect();
  connection.cancel();
  expect(connection.getSnapshot().phase).toBe("ended");
  expect(connection.getSnapshot().pairing).toBeNull();
  expect(connection.getSnapshot().error).toBeNull();
});

test("非自発の切断は失敗として写しに載せる", () => {
  const pairing = deferred<PairingInfo>();
  const provider = deferred<SessionProvider>();
  const fake = createFakeProvider();
  const connection = new BridgeConnection({
    endpoint: "ws://127.0.0.1:3100/v1",
    createRequest: () => ({ pairingInfo: pairing.promise, sessionProvider: provider.promise }),
  });
  connection.connect();
  provider.resolve(fake.provider);
  return Promise.resolve().then(() => {
    fake.close();
    expect(connection.getSnapshot().phase).toBe("ended");
    expect(connection.getSnapshot().error?.code).toBe("CONNECTION_CLOSED");
  });
});

test("能動切断では失敗を写しに載せない", async () => {
  const pairing = deferred<PairingInfo>();
  const provider = deferred<SessionProvider>();
  const fake = createFakeProvider();
  const connection = new BridgeConnection({
    endpoint: "ws://127.0.0.1:3100/v1",
    createRequest: () => ({ pairingInfo: pairing.promise, sessionProvider: provider.promise }),
  });
  connection.connect();
  provider.resolve(fake.provider);
  await Promise.resolve();
  connection.disconnect();
  expect(connection.getSnapshot().phase).toBe("ended");
  expect(connection.getSnapshot().error).toBeNull();
});

test("接続開始の失敗は写しの error に載せる", async () => {
  const pairing = deferred<PairingInfo>();
  const provider = deferred<SessionProvider>();
  const connection = new BridgeConnection({
    endpoint: "ws://127.0.0.1:3100/v1",
    createRequest: () => ({ pairingInfo: pairing.promise, sessionProvider: provider.promise }),
  });
  connection.connect();
  pairing.reject(new WorldClientError("ACCEPTANCE_CLOSED", "受付が有効でない。"));
  await Promise.resolve();
  expect(connection.getSnapshot().phase).toBe("ended");
  expect(connection.getSnapshot().error).toEqual({
    code: "ACCEPTANCE_CLOSED",
    message: "受付が有効でない。",
  });
});
