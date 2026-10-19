import { expect, test } from "vite-plus/test";
import type { ManagementSnapshot } from "bridge-gui-contract/management";
import {
  LocalMcpController,
  type McpListener,
  type McpUpstream,
  type StartMcpOptions,
} from "../src/main/mcp.ts";
import type { GuiBackend } from "../src/main/backend.ts";

// 製品向け MCP の実行単位の寿命管理。ゲート・作り直し・失効・再開抑止・
// 終了の後始末・改訂番号・未完了の区別を固定する。待受け自体（Bun.serve）は
// 代役で差し替え、実 HTTP ソケットは使わない。認証は持たない。
// backend は実行しない代役である。

/** 試験用の表示状態。 */
function makeSnapshot(): ManagementSnapshot {
  return {
    revision: 1,
    backend: "ready",
    endpoint: { url: "http://127.0.0.1:3100", listening: true },
    admission: { accepting: false },
    pending: [],
    connections: [],
    sessions: [],
    plugins: { kinds: [], instances: [], assignments: [] },
    pluginMounts: [],
    pluginMountFailures: [],
    pluginNavigationRules: [],
    pluginView: { instanceId: null, viewGeneration: 0 },
  };
}

/** 試験用の backend 代役。状態確認では呼ばれない。 */
function prepareBackend(calls: string[]): GuiBackend {
  const backend = {
    getSnapshot: () => {
      calls.push("getSnapshot");
      return makeSnapshot();
    },
  };
  return backend as unknown as GuiBackend;
}

/** 試験用の待受け代役。開閉と要求到達を記録する。 */
function prepareListen() {
  const stops: string[] = [];
  const opens: Array<{ hostname: string; port: number }> = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  const listen = (
    hostname: string,
    port: number,
    onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
  ) => {
    opens.push({ hostname, port });
    captured.push(onRequest);
    return {
      port: 4567,
      stop: () => {
        stops.push("stop");
      },
    };
  };
  return { listen, stops, opens, captured };
}

/** 試験用の要求。境界の先頭（個体の受付）で判定する。 */
function makeRawRequest(): { raw: Request; upstream: McpUpstream } {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  const raw = new Request("http://127.0.0.1:4567/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  // `Host` 頭は実 `Request` に載らないため、境界の `Host` 検査では
  // 通らない。個体の受付の有効期限の判定（`503` か否か）だけを見る。
  return { raw, upstream: { port: 4567, requestIP: () => ({ address: "127.0.0.1" }) } };
}

test("既定は無効であり接続設定は無い", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  await controller.startFromEnv();
  expect(controller.getStatus()).toEqual({
    enabled: false,
    port: null,
    url: null,
    startFailed: false,
    cleanupPending: false,
    revision: 0,
  });
  expect(calls).toEqual([]);
});

test("起動時の環境変数で有効化する", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  await withEnvAsync("1", async () => {
    await controller.startFromEnv({ listen: fake.listen });
  });
  expect(fake.opens).toEqual([{ hostname: "127.0.0.1", port: 0 }]);
  const status = controller.getStatus();
  expect(status.enabled).toBe(true);
  expect(status.port).toBe(4567);
  expect(status.url).toBe("http://127.0.0.1:4567/mcp");
  expect(status.startFailed).toBe(false);
  expect(status.cleanupPending).toBe(false);
  expect(status.revision).toBeGreaterThan(0);
  expect(calls).toEqual([]);
  await controller.close();
  expect(fake.stops).toEqual(["stop"]);
});

test("管理画面からの有効化で待受けを作り直す", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  const options: StartMcpOptions = { listen: fake.listen };
  await withEnvAsync(undefined, async () => {
    await controller.enable(options);
  });
  const first = controller.getStatus();
  expect(first.enabled).toBe(true);
  expect(first.url).toBe("http://127.0.0.1:4567/mcp");
  await controller.enable(options);
  const second = controller.getStatus();
  expect(second.enabled).toBe(true);
  // 作り直しで待受けは閉じ直す（旧個体は失効する）。
  expect(fake.stops).toEqual(["stop"]);
  // 旧個体の要求は拒否する（`503` で止まり業務は呼ばない）。
  const old = makeRawRequest();
  expect((await fake.captured[0]?.(old.raw, old.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
  await controller.close();
});

/** 非同期の環境変数切替え。並行実行はしない。 */
async function withEnvAsync(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env["BRIDGE_GUI_MCP"];
  try {
    if (value === undefined) {
      delete process.env["BRIDGE_GUI_MCP"];
    } else {
      process.env["BRIDGE_GUI_MCP"] = value;
    }
    await run();
  } finally {
    if (saved === undefined) {
      delete process.env["BRIDGE_GUI_MCP"];
    } else {
      process.env["BRIDGE_GUI_MCP"] = saved;
    }
  }
}

test("停止で失効・停止し旧個体は使えない", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  await controller.enable({ listen: fake.listen });
  const enabled = controller.getStatus();
  expect(enabled.enabled).toBe(true);
  const stopped = await controller.disable();
  // 停止は公開状態を返す（ack だけにしない）。
  expect(stopped).toEqual(controller.getStatus());
  expect(stopped).toEqual({
    enabled: false,
    port: null,
    url: null,
    startFailed: false,
    cleanupPending: false,
    revision: stopped.revision,
  });
  expect(fake.stops).toEqual(["stop"]);
  // 停止後の旧個体の要求は拒否する。
  const old = makeRawRequest();
  expect((await fake.captured[0]?.(old.raw, old.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
  await controller.close();
});

test("停止後は環境変数を理由に再開しない", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  await withEnvAsync("1", async () => {
    await controller.enable({ listen: fake.listen });
    await controller.disable();
    expect(fake.opens.length).toBe(1);
    // 停止後の同一起動内の env 起点の有効化は開かない。
    await controller.startFromEnv({ listen: fake.listen });
    expect(controller.getStatus().enabled).toBe(false);
    expect(fake.opens.length).toBe(1);
    expect(calls).toEqual([]);
    await controller.close();
  });
});

test("開始失敗は公開状態に載り再有効化で消える", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const failing = (): never => {
    throw new Error("束縛できない");
  };
  await controller.enable({ listen: failing });
  const failed = controller.getStatus();
  expect(failed).toMatchObject({
    enabled: false,
    port: null,
    url: null,
    startFailed: true,
    cleanupPending: false,
  });
  // 成功時は開始失敗が消える（通常の GUI は起動を継続している）。
  const fake = prepareListen();
  await controller.enable({ listen: fake.listen });
  const recovered = controller.getStatus();
  expect(recovered.startFailed).toBe(false);
  expect(recovered.enabled).toBe(true);
  expect(calls).toEqual([]);
  await controller.close();
});

test("公開状態の改訂番号は単調で push と応答が同じ値である", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  const pushed: Array<ReturnType<LocalMcpController["getStatus"]>> = [];
  controller.onChanged((state) => {
    pushed.push(state);
  });
  const before = controller.getStatus().revision;
  await controller.enable({ listen: fake.listen });
  const enabled = controller.getStatus();
  await controller.disable();
  const disabled = controller.getStatus();
  // 状態を変えるたびに進み、単調に増加する。停止は「無効・未完了」と
  // 「無効・完了」の二段階で進む。
  expect(enabled.revision).toBeGreaterThan(before);
  expect(disabled.revision).toBeGreaterThan(enabled.revision);
  // push と応答は同じ版付けであり、同じ値である。
  expect(pushed.map((state) => state.revision)).toEqual([
    enabled.revision,
    enabled.revision + 1,
    disabled.revision,
  ]);
  expect(pushed[0]).toEqual(enabled);
  expect(pushed[pushed.length - 1]).toEqual(disabled);
  // 停止の中間は無効・未完了であり、最終は無効・完了である。
  expect(pushed[1]).toMatchObject({ enabled: false, cleanupPending: true });
  // 読み取りは版を進めない。
  expect(controller.getStatus().revision).toBe(disabled.revision);
  expect(controller.getStatus()).toEqual(disabled);
  expect(calls).toEqual([]);
  await controller.close();
});

test("停止の未完了を区別し未完了の停止を再試行できる", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  // 停止に2回続けて失敗する（無効化時の閉鎖と、同じ無効化内の再試行）。
  let failuresLeft = 2;
  const closes: number[] = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  let nextPort = 4567;
  const listen = (
    _hostname: string,
    _port: number,
    onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
  ): McpListener => {
    const bound = nextPort;
    nextPort += 1;
    captured.push(onRequest);
    return {
      port: bound,
      stop: () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("停止に失敗した");
        }
        closes.push(bound);
      },
    };
  };
  await controller.enable({ listen });
  // 停止に失敗しても例外にせず、操作は無効・停止は未完了として返す。
  const first = await controller.disable();
  expect(first.enabled).toBe(false);
  expect(first.cleanupPending).toBe(true);
  expect(first.startFailed).toBe(false);
  expect(controller.getStatus()).toEqual(first);
  // 未完了の間は残存待受けでも操作できない。
  const stale = makeRawRequest();
  expect((await captured[0]?.(stale.raw, stale.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
  // 未完了の停止を再試行できる。再試行で解放を確認する。
  const second = await controller.disable();
  expect(second.enabled).toBe(false);
  expect(second.cleanupPending).toBe(false);
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(closes).toEqual([4567]);
  await controller.close();
});

test("有効状態は次回起動へ保存しない", async () => {
  const calls: string[] = [];
  const first = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  await withEnvAsync("1", async () => {
    await first.startFromEnv({ listen: fake.listen });
    expect(first.getStatus().enabled).toBe(true);
    await first.close();
  });
  // 新しい実行単位（新しい controller）は既定無効から始まる。
  const second = new LocalMcpController(prepareBackend(calls));
  expect(second.getStatus()).toEqual({
    enabled: false,
    port: null,
    url: null,
    startFailed: false,
    cleanupPending: false,
    revision: 0,
  });
  await second.close();
});

test("終了処理は待受けと個体の受付を残さず冪等である", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  await controller.enable({ listen: fake.listen });
  const beforeClose = makeRawRequest();
  // 開いている間は個体の受付で境界を通る（`Host` 不備の `403` で止まる）。
  expect((await fake.captured[0]?.(beforeClose.raw, beforeClose.upstream))?.status).toBe(403);
  await controller.close();
  await controller.close();
  expect(fake.stops).toEqual(["stop"]);
  // 終了後は同じ個体の要求でも拒否する。
  const afterClose = makeRawRequest();
  expect((await fake.captured[0]?.(afterClose.raw, afterClose.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
});

test("公開状態の変化を購読できる", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  const seen: Array<ReturnType<LocalMcpController["getStatus"]>> = [];
  const unsubscribe = controller.onChanged((state) => {
    seen.push(state);
  });
  await controller.enable({ listen: fake.listen });
  await controller.disable();
  unsubscribe();
  await controller.enable({ listen: fake.listen });
  // 解除後は届かない。停止は未完了と完了の二段階で届く。
  expect(seen.map((state) => state.enabled)).toEqual([true, false, false]);
  expect(seen[1]).toMatchObject({ enabled: false, cleanupPending: true });
  expect(seen[2]).toMatchObject({ enabled: false, cleanupPending: false });
  await controller.close();
});

test("二重の有効化でも待受けは1つだけ残る", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  // 同時に2回有効化しても、直列に処理して待受けは作り直すだけである。
  const [first, second] = await Promise.all([
    controller.enable({ listen: fake.listen }),
    controller.enable({ listen: fake.listen }),
  ]);
  expect(first.enabled).toBe(true);
  expect(second.enabled).toBe(true);
  expect(fake.opens.length).toBe(2);
  // 先に開いた方は閉じており、残る待受けは後の1つだけである。
  expect(fake.stops).toEqual(["stop"]);
  // 旧個体の要求は拒否する（`503` で止まり業務は呼ばない）。
  const oldRaw = makeRawRequest();
  expect((await fake.captured[0]?.(oldRaw.raw, oldRaw.upstream))?.status).toBe(503);
  // 生きている個体は受付で通る（`Host` 不備の `403` で止まる）。
  const liveRaw = makeRawRequest();
  expect((await fake.captured[1]?.(liveRaw.raw, liveRaw.upstream))?.status).toBe(403);
  expect(calls).toEqual([]);
  await controller.close();
  expect(fake.stops).toEqual(["stop", "stop"]);
});

/**
 * 停止の開始を通知する代役の待受け。停止待ちに入ったことを試験が
 * 検知してから交差させるため、最初の停止だけ待たせる。
 *
 * 待受けごとの停止回数を数え、捨てた待受けが実際に閉じたことを検証する。
 */
function prepareDeferredListen() {
  const opens: number[] = [];
  const closes: number[] = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  let nextPort = 4567;
  let enteredResolvers: Array<() => void> = [];
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let deferred = true;
  const listen = (
    _hostname: string,
    _port: number,
    onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
  ): McpListener => {
    const bound = nextPort;
    nextPort += 1;
    opens.push(bound);
    captured.push(onRequest);
    return {
      port: bound,
      stop: () => {
        if (deferred) {
          deferred = false;
          for (const resolve of enteredResolvers) {
            resolve();
          }
          enteredResolvers = [];
          return stopGate.then(() => {
            closes.push(bound);
          });
        }
        closes.push(bound);
      },
    };
  };
  return {
    listen,
    opens,
    closes,
    captured,
    /** 最初の停止が始まるまで待つ。交差の確定に使う。 */
    waitForStopStart: (): Promise<void> =>
      new Promise<void>((resolve) => {
        enteredResolvers.push(resolve);
      }),
    releaseStop: (): void => {
      releaseStop();
    },
  };
}

test("有効化の途中で停止すると待受けも個体の受付も残らない", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const deferred = prepareDeferredListen();
  await controller.enable({ listen: deferred.listen });
  // 2回目の有効化は旧待受けの停止待ちで止まる。停止待ちに入ってから交差させる。
  const enabling = controller.enable({ listen: deferred.listen });
  await deferred.waitForStopStart();
  const disabling = controller.disable();
  deferred.releaseStop();
  await Promise.all([enabling, disabling]);
  // 新しい待受けは開かず、旧待受けは閉じている。
  expect(deferred.opens).toEqual([4567]);
  expect(deferred.closes).toEqual([4567]);
  const status = controller.getStatus();
  expect(status).toMatchObject({
    enabled: false,
    port: null,
    url: null,
    startFailed: false,
    cleanupPending: false,
  });
  expect(calls).toEqual([]);
  await controller.close();
});

test("有効化の途中で終了すると残らず以後は有効化されない", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const deferred = prepareDeferredListen();
  const seen: Array<ReturnType<LocalMcpController["getStatus"]>> = [];
  controller.onChanged((state) => {
    seen.push(state);
  });
  await controller.enable({ listen: deferred.listen });
  // 2回目の有効化は旧待受けの停止待ちで止まる。停止待ちに入ってから交差させる。
  const enabling = controller.enable({ listen: deferred.listen });
  await deferred.waitForStopStart();
  const closing = controller.close();
  deferred.releaseStop();
  await Promise.all([enabling, closing]);
  // 新しい待受けは開かず、終了後は有効化されない。
  expect(deferred.opens).toEqual([4567]);
  expect(deferred.closes).toEqual([4567]);
  expect(controller.getStatus().enabled).toBe(false);
  const reopened = await controller.enable({ listen: deferred.listen });
  expect(reopened.enabled).toBe(false);
  expect(deferred.opens).toEqual([4567]);
  // 終了後に購読者へ通知されない（終了時の登録破棄）。
  expect(seen.map((state) => state.enabled)).toEqual([true]);
  expect(calls).toEqual([]);
  await controller.close();
});

test("停止に失敗した待受けは保持し再試行で閉じる", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  // 停止に2回続けて失敗する（停止時の閉鎖と、同じ停止内の再試行）。
  let failuresLeft = 2;
  const opens: number[] = [];
  const closes: number[] = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  let nextPort = 4567;
  const listen = (
    _hostname: string,
    _port: number,
    onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
  ): McpListener => {
    const bound = nextPort;
    nextPort += 1;
    opens.push(bound);
    captured.push(onRequest);
    return {
      port: bound,
      stop: () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("停止に失敗した");
        }
        closes.push(bound);
      },
    };
  };
  await controller.enable({ listen });
  const enabled = controller.getStatus();
  expect(enabled.enabled).toBe(true);
  // 停止に失敗しても例外にせず、操作は無効・停止は未完了として返す。
  const stopped = await controller.disable();
  expect(stopped.enabled).toBe(false);
  expect(stopped.cleanupPending).toBe(true);
  expect(controller.getStatus()).toEqual(stopped);
  const stale = makeRawRequest();
  expect((await captured[0]?.(stale.raw, stale.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
  // 再有効化で未終了の待受けを再試行してから開き直す。待受けは増えない。
  await controller.enable({ listen });
  expect(opens).toEqual([4567, 4568]);
  expect(closes).toEqual([4567]);
  const fresh = controller.getStatus();
  expect(fresh.enabled).toBe(true);
  expect(fresh.cleanupPending).toBe(false);
  expect(fresh.url).toBe("http://127.0.0.1:4568/mcp");
  const live = makeRawRequest();
  expect((await captured[1]?.(live.raw, live.upstream))?.status).toBe(403);
  expect(calls).toEqual([]);
  await controller.close();
  expect(closes).toEqual([4567, 4568]);
});

test("未終了の待受けがある間は新しい待受けを開かない", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const opens: number[] = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  let nextPort = 4567;
  const listen = (
    _hostname: string,
    _port: number,
    onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
  ): McpListener => {
    const bound = nextPort;
    nextPort += 1;
    opens.push(bound);
    captured.push(onRequest);
    return {
      port: bound,
      stop: () => {
        throw new Error("停止に失敗した");
      },
    };
  };
  await controller.enable({ listen });
  await controller.disable();
  // 未終了が残る間の再有効化は開かず、開始失敗として現す。
  await controller.enable({ listen });
  expect(opens).toEqual([4567]);
  const status = controller.getStatus();
  expect(status).toMatchObject({
    enabled: false,
    port: null,
    url: null,
    startFailed: true,
    cleanupPending: true,
  });
  // 旧個体では操作できない（残存待受けが残っていても使えない）。
  const stale = makeRawRequest();
  expect((await captured[0]?.(stale.raw, stale.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
  await controller.close();
});

test("終了後は有効化を受け付けない", async () => {
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const fake = prepareListen();
  await controller.enable({ listen: fake.listen });
  await controller.close();
  const reopened = await controller.enable({ listen: fake.listen });
  expect(reopened.enabled).toBe(false);
  expect(fake.opens.length).toBe(1);
  expect(calls).toEqual([]);
});

test("停止中の状態取得は版と内容が一致する", async () => {
  // 停止前・停止中・解放後の各段階で同じ版は同じ内容を指す。
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const deferred = prepareDeferredListen();
  const pushed: Array<ReturnType<LocalMcpController["getStatus"]>> = [];
  controller.onChanged((state) => {
    pushed.push(state);
  });
  await controller.enable({ listen: deferred.listen });
  const before = controller.getStatus();
  expect(before).toMatchObject({ enabled: true, cleanupPending: false });
  const waiting = deferred.waitForStopStart();
  const disabling = controller.disable();
  await waiting;
  // 停止待ちに入った時点で「無効・未完了」を確定して公開する。
  const during = controller.getStatus();
  expect(during).toMatchObject({ enabled: false, cleanupPending: true });
  expect(during.revision).toBeGreaterThan(before.revision);
  // 読み直しても同じ版は同じ内容である。
  expect(controller.getStatus()).toEqual(during);
  deferred.releaseStop();
  const after = await disabling;
  expect(after).toMatchObject({ enabled: false, cleanupPending: false });
  expect(after.revision).toBeGreaterThan(during.revision);
  expect(controller.getStatus()).toEqual(after);
  // 契約の「同じ値は同じ内容」を各段階で固定する。
  const observed = [before, during, controller.getStatus(), after];
  const byRevision = new Map<number, string>();
  for (const state of [...observed, ...pushed]) {
    const content = JSON.stringify({
      enabled: state.enabled,
      port: state.port,
      url: state.url,
      startFailed: state.startFailed,
      cleanupPending: state.cleanupPending,
    });
    const previous = byRevision.get(state.revision);
    if (previous === undefined) {
      byRevision.set(state.revision, content);
    } else {
      expect(content).toBe(previous);
    }
  }
  expect(calls).toEqual([]);
  await controller.close();
});

test("停止と終了の交差では終了が勝ち以後は有効化されない", async () => {
  // 停止待ちに入ってから終了し、交差を確定させる。
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  const deferred = prepareDeferredListen();
  await controller.enable({ listen: deferred.listen });
  const waiting = deferred.waitForStopStart();
  const disabling = controller.disable();
  await waiting;
  const during = controller.getStatus();
  expect(during).toMatchObject({ enabled: false, cleanupPending: true });
  const closing = controller.close();
  deferred.releaseStop();
  await Promise.all([disabling, closing]);
  expect(deferred.opens).toEqual([4567]);
  expect(deferred.closes).toEqual([4567]);
  const status = controller.getStatus();
  expect(status).toMatchObject({ enabled: false, cleanupPending: false });
  expect(status.revision).toBeGreaterThan(during.revision);
  // 終了後は有効化されない。
  const reopened = await controller.enable({ listen: deferred.listen });
  expect(reopened.enabled).toBe(false);
  expect(deferred.opens).toEqual([4567]);
  // 旧個体の要求は拒否する。
  const old = makeRawRequest();
  expect((await deferred.captured[0]?.(old.raw, old.upstream))?.status).toBe(503);
  expect(calls).toEqual([]);
  await controller.close();
});

test("再試行中の版は未完了を示し続け解放後に進む", async () => {
  // 初回停止は失敗し、再試行の解放待ちの間も未完了を示し続ける。
  const calls: string[] = [];
  const controller = new LocalMcpController(prepareBackend(calls));
  let failuresLeft = 2;
  let retryEntered: Array<() => void> = [];
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const opens: number[] = [];
  const closes: number[] = [];
  const captured: Array<(raw: Request, upstream: McpUpstream) => Promise<Response>> = [];
  let nextPort = 4567;
  let deferredRetry = true;
  const listen = (
    _hostname: string,
    _port: number,
    onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
  ): McpListener => {
    const bound = nextPort;
    nextPort += 1;
    opens.push(bound);
    captured.push(onRequest);
    return {
      port: bound,
      stop: () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("停止に失敗した");
        }
        if (deferredRetry) {
          deferredRetry = false;
          for (const resolve of retryEntered) {
            resolve();
          }
          retryEntered = [];
          return retryGate.then(() => {
            closes.push(bound);
          });
        }
        closes.push(bound);
      },
    };
  };
  await controller.enable({ listen });
  const first = await controller.disable();
  expect(first).toMatchObject({ enabled: false, cleanupPending: true });
  const firstRevision = first.revision;
  expect(controller.getStatus()).toEqual(first);
  // 再試行の解放待ちの間も未完了のまま、版も内容も変わらない。
  const waiting = new Promise<void>((resolve) => {
    retryEntered.push(resolve);
  });
  const retrying = controller.disable();
  await waiting;
  const duringRetry = controller.getStatus();
  expect(duringRetry.cleanupPending).toBe(true);
  expect(duringRetry.revision).toBe(firstRevision);
  expect(duringRetry).toEqual(first);
  releaseRetry();
  const second = await retrying;
  expect(second).toMatchObject({ enabled: false, cleanupPending: false });
  expect(second.revision).toBeGreaterThan(firstRevision);
  expect(controller.getStatus()).toEqual(second);
  expect(closes).toEqual([4567]);
  expect(calls).toEqual([]);
  await controller.close();
});
