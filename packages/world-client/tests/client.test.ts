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

test("不正な endpoint では生成できない", () => {
  expect(() => createWorldClient({ endpoint: "ws://localhost:3100/v1" })).toThrow(RangeError);
  expect(() => createWorldClient({ endpoint: "" })).toThrow(RangeError);
});
