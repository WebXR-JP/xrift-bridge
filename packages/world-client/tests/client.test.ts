import { afterEach, expect, test } from "vite-plus/test";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseBridgeMessage } from "bridge-protocol";
import { WorldClientError, createWorldClient, type WorldClient } from "../src/index.ts";

const servers: WebSocketServer[] = [];
const clients: WorldClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** 試験用サーバの受信値をテキスト化する。 */
function rawToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data).toString("utf-8");
}
function startStub(validSecret: string): Promise<{ port: number }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    let authorized: string | null = null;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (authorized === null) {
        if (message.type === "auth" && message.secret === validSecret) {
          authorized = "session-stub";
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "auth_ok",
              sessionId: authorized,
              window: 16,
            }),
          );
        } else {
          socket.close(1008, "unauthorized");
        }
        return;
      }
      if (message.type === "echo") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId: authorized,
            streamId: message.streamId,
            kind: "reliable",
            seq: message.seq,
            requestId: message.requestId,
            payload: message.payload,
          }),
        );
      } else if (message.type === "command_request") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "command_response",
            sessionId: authorized,
            requestId: message.requestId,
            ok: message.command === "ping",
            ...(message.command === "ping"
              ? { result: "pong" }
              : { error: { code: "UNKNOWN_COMMAND", message: "unknown" } }),
          }),
        );
      } else if (message.type === "data") {
        // latest は受領のみで応答しない。
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({ port: address.port });
    });
  });
}

/** クレジットを付与しない試験用サーバ（送信待機の検証用）。 */
function startNoCreditStub(): Promise<{ port: number }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "auth") {
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "auth_ok",
            sessionId: "session-nocredit",
            window: 0,
          }),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({ port: address.port });
    });
  });
}

/** 補充の時期を試験側で操作できる試験用サーバ（累積 limit 方式）。 */
function startCreditControlStub(
  validSecret: string,
  initialWindow = 0,
): Promise<{
  port: number;
  receivedEchoes: Array<{ streamId: string; seq: number; requestId: string }>;
  grantLimit: (limit: number, sessionId?: string) => void;
}> {
  const receivedEchoes: Array<{ streamId: string; seq: number; requestId: string }> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let active: WebSocket | null = null;
  server.on("connection", (socket: WebSocket) => {
    active = socket;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "auth") {
        if (message.secret !== validSecret) {
          socket.close(1008, "unauthorized");
          return;
        }
        // 初期付与で始め、累積 limit の通知が来るまで送出しない。
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "auth_ok",
            sessionId: "session-credit",
            window: initialWindow,
          }),
        );
        return;
      }
      if (message.type === "echo") {
        receivedEchoes.push({
          streamId: message.streamId,
          seq: message.seq,
          requestId: message.requestId,
        });
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "echo_response",
            sessionId: "session-credit",
            streamId: message.streamId,
            kind: "reliable",
            seq: message.seq,
            requestId: message.requestId,
            payload: message.payload,
          }),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({
        port: address.port,
        receivedEchoes,
        grantLimit: (limit: number, sessionId = "session-credit") => {
          if (active === null) throw new Error("接続前に補充はできない。");
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "credit",
              sessionId,
              limit,
            }),
          );
        },
      });
    });
  });
}

/** 連番を厳密に検証する試験用サーバ（ブリッジの UNEXPECTED_SEQ 相当）。 */
function startStrictCreditStub(
  validSecret: string,
  initialWindow = 0,
): Promise<{
  port: number;
  received: Array<{ kind: string; streamId: string; seq: number; requestId: string }>;
  unexpectedSeq: Array<{ streamId: string; seq: number; requestId: string }>;
  grantLimit: (limit: number, sessionId?: string) => void;
}> {
  const received: Array<{ kind: string; streamId: string; seq: number; requestId: string }> = [];
  const unexpectedSeq: Array<{ streamId: string; seq: number; requestId: string }> = [];
  const expectedSeq = new Map<string, number>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let active: WebSocket | null = null;
  server.on("connection", (socket: WebSocket) => {
    active = socket;
    socket.on("message", (data) => {
      const message = parseBridgeMessage(rawToText(data));
      if (message.type === "auth") {
        if (message.secret !== validSecret) {
          socket.close(1008, "unauthorized");
          return;
        }
        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "auth_ok",
            sessionId: "session-strict",
            window: initialWindow,
          }),
        );
        return;
      }
      if (message.type === "echo" || message.type === "command_request") {
        const expected = expectedSeq.get(message.streamId) ?? 0;
        if (message.seq !== expected) {
          // ブリッジと同様に連番の飛びを明示エラーにし、期待値は進めない。
          unexpectedSeq.push({
            streamId: message.streamId,
            seq: message.seq,
            requestId: message.requestId,
          });
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "error",
              code: "UNEXPECTED_SEQ",
              message: "連番が期待値と一致しない。",
              sessionId: "session-strict",
              requestId: message.requestId,
            }),
          );
          return;
        }
        expectedSeq.set(message.streamId, expected + 1);
        received.push({
          kind: message.type,
          streamId: message.streamId,
          seq: message.seq,
          requestId: message.requestId,
        });
        if (message.type === "echo") {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "echo_response",
              sessionId: "session-strict",
              streamId: message.streamId,
              kind: "reliable",
              seq: message.seq,
              requestId: message.requestId,
              payload: message.payload,
            }),
          );
        } else {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "command_response",
              sessionId: "session-strict",
              requestId: message.requestId,
              ok: true,
              result: "pong",
            }),
          );
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("試験サーバの待ち受け取得に失敗した。");
      }
      resolve({
        port: address.port,
        received,
        unexpectedSeq,
        grantLimit: (limit: number, sessionId = "session-strict") => {
          if (active === null) throw new Error("接続前に補充はできない。");
          active.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: "credit",
              sessionId,
              limit,
            }),
          );
        },
      });
    });
  });
}

/** 記録中の command_request 送出件数を数える。送出はすべて正規の JSON のため直接読む。 */
function countCommandSends(sentTexts: string[]): number {
  return sentTexts.filter((text) => JSON.parse(text).type === "command_request").length;
}

/** 受信が起きないことを有限時間で確かめる。送出されていたら即失敗する。 */
async function expectNoEcho(
  receivedEchoes: Array<{ streamId: string; seq: number; requestId: string }>,
  timeoutMs = 100,
): Promise<void> {
  const baseline = receivedEchoes.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (receivedEchoes.length > baseline) {
      throw new Error("補充前に送出されており待機していない。");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(receivedEchoes).toHaveLength(baseline);
}

/** クライアントが開くソケットの実行時型。宣言上の DOM 型ではなく実物の型で受ける。 */
type ProbedSocket = InstanceType<typeof globalThis.WebSocket>;

/** クライアントが開くソケットを捕捉する。送受信の観測を時刻待ちなしで確定させるため。 */
function installSocketProbe(): {
  seen: ProbedSocket[];
  restore: () => void;
} {
  const RealWebSocket = globalThis.WebSocket;
  const seen: ProbedSocket[] = [];
  class ProbeWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      seen.push(this);
    }
  }
  globalThis.WebSocket = ProbeWebSocket;
  return {
    seen,
    restore: () => {
      globalThis.WebSocket = RealWebSocket;
    },
  };
}

/**
 * 指定 limit の credit をクライアント側ソケットが受けた時点で解決する。
 * 試験の待受はクライアントの受信処理より後に登録するため、解決時には
 * クライアントの会計更新が終わっている。時刻待ちに依存しない。
 */
function waitForClientCredit(socket: ProbedSocket, limit: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMessage = (event: Event): void => {
      // 実行時型の差異に依存しないよう、data の有無で読み分ける。
      const data: unknown = "data" in event ? event.data : undefined;
      if (typeof data !== "string") return;
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== "object" || parsed === null) return;
      if (!("type" in parsed) || !("limit" in parsed)) return;
      if (parsed.type === "credit" && parsed.limit === limit) {
        socket.removeEventListener("message", onMessage);
        resolve();
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

/**
 * クライアント側ソケットの送出文字列を記録する。
 * 送信要求が即時送出されたか待機に積まれたかを、呼び出し直後に
 * 同期的・確定的に判定するため。時刻待ちに依存しない。
 */
function recordClientSends(socket: ProbedSocket): {
  sentTexts: string[];
  restore: () => void;
} {
  const sentTexts: string[] = [];
  const originalSend = socket.send.bind(socket);
  // 実運用で送るのは文字列化した JSON のみであり、引数の型は実物の send と同一にする。
  function patchedSend(data: Parameters<ProbedSocket["send"]>[0]): void {
    if (typeof data === "string") sentTexts.push(data);
    originalSend(data);
  }
  socket.send = patchedSend;
  return {
    sentTexts,
    restore: () => {
      socket.send = originalSend;
    },
  };
}

/** 記録中の echo 送出件数を数える。送出はすべて正規の JSON のため直接読む。 */
function countEchoSends(sentTexts: string[]): number {
  return sentTexts.filter((text) => JSON.parse(text).type === "echo").length;
}

/** 記録中の指定種別の最初の送出文字列を探す。送出はすべて正規の JSON のため直接読む。 */
function findSentText(sentTexts: string[], type: string): string | undefined {
  return sentTexts.find((text) => JSON.parse(text).type === type);
}

test("接続・認証・echo 往復・command・latest・切断ができる", async () => {
  const { port } = await startStub("secret-1");
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    origin: "https://app.xrift.net",
  });
  clients.push(client);
  expect(client.protocolVersion).toBe(PROTOCOL_VERSION);

  const states: string[] = [];
  client.onEvent((event) => {
    if (event.kind === "state") states.push(event.state);
  });

  const connected = await client.connect("secret-1");
  expect(connected.sessionId).toBe("session-stub");
  expect(client.getState()).toBe("authorized");
  // 秘密値を URL に含めない。
  expect(client.endpoint).toBe(`ws://127.0.0.1:${port}/v1`);

  const echoed = await client.sendEcho("main", { text: "hello" });
  expect(echoed.seq).toBe(0);
  expect(echoed.payload).toEqual({ text: "hello" });

  const second = await client.sendEcho("main", [1, 2]);
  expect(second.seq).toBe(1);

  const pong = await client.sendCommand("main", "ping");
  expect(pong.ok).toBe(true);
  expect(pong.result).toBe("pong");

  const failure = await client.sendCommand("main", "explode");
  expect(failure.ok).toBe(false);

  const seq = client.sendLatest("pose", { x: 1 });
  expect(seq).toBe(0);
  expect(client.getLatestSent("pose")).toEqual({ x: 1 });
  client.sendLatest("pose", { x: 2 });
  expect(client.getLatestSent("pose")).toEqual({ x: 2 });

  client.close();
  expect(client.getState()).toBe("closed");
  expect(states).toContain("connecting");
  expect(states).toContain("authenticating");
  expect(states).toContain("authorized");
});

test("誤った秘密値では認証できない", async () => {
  const { port } = await startStub("secret-1");
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
  clients.push(client);
  await expect(client.connect("wrong-secret")).rejects.toBeInstanceOf(WorldClientError);
  expect(client.getState()).toBe("closed");
});

test("未認証では業務送信できない", async () => {
  const { port } = await startStub("secret-1");
  const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
  clients.push(client);
  await expect(client.sendEcho("main", "x")).rejects.toMatchObject({
    code: "NOT_AUTHORIZED",
  });
  expect(() => client.sendLatest("main", "x")).toThrow(WorldClientError);
});

test("クレジット枯渇時は待機し満杯で明示エラーにする", async () => {
  const { port } = await startNoCreditStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    maxPendingReliable: 1,
  });
  clients.push(client);
  await client.connect("secret-1");

  // 応答が来ないため待機に入る。2件目は上限で明示エラーになる。
  const first = client.sendEcho("main", "a");
  await expect(client.sendEcho("main", "b")).rejects.toMatchObject({
    code: "LOCAL_QUEUE_FULL",
  });
  client.close();
  await expect(first).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
});

test("累積limitで待機と送出を制御し応答だけでは回復しない", async () => {
  // 初期付与 0 で待機に入り、累積 limit の通知ごとに権利分だけが送出される。
  // 応答の受信だけでは次が送出されず、同じ limit の再通知も追加付与にならない。
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub("secret-credit");
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(client);
  await client.connect("secret-credit");

  // 3件を積んでも付与がなければ送出されない（送信履歴で境界を取る）。
  const first = client.sendEcho("main", "a");
  const second = client.sendEcho("main", "b");
  const third = client.sendEcho("main", "c");
  await expectNoEcho(receivedEchoes);

  // limit 1 で1件だけ送出される。応答が返っても次は送出されない。
  grantLimit(1);
  const echoedFirst = await first;
  expect(echoedFirst.seq).toBe(0);
  expect(echoedFirst.payload).toBe("a");
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0]);
  await expectNoEcho(receivedEchoes);

  // limit 2 で次の1件が送出される。3件目は送出されない。
  grantLimit(2);
  const echoedSecond = await second;
  expect(echoedSecond.seq).toBe(1);
  await expectNoEcho(receivedEchoes);
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0, 1]);

  // 同じ limit の再通知は追加付与にならない。
  grantLimit(2);
  await expectNoEcho(receivedEchoes);

  // limit 3 で残りが送出される。
  grantLimit(3);
  const echoedThird = await third;
  expect(echoedThird.seq).toBe(2);
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0, 1, 2]);
});

test("未消費の付与残は追加通知なく使える", async () => {
  // 先にまとめて付与すると、通知を待たず連続送出できる。
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub("secret-credit");
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(client);
  await client.connect("secret-credit");
  grantLimit(3);
  const results = await Promise.all([
    client.sendEcho("main", "a"),
    client.sendEcho("main", "b"),
    client.sendEcho("main", "c"),
  ]);
  expect(results.map((result) => result.seq)).toEqual([0, 1, 2]);
  expect(receivedEchoes.map((echo) => echo.seq)).toEqual([0, 1, 2]);
});

test("セッション不一致のcreditは会計へ適用しない", async () => {
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub("secret-credit");
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(client);
  await client.connect("secret-credit");

  const pending = client.sendEcho("main", "a");
  await expectNoEcho(receivedEchoes);
  // 別セッションの大きな付与は無視される。
  grantLimit(99, "session-other");
  await expectNoEcho(receivedEchoes);
  // 正規セッションの付与で送出される。
  grantLimit(1);
  const echoed = await pending;
  expect(echoed.payload).toBe("a");
  expect(receivedEchoes).toHaveLength(1);
});

test("切断で会計をリセットし再接続で作り直す", async () => {
  const { port, receivedEchoes, grantLimit } = await startCreditControlStub("secret-credit");
  const first = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(first);
  await first.connect("secret-credit");
  grantLimit(1);
  const echoed = await first.sendEcho("main", "a");
  expect(echoed.seq).toBe(0);
  // 付与を使い切った状態で閉じる。
  first.close();
  expect(first.getState()).toBe("closed");

  // 再接続は初期付与 0 から始まり、旧接続の消費を引き継がない。
  const second = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
  });
  clients.push(second);
  await second.connect("secret-credit");
  const pending = second.sendEcho("main", "b");
  const baseline = receivedEchoes.length;
  await expectNoEcho(receivedEchoes);
  expect(receivedEchoes).toHaveLength(baseline);
  // 新接続の付与 1 で1件送出できる（旧消費 1 を引き継いでいたら送出されない）。
  grantLimit(1);
  const echoedSecond = await pending;
  expect(echoedSecond.payload).toBe("b");
});

test("不正な endpoint では生成できない", () => {
  expect(() => createWorldClient({ endpoint: "ws://localhost:3100/v1" })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint: "" })).toThrow(RangeError);
});

test("close直後の同一インスタンス再接続が旧ソケットのcloseに壊されず成立する", async () => {
  // 旧ソケットの close が新接続の接続処理中に届いても現行接続を壊さない。
  // 新旧ソケットを生成順で特定し、旧 close の到達をイベントで待つ（時間待ちに依存しない）。
  const { port } = await startStub("secret-reconnect");
  const RealWebSocket = globalThis.WebSocket;
  const seen: InstanceType<typeof RealWebSocket>[] = [];
  class ProbeWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      seen.push(this);
    }
  }
  globalThis.WebSocket = ProbeWebSocket;
  try {
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      origin: "https://app.xrift.net",
    });
    clients.push(client);
    const closedEvents: Array<{ code: number; reason: string }> = [];
    client.onEvent((event) => {
      if (event.kind === "closed") closedEvents.push({ code: event.code, reason: event.reason });
    });

    await client.connect("secret-reconnect");
    expect(seen).toHaveLength(1);
    const oldSocket = seen[0];
    if (oldSocket === undefined) throw new Error("旧ソケットを特定できない。");
    // close() より前に旧 close の到達待ちを仕掛ける。成功判定は時間待ちではなく通知到達で確定する。
    const oldClosed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("旧ソケットの close 到達を観測できない。"));
      }, 3_000);
      oldSocket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    client.close();
    expect(client.getState()).toBe("closed");
    // 待機を挟まず直ちに同一インスタンスで再接続する。
    const second = client.connect("secret-reconnect");
    const result = await second;
    expect(result.sessionId).toBe("session-stub");
    // 旧 close の到達後も現行接続が壊れていない。
    await oldClosed;
    expect(client.getState()).toBe("authorized");
    const echoed = await client.sendEcho("main", "after-reconnect");
    expect(echoed.payload).toBe("after-reconnect");
    // 余計な closed 通知が出ていない（close() の1回のみ）。
    expect(closedEvents).toHaveLength(1);
  } finally {
    globalThis.WebSocket = RealWebSocket;
    // 失敗時（旧 close が現行接続を壊した場合）に新ソケットが内部参照から
    // 外れて残っても、試験の後処理が止まらないよう直接閉じる。
    for (const ws of seen) {
      try {
        if (ws.readyState === RealWebSocket.OPEN || ws.readyState === RealWebSocket.CONNECTING) {
          ws.close(1000, "test cleanup");
        }
      } catch {
        // 後処理の閉塞失敗は無視する。
      }
    }
  }
});

test("減少したlimitは無視し付与済みの送信権を維持する", async () => {
  // limit=5 → 3件送出 → limit=2 の減少通知 → 残り2件を送出できる。
  // 累積5件の使い切り後は送らず、limit=6 で1件だけ再開する。
  // 減少通知の処理完了は通知到達で確定させてから後続送信を行う（時間待ちに依存しない）。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, receivedEchoes, grantLimit } = await startCreditControlStub("secret-decrease", 5);
    const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
    clients.push(client);
    await client.connect("secret-decrease");
    const socket = seen[0];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    // 最初の3件は付与の範囲で送出される。
    const first = [
      client.sendEcho("main", "a"),
      client.sendEcho("main", "b"),
      client.sendEcho("main", "c"),
    ];
    expect(countEchoSends(sentTexts)).toBe(3);
    const firstResults = await Promise.all(first);
    expect(firstResults.map((result) => result.seq)).toEqual([0, 1, 2]);

    // 減少通知を送り、クライアント側の処理完了を通知到達で待つ。
    const decreased = waitForClientCredit(socket, 2);
    grantLimit(2);
    await decreased;

    // 減少前の上限を維持するため残り2件を送出できる。
    const restPromises = [client.sendEcho("main", "d"), client.sendEcho("main", "e")];
    expect(countEchoSends(sentTexts)).toBe(5);
    const rest = await Promise.all(restPromises);
    expect(rest.map((result) => result.seq)).toEqual([3, 4]);
    expect(receivedEchoes).toHaveLength(5);

    // 累積5件を使い切った後は6件目を送らない。
    const sixth = client.sendEcho("main", "f");
    expect(countEchoSends(sentTexts)).toBe(5);

    // limit=6 で1件だけ再開する。
    const regrown = waitForClientCredit(socket, 6);
    grantLimit(6);
    await regrown;
    expect(countEchoSends(sentTexts)).toBe(6);
    const sixthResult = await sixth;
    expect(sixthResult.seq).toBe(5);
    expect(receivedEchoes).toHaveLength(6);
  } finally {
    restore();
  }
});

test("auth_ok.windowより小さい最初のcreditも無視する", async () => {
  // 初期付与 3 に対し limit=1 の通知は会計を変更しない。3件を送出できる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, receivedEchoes, grantLimit } = await startCreditControlStub(
      "secret-smallfirst",
      3,
    );
    const client = createWorldClient({ endpoint: `ws://127.0.0.1:${port}/v1` });
    clients.push(client);
    await client.connect("secret-smallfirst");
    const socket = seen[0];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const shrunk = waitForClientCredit(socket, 1);
    grantLimit(1);
    await shrunk;

    // 初期付与の範囲で3件を送出できる（小さい最初の通知に引きずられない）。
    const sends = [
      client.sendEcho("main", "a"),
      client.sendEcho("main", "b"),
      client.sendEcho("main", "c"),
    ];
    expect(countEchoSends(sentTexts)).toBe(3);
    const results = await Promise.all(sends);
    expect(results.map((result) => result.seq)).toEqual([0, 1, 2]);
    expect(receivedEchoes).toHaveLength(3);
  } finally {
    restore();
  }
});

test("送信メッセージ上限のちょうどは受け付け＋1バイトは拒否する", async () => {
  // 境界バイト数は実送出から実測する（requestId の UUID 桁数は固定のため再現する）。
  // echo・command の双方で確認し、拒否後の通常要求で連番の継続も確かめる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port } = await startStub("secret-size");
    const endpoint = `ws://127.0.0.1:${port}/v1`;
    const origin = "https://app.xrift.net";
    const payload = { pad: "x".repeat(16) };

    const measurer = createWorldClient({ endpoint, origin });
    clients.push(measurer);
    await measurer.connect("secret-size");
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    await measurer.sendEcho("main", payload);
    await measurer.sendCommand("main", "ping", payload);
    await measurer.sendCommand("main", "ping");
    await measurer.sendEcho("main", "after");
    const echoSample = findSentText(measured.sentTexts, "echo");
    const commandSample = findSentText(measured.sentTexts, "command_request");
    if (echoSample === undefined || commandSample === undefined) {
      throw new Error("送出の実測に失敗した。");
    }
    const echoBoundary = Buffer.byteLength(echoSample, "utf-8");
    const commandBoundary = Buffer.byteLength(commandSample, "utf-8");

    // 上限ちょうどは受け付ける（echo・command の双方）。
    const justEcho = createWorldClient({ endpoint, origin, maxMessageBytes: echoBoundary });
    clients.push(justEcho);
    await justEcho.connect("secret-size");
    const fittedEcho = await justEcho.sendEcho("main", payload);
    expect(fittedEcho.seq).toBe(0);
    const justCommand = createWorldClient({ endpoint, origin, maxMessageBytes: commandBoundary });
    clients.push(justCommand);
    await justCommand.connect("secret-size");
    const fittedCommand = await justCommand.sendCommand("main", "ping", payload);
    expect(fittedCommand.ok).toBe(true);

    // ＋1バイトは拒否する。切断せず、拒否後の通常要求は連番を詰めて通る。
    const overEcho = createWorldClient({ endpoint, origin, maxMessageBytes: echoBoundary - 1 });
    clients.push(overEcho);
    await overEcho.connect("secret-size");
    await expect(overEcho.sendEcho("main", payload)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    expect(overEcho.getState()).toBe("authorized");
    const afterEcho = await overEcho.sendEcho("main", "after");
    expect(afterEcho.seq).toBe(0);

    const overCommand = createWorldClient({
      endpoint,
      origin,
      maxMessageBytes: commandBoundary - 1,
    });
    clients.push(overCommand);
    await overCommand.connect("secret-size");
    await expect(overCommand.sendCommand("main", "ping", payload)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    const smallCommand = await overCommand.sendCommand("main", "ping");
    expect(smallCommand.ok).toBe(true);
    // 拒否した command が連番を消費していないため、同一ストリームの echo は seq=1 である。
    const afterCommandEcho = await overCommand.sendEcho("main", "after");
    expect(afterCommandEcho.seq).toBe(1);
  } finally {
    restore();
  }
});

test("多バイト文字は文字数ではなくUTF-8バイト数で判定する", async () => {
  // 「あ」は1文字3バイトのため、文字数基準なら収まりバイト基準なら超える cap で区別する。
  const { seen, restore } = installSocketProbe();
  try {
    const { port } = await startStub("secret-multibyte");
    const endpoint = `ws://127.0.0.1:${port}/v1`;
    const origin = "https://app.xrift.net";
    const payload = { text: "あ".repeat(8) };

    const measurer = createWorldClient({ endpoint, origin });
    clients.push(measurer);
    await measurer.connect("secret-multibyte");
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    await measurer.sendEcho("main", payload);
    const sample = findSentText(measured.sentTexts, "echo");
    if (sample === undefined) throw new Error("送出の実測に失敗した。");
    const charLength = sample.length;
    const byteLength = Buffer.byteLength(sample, "utf-8");
    // 前提：多バイト文字を含むためバイト数は文字数を上回る。
    expect(byteLength).toBeGreaterThan(charLength);

    const byChars = createWorldClient({ endpoint, origin, maxMessageBytes: charLength });
    clients.push(byChars);
    await byChars.connect("secret-multibyte");
    await expect(byChars.sendEcho("main", payload)).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });

    const byBytes = createWorldClient({ endpoint, origin, maxMessageBytes: byteLength });
    clients.push(byBytes);
    await byBytes.connect("secret-multibyte");
    const accepted = await byBytes.sendEcho("main", payload);
    expect(accepted.seq).toBe(0);
  } finally {
    restore();
  }
});

test("超過拒否はクレジット・待機枠・連番を消費しない", async () => {
  // 初期付与 1 で通常要求を使い、超過拒否を挟んで補充で再開する。
  // 送出件数の遷移を同期的・確定的に数え、応答連番で採番の継続を確かめる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, receivedEchoes, grantLimit } = await startCreditControlStub("secret-intact", 1);
    const endpoint = `ws://127.0.0.1:${port}/v1`;

    const measurer = createWorldClient({ endpoint });
    clients.push(measurer);
    await measurer.connect("secret-intact");
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    await measurer.sendEcho("main", "ok");
    const sample = findSentText(measured.sentTexts, "echo");
    if (sample === undefined) throw new Error("送出の実測に失敗した。");
    const smallBytes = Buffer.byteLength(sample, "utf-8");
    // 計測用送出は試験対象外のため、以降の到達は差分で数える。
    const baselineEchoes = receivedEchoes.length;

    const client = createWorldClient({ endpoint, maxMessageBytes: smallBytes });
    clients.push(client);
    await client.connect("secret-intact");
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    // 通常要求で付与を使い切る。
    const first = await client.sendEcho("main", "ok");
    expect(first.seq).toBe(0);
    expect(countEchoSends(sentTexts)).toBe(1);

    // 超過要求は待機にも会計にも触れず拒否される。
    // 拒否は同期的に確定するため、マイクロタスクの消化だけで判定する（応答待ちにしない）。
    const bigSend = client.sendEcho("main", { pad: "x".repeat(1000) });
    let bigCode: string | null = null;
    void bigSend.then(
      () => {
        bigCode = "SENT";
      },
      (error: unknown) => {
        bigCode = error instanceof WorldClientError ? error.code : "UNKNOWN_ERROR";
      },
    );
    await Promise.resolve();
    expect(bigCode).toBe("MESSAGE_TOO_LARGE");
    expect(countEchoSends(sentTexts)).toBe(1);

    // 次の通常要求は待機に入り（送出されない）、補充で送出される。
    const second = client.sendEcho("main", "ok");
    expect(countEchoSends(sentTexts)).toBe(1);
    const regrown = waitForClientCredit(socket, 2);
    grantLimit(2);
    await regrown;
    expect(countEchoSends(sentTexts)).toBe(2);
    // 拒否が連番を消費していないため seq=1 である。
    const secondResult = await second;
    expect(secondResult.seq).toBe(1);
    expect(receivedEchoes).toHaveLength(baselineEchoes + 2);
  } finally {
    restore();
  }
});

test("超過拒否は送信待機枠を消費せず満杯判定を変えない", async () => {
  // 待機枠 1 を通常要求が占有した状態で、超過要求は寸法で拒否され、
  // 通常要求は従来どおり満杯で拒否される。
  const { port } = await startNoCreditStub();
  const client = createWorldClient({
    endpoint: `ws://127.0.0.1:${port}/v1`,
    maxPendingReliable: 1,
    maxMessageBytes: 1024,
  });
  clients.push(client);
  await client.connect("secret-1");

  const first = client.sendEcho("main", "a");
  await expect(client.sendEcho("main", { pad: "x".repeat(2048) })).rejects.toMatchObject({
    code: "MESSAGE_TOO_LARGE",
  });
  await expect(client.sendEcho("main", "b")).rejects.toMatchObject({
    code: "LOCAL_QUEUE_FULL",
  });
  client.close();
  await expect(first).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
});

test("latestの超過はローカル拒否し以降の送信を壊さない", async () => {
  const { seen, restore } = installSocketProbe();
  try {
    const { port } = await startStub("secret-latest");
    const endpoint = `ws://127.0.0.1:${port}/v1`;
    const origin = "https://app.xrift.net";
    const payload = { x: 1 };

    const measurer = createWorldClient({ endpoint, origin });
    clients.push(measurer);
    await measurer.connect("secret-latest");
    const measureSocket = seen[seen.length - 1];
    if (measureSocket === undefined) throw new Error("計測用ソケットを特定できない。");
    const measured = recordClientSends(measureSocket);
    measurer.sendLatest("pose", payload);
    const sample = findSentText(measured.sentTexts, "data");
    if (sample === undefined) throw new Error("送出の実測に失敗した。");
    const boundary = Buffer.byteLength(sample, "utf-8");

    const client = createWorldClient({ endpoint, origin, maxMessageBytes: boundary });
    clients.push(client);
    await client.connect("secret-latest");
    // 上限ちょうどは受け付ける。
    expect(client.sendLatest("pose", payload)).toBe(0);
    expect(client.getLatestSent("pose")).toEqual(payload);

    // 超過は同期で拒否され、保持中の最新値は変わらない。
    let code: string | null = null;
    try {
      client.sendLatest("pose", { pad: "x".repeat(1000) });
    } catch (error) {
      expect(error).toBeInstanceOf(WorldClientError);
      if (error instanceof WorldClientError) code = error.code;
    }
    expect(code).toBe("MESSAGE_TOO_LARGE");
    expect(client.getLatestSent("pose")).toEqual(payload);

    // 直後の通常送信は連番を詰めて通る。
    expect(client.sendLatest("pose", { x: 2 })).toBe(1);
    expect(client.getLatestSent("pose")).toEqual({ x: 2 });
  } finally {
    restore();
  }
});

test("不正なmaxMessageBytesでは生成できない", () => {
  const endpoint = "ws://127.0.0.1:3100/v1";
  expect(() => createWorldClient({ endpoint, maxMessageBytes: 0 })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint, maxMessageBytes: -1 })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint, maxMessageBytes: 1.5 })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint, maxMessageBytes: Number.NaN })).toThrow(RangeError);
});

test("満杯拒否後のechoは連番を詰めて通り欠番しない", async () => {
  // 待機枠 1・初期付与 0 で満杯拒否を起こし、補充後に同一ストリームへ送る。
  // 拒否が連番を消費していると seq が飛び、厳密な受信側で UNEXPECTED_SEQ になる。
  // 何を通すかではなく採番の連続性を確かめる。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, received, unexpectedSeq, grantLimit } =
      await startStrictCreditStub("secret-full-echo");
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      maxPendingReliable: 1,
    });
    clients.push(client);
    await client.connect("secret-full-echo");
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const first = client.sendEcho("main", "a");
    expect(countEchoSends(sentTexts)).toBe(0);
    await expect(client.sendEcho("main", "b")).rejects.toMatchObject({
      code: "LOCAL_QUEUE_FULL",
    });

    const granted = waitForClientCredit(socket, 1);
    grantLimit(1);
    await granted;
    const echoedFirst = await first;
    expect(echoedFirst.seq).toBe(0);

    const second = client.sendEcho("main", "c");
    const regrown = waitForClientCredit(socket, 2);
    grantLimit(2);
    await regrown;
    const echoedSecond = await second;
    // 拒否が連番を消費していなければ seq=1 で通り、欠番しない。
    expect(echoedSecond.seq).toBe(1);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(unexpectedSeq).toHaveLength(0);
  } finally {
    restore();
  }
});

test("満杯拒否後のcommandは連番を詰めて通り欠番しない", async () => {
  // echo と同じ不変条件を command でも確かめる。共有の流儀ではなく
  // API ごとの採番経路が対象である。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, received, unexpectedSeq, grantLimit } =
      await startStrictCreditStub("secret-full-command");
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      maxPendingReliable: 1,
    });
    clients.push(client);
    await client.connect("secret-full-command");
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const first = client.sendCommand("main", "ping");
    expect(countCommandSends(sentTexts)).toBe(0);
    await expect(client.sendCommand("main", "ping")).rejects.toMatchObject({
      code: "LOCAL_QUEUE_FULL",
    });

    const granted = waitForClientCredit(socket, 1);
    grantLimit(1);
    await granted;
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);

    const second = client.sendCommand("main", "ping");
    const regrown = waitForClientCredit(socket, 2);
    grantLimit(2);
    await regrown;
    const secondResult = await second;
    expect(secondResult.ok).toBe(true);
    // 拒否が連番を消費していなければ送出 seq は 0・1 で連続する。
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(unexpectedSeq).toHaveLength(0);
  } finally {
    restore();
  }
});

test("枯渇待機中の複数件は異なる増加連番で送出される", async () => {
  // 初期付与 0 で echo・command を待機させ、寸法拒否と満杯拒否を挟む。
  // 待機中の複数件が同一連番にならず、拒否後の送出も連続することを確かめる。
  // 受付時の採番確定が対象であり、送出順の保証ではない。
  const { seen, restore } = installSocketProbe();
  try {
    const { port, received, unexpectedSeq, grantLimit } =
      await startStrictCreditStub("secret-queued-seq");
    const client = createWorldClient({
      endpoint: `ws://127.0.0.1:${port}/v1`,
      maxPendingReliable: 4,
      maxMessageBytes: 256,
    });
    clients.push(client);
    await client.connect("secret-queued-seq");
    const socket = seen[seen.length - 1];
    if (socket === undefined) throw new Error("クライアントのソケットを特定できない。");
    const { sentTexts } = recordClientSends(socket);

    const queuedEcho = client.sendEcho("main", "a");
    const queuedCommand = client.sendCommand("main", "ping");
    expect(countEchoSends(sentTexts)).toBe(0);
    expect(countCommandSends(sentTexts)).toBe(0);

    // 待機枠に空きがあっても寸法超過は MESSAGE_TOO_LARGE を優先する。
    await expect(client.sendEcho("main", { pad: "x".repeat(1000) })).rejects.toMatchObject({
      code: "MESSAGE_TOO_LARGE",
    });
    await expect(
      client.sendCommand("main", "ping", { pad: "x".repeat(1000) }),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
    expect(countEchoSends(sentTexts)).toBe(0);
    expect(countCommandSends(sentTexts)).toBe(0);

    const granted = waitForClientCredit(socket, 2);
    grantLimit(2);
    await granted;
    // 受付時に確定した連番で送出され、同一連番の重複がない。
    const echoed = await queuedEcho;
    const commanded = await queuedCommand;
    expect(echoed.seq).toBe(0);
    expect(commanded.ok).toBe(true);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(unexpectedSeq).toHaveLength(0);

    // 拒否を挟んだ後の通常送信も連続する。
    const next = client.sendEcho("main", "b");
    const regrown = waitForClientCredit(socket, 3);
    grantLimit(3);
    await regrown;
    const echoedNext = await next;
    expect(echoedNext.seq).toBe(2);
    expect(received.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(unexpectedSeq).toHaveLength(0);
  } finally {
    restore();
  }
});
