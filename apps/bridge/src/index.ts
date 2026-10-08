/**
 * PC上で動作する中継アプリの起動点。
 *
 * `127.0.0.1` に明示 bind する WebSocket サーバを起動し、標準入力の `pair`
 * 命令でペアリング秘密値を発行する。診断ログは標準エラー、利用者へ手渡す
 * 秘密値は標準出力に出す。
 *
 * 起動例: `node dist/index.mjs --port 3100`
 * 開発時: `node dist/index.mjs --dev --origin http://localhost:5173`
 *
 * @packageDocumentation
 */
import { createInterface } from "node:readline";
import { PRODUCTION_ORIGIN } from "./verify.ts";
import { createBridgeServer, type BridgeServer } from "./server.ts";

const DEFAULT_PORT = 3100;

interface CliOptions {
  port: number;
  dev: boolean;
  origins: string[];
}

/**
 * 引数を解釈する。
 *
 * @param argv - プロセス引数（先頭2要素を除く）。
 */
function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { port: DEFAULT_PORT, dev: false, origins: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const value = argv[index + 1];
      const port = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RangeError("--port は 1〜65535 の整数であること。");
      }
      options.port = port;
      index += 1;
    } else if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--origin") {
      const value = argv[index + 1];
      if (value === undefined || value === "") {
        throw new RangeError("--origin には値を指定すること。");
      }
      options.origins.push(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "使い方: bridge [--port N] [--dev] [--origin ORIGIN]...\n" +
          "  --origin は --dev 指定時のみ受け付ける。\n" +
          "対話命令: pair <origin> / status / connections / disconnect <connectionId> / quit\n",
      );
      process.exit(0);
    } else {
      throw new RangeError(`未知の引数である: ${arg}`);
    }
  }
  if (options.origins.length > 0 && !options.dev) {
    throw new RangeError("--origin は明示的開発モード (--dev) でのみ指定できる。");
  }
  return options;
}

/**
 * 対話命令を処理する。秘密値は標準出力にのみ出しログには出さない。
 *
 * @param line - 入力行。
 * @param server - 起動中のブリッジ。
 * @returns 終了する場合に真。
 */
function handleCommand(line: string, server: BridgeServer): boolean {
  const [command, ...rest] = line.trim().split(/\s+/);
  if (command === "pair") {
    const origin = rest[0];
    if (origin === undefined) {
      process.stdout.write("使い方: pair <origin>\n");
      return false;
    }
    try {
      const issued = server.issuePairing(origin);
      // 秘密値の手渡しは標準出力のみ。ログ・URL・query には出さない。
      process.stdout.write(
        `pairing origin=${issued.origin} expires=${new Date(issued.expiresAt).toISOString()}\n` +
          `secret: ${issued.secret}\n` +
          "ワールド画面で上記 secret を入力して接続すること（一度だけ有効）。\n",
      );
    } catch (error) {
      process.stdout.write(
        `pair 失敗: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return false;
  }
  if (command === "status") {
    const stats = server.getStats();
    process.stdout.write(
      `endpoint=${server.endpoint} connections=${server.getConnectionCount()} ` +
        `authSuccess=${stats.authSuccess} authFailure=${stats.authFailure} ` +
        `echo=${stats.echoCount} command=${stats.commandCount}\n`,
    );
    printConnections(server);
    return false;
  }
  if (command === "connections" || command === "list") {
    printConnections(server);
    return false;
  }
  if (command === "disconnect") {
    const connectionId = rest[0];
    if (connectionId === undefined) {
      process.stdout.write("使い方: disconnect <connectionId>\n");
      return false;
    }
    try {
      server.disconnectConnection(connectionId);
      process.stdout.write(`disconnected ${connectionId}\n`);
    } catch (error) {
      // ADR: 不明IDで全切断へ fallback しない。明示エラーに留める。
      process.stdout.write(
        `disconnect 失敗: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return false;
  }
  if (command === "quit" || command === "exit") {
    return true;
  }
  if (command !== undefined && command !== "") {
    process.stdout.write(`未知の命令である: ${command}\n`);
  }
  return false;
}

/**
 * 接続一覧を表示する。接続ID・Origin・認証状態のみ出し、秘密値は出さない。
 *
 * @param server - 起動中のブリッジ。
 */
function printConnections(server: BridgeServer): void {
  const list = server.listConnections();
  if (list.length === 0) {
    process.stdout.write("connections: (none)\n");
    return;
  }
  for (const item of list) {
    process.stdout.write(
      `connection id=${item.connectionId} origin=${item.origin} authorized=${item.authorized ? "yes" : "no"}\n`,
    );
  }
}

/** CLI の起動処理。 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = await createBridgeServer({
    port: options.port,
    allowedOrigins: [PRODUCTION_ORIGIN, ...(options.dev ? options.origins : [])],
  });
  process.stdout.write(`listening ${server.endpoint}\n`);
  process.stdout.write(
    "命令: pair <origin> / status / connections / disconnect <connectionId> / quit\n",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line: string) => {
    if (handleCommand(line, server)) {
      rl.close();
      void server.close().then(() => {
        process.exit(0);
      });
    }
  });
  const shutdown = (): void => {
    rl.close();
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`起動失敗: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
