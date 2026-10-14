/**
 * CLI 対話命令の検証。
 *
 * `bridge-server` の公開 API で起動した実サーバに対し、`apps/bridge-cli` の
 * `handleCommand` が受付の有効化・無効化・保留表示・承認/拒否・状態表示を行うことを確かめる。
 * パッケージからアプリを参照できないため、送受信の試験器具は
 * `bridge-server` 側から必要最小限だけ複製して自己完結させる。
 *
 * @packageDocumentation
 */
import { afterEach, expect, test } from "vite-plus/test";
import { WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  formatPairingCode,
  parseBridgeMessage,
  type BridgeMessage,
} from "bridge-protocol";
import { createBridgeServer, type BridgeOptions, type BridgeServer } from "bridge-server";
import { handleCommand } from "../src/index.ts";

const DEV_ORIGIN = "http://localhost:5173";

const servers: BridgeServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // 終了済みは無視する。
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(options?: Partial<BridgeOptions>): Promise<BridgeServer> {
  const server = await createBridgeServer({
    port: 0,
    allowedOrigins: ["https://app.xrift.net", DEV_ORIGIN],
    ...options,
  });
  servers.push(server);
  return server;
}

/** 対話命令の表示先を集める試験用の出力先。 */
function captureOutput(): { output: string[]; out: { write(text: string): void } } {
  const output: string[] = [];
  return {
    output,
    out: {
      write: (text: string): void => {
        output.push(text);
      },
    },
  };
}

/** text 受信値を文字列へ復元する（`isBinary` が偽の場合のみ使う）。 */
function textFrom(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

/**
 * 認可前テキストの継続購読器。
 *
 * 作成時点から text のみ集め、binary は保持列へ退避する。
 */
class TextCollector {
  private readonly frames: string[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        this.frames.push(textFrom(data));
      }
      for (const notify of this.waiters) {
        notify();
      }
    });
  }

  private takeMatch(
    predicate: (message: BridgeMessage) => boolean,
  ): { raw: string; message: BridgeMessage } | null {
    for (let index = 0; index < this.frames.length; index += 1) {
      const raw = this.frames[index];
      if (raw === undefined) continue;
      let parsed: BridgeMessage;
      try {
        parsed = parseBridgeMessage(raw);
      } catch {
        throw new Error(`想定外の非準拠フレームを受信した: ${raw.slice(0, 200)}`);
      }
      if (predicate(parsed)) {
        this.frames.splice(0, index + 1);
        return { raw, message: parsed };
      }
    }
    return null;
  }

  async waitFor(
    predicate: (message: BridgeMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    const matched = this.takeMatch(predicate);
    if (matched !== null) return matched;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("応答待ちがタイムアウトした。");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(notify);
          resolve();
        }, remaining);
        const notify = (): void => {
          clearTimeout(timer);
          this.waiters.delete(notify);
          resolve();
        };
        this.waiters.add(notify);
      });
      const retry = this.takeMatch(predicate);
      if (retry !== null) return retry;
    }
  }

  async waitForErrorCode(
    code: string,
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    return this.waitFor((message) => message.type === "error" && message.code === code, timeoutMs);
  }

  async waitForType(
    type: BridgeMessage["type"],
    timeoutMs = 3_000,
  ): Promise<{ raw: string; message: BridgeMessage }> {
    return this.waitFor((message) => message.type === type, timeoutMs);
  }
}

function openRaw(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      url,
      origin === undefined ? [] : ({ origin } as unknown as string[]),
    );
    sockets.push(socket);
    socket.on("open", () => {
      resolve(socket);
    });
    socket.on("error", (error: Error) => {
      reject(error);
    });
  });
}

/** 接続直後から購読する送受信器を開く。 */
async function openCollected(
  url: string,
  origin: string,
): Promise<{ socket: WebSocket; collector: TextCollector }> {
  const socket = await openRaw(url, origin);
  const collector = new TextCollector(socket);
  return { socket, collector };
}

function pairingStartMessage(): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "pairing_start" });
}

test("CLIでaccept enable・pending・approve・reject・statusが動く", async () => {
  const server = await startServer({ generateCode: () => "000042" });
  const captured = captureOutput();
  const out = captured.out;
  handleCommand("accept enable", server, out);
  expect(captured.output.join("")).toContain("enabled=true");

  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const cliRequestId = pending.message.requestId;
  // 先頭ゼロ保持の区切り表示。
  expect(formatPairingCode("000042")).toBe("000 042");
  handleCommand("pending", server, out);
  const pendingText = captured.output.join("");
  expect(pendingText).toContain(cliRequestId);
  expect(pendingText).toContain("000 042");
  expect(pendingText).toContain(DEV_ORIGIN);

  // 引数不足・余剰引数（旧式 `approve <id> <code>`）は厳密に弾く。
  handleCommand("approve", server, out);
  expect(captured.output.join("")).toContain("使い方: approve");
  handleCommand(`approve ${cliRequestId} 000042`, server, out);
  expect(captured.output.join("")).toContain("使い方: approve");
  expect(server.listPending()).toHaveLength(1);

  handleCommand(`approve ${cliRequestId}`, server, out);
  expect(captured.output.join("")).toContain(`approved ${cliRequestId}`);
  const ok = await collector.waitForType("auth_ok");
  expect(ok.message.type).toBe("auth_ok");

  handleCommand("status", server, out);
  const statusText = captured.output.join("");
  expect(statusText).toContain("acceptance=enabled");
  expect(statusText).toContain("authorized=1");
  expect(statusText).toContain("pairingSuccess=1");

  // 2件目を作って reject する。
  const second = await openCollected(server.endpoint, DEV_ORIGIN);
  second.socket.send(pairingStartMessage());
  const secondPending = await second.collector.waitForType("pairing_pending");
  if (secondPending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const secondRequestId = secondPending.message.requestId;
  handleCommand(`reject ${secondRequestId}`, server, out);
  expect(captured.output.join("")).toContain(`rejected ${secondRequestId}`);
  const rejectError = await second.collector.waitForErrorCode("PAIRING_REJECTED");
  expect(rejectError.message.type).toBe("error");

  handleCommand("accept disable", server, out);
  expect(captured.output.join("")).toContain("enabled=false");
  handleCommand("pending", server, out);
  expect(captured.output.join("")).toContain("pending: (none)");
  expect(handleCommand("quit", server, out)).toBe(true);
});

test("CLIのapproveは余剰引数を黙って受け付けず承認しない", async () => {
  const server = await startServer({ generateCode: () => "000042" });
  const captured = captureOutput();
  const out = captured.out;
  handleCommand("accept enable", server, out);
  const { socket, collector } = await openCollected(server.endpoint, DEV_ORIGIN);
  socket.send(pairingStartMessage());
  const pending = await collector.waitForType("pairing_pending");
  if (pending.message.type !== "pairing_pending") throw new Error("保留通知ではない。");
  const requestId = pending.message.requestId;
  // 旧式の2引数は使い方の表示に留め、承認も切断もしない。
  handleCommand(`approve ${requestId} 000042`, server, out);
  expect(captured.output.join("")).toContain("使い方: approve");
  expect(server.listPending()).toHaveLength(1);
  // 要求 ID だけでは承認が成立する。
  handleCommand(`approve ${requestId}`, server, out);
  expect(captured.output.join("")).toContain(`approved ${requestId}`);
  const ok = await collector.waitForType("auth_ok");
  expect(ok.message.type).toBe("auth_ok");
});

test("CLIのstatusは受付状態・各接続数・理由別拒否集計を出す", async () => {
  const server = await startServer();
  const captured = captureOutput();
  const out = captured.out;
  handleCommand("status", server, out);
  let text = captured.output.join("");
  expect(text).toContain("acceptance=disabled");
  expect(text).toContain("connections=0");
  server.enableAcceptance();
  handleCommand("status", server, out);
  text = captured.output.join("");
  expect(text).toContain("acceptance=enabled");
  // 拒否を1件起こすと集計に出る。
  await expect(openRaw(server.endpoint, "https://evil.example")).rejects.toThrow();
  handleCommand("status", server, out);
  text = captured.output.join("");
  expect(text).toContain("origin_rejected=1");
});
