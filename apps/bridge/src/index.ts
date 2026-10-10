/**
 * PC上で動作する中継アプリの起動点。
 *
 * `127.0.0.1` に明示 bind する WebSocket サーバを起動し、標準入力の対話命令で
 * ペアリング受付の開閉・保留一覧・承認/拒否・状態表示・接続管理を行う。
 * 診断ログは標準エラー、利用者への表示は標準出力に出す。
 * 比較コードは `pending` の明示表示にだけ出し、ログ・URL・永続保存には出さない。
 *
 * 起動例: `node dist/index.mjs --port 3100`
 * 開発時: `node dist/index.mjs --dev --origin http://localhost:5173`
 *
 * @packageDocumentation
 */
import { createInterface } from "node:readline";
import { formatPairingCode, isPairingCode } from "bridge-protocol";
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
 * @returns 待ち受け設定。
 * @throws `RangeError` — 未知の引数・不正なポート・`--dev` なしの `--origin` の場合。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
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
          "対話命令: accept open / accept close / pending / approve <requestId> <code> / reject <requestId> / status / connections / disconnect <connectionId> / quit\n",
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
 * 対話命令の出力先。試験で差し替えできるよう標準出力への依存を閉じ込める。
 */
export interface CommandOutput {
  /** 1件の表示行を書き出す。 */
  write(text: string): void;
}

/** 既定の出力先。標準出力へ出す。 */
const stdoutOutput: CommandOutput = {
  write: (text) => {
    void process.stdout.write(text);
  },
};

/**
 * 対話命令を処理する。比較コードは `pending` の明示表示にだけ出し、
 * ログには出さない。
 *
 * @param line - 入力行。
 * @param server - 起動中のブリッジ。
 * @param out - 表示の出力先。省略時は標準出力。
 * @returns 終了する場合に真。
 */
export function handleCommand(
  line: string,
  server: BridgeServer,
  out: CommandOutput = stdoutOutput,
): boolean {
  const [command, ...rest] = line.trim().split(/\s+/);
  if (command === "accept") {
    const sub = rest[0];
    if (sub === "open") {
      const info = server.openAcceptance();
      out.write(
        `acceptance state=${info.state}` +
          (info.endsAt === null ? "" : ` endsAt=${new Date(info.endsAt).toISOString()}`) +
          ` remainingMs=${info.remainingMs}\n`,
      );
      return false;
    }
    if (sub === "close") {
      server.closeAcceptance();
      const info = server.getAcceptance();
      out.write(`acceptance state=${info.state}\n`);
      return false;
    }
    out.write("使い方: accept open / accept close\n");
    return false;
  }
  if (command === "pending") {
    const list = server.listPending();
    if (list.length === 0) {
      out.write("pending: (none)\n");
      return false;
    }
    for (const item of list) {
      let display: string;
      try {
        display = formatPairingCode(item.code);
      } catch {
        out.write(`pending requestId=${item.requestId} origin=${item.origin} code=(invalid)\n`);
        continue;
      }
      const remainingSec = Math.max(0, Math.ceil(item.remainingMs / 1000));
      out.write(
        `pending requestId=${item.requestId} origin=${item.origin} code=${display} remaining=${remainingSec}s\n`,
      );
    }
    return false;
  }
  if (command === "approve") {
    const requestId = rest[0];
    const code = rest[1];
    // コードは文字列のまま扱い数値化しない。先頭ゼロ保持のため `Number` 変換はしない。
    if (requestId === undefined || requestId === "" || code === undefined || code === "") {
      out.write("使い方: approve <requestId> <6桁コード>\n");
      return false;
    }
    if (!isPairingCode(code)) {
      out.write("approve 失敗: コードは ASCII 数字6文字であること。\n");
      return false;
    }
    const result = server.approvePairing(requestId, code);
    if (result.status === "APPROVED") {
      out.write(`approved ${requestId} connection=${result.connectionId}\n`);
    } else {
      out.write(`approve 失敗: ${result.status} ${requestId}\n`);
    }
    return false;
  }
  if (command === "reject") {
    const requestId = rest[0];
    if (requestId === undefined || requestId === "") {
      out.write("使い方: reject <requestId>\n");
      return false;
    }
    const result = server.rejectPairing(requestId);
    if (result.status === "REJECTED") {
      out.write(`rejected ${requestId}\n`);
    } else {
      out.write(`reject 失敗: ${result.status} ${requestId}\n`);
    }
    return false;
  }
  if (command === "status") {
    const stats = server.getStats();
    const acceptance = server.getAcceptance();
    const list = server.listConnections();
    const pending = server.listPending();
    const authorized = list.filter((item) => item.authorized).length;
    const unauthorized = list.length - authorized;
    const closing = list.filter((item) => item.phase === "closing").length;
    const rejections = Object.entries(stats.rejectionsByReason)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    out.write(
      `endpoint=${server.endpoint} connections=${server.getConnectionCount()} ` +
        `authorized=${authorized} unauthorized=${unauthorized} pending=${pending.length} closing=${closing} ` +
        `acceptance=${acceptance.state}` +
        (acceptance.endsAt === null
          ? ""
          : ` acceptanceEndsAt=${new Date(acceptance.endsAt).toISOString()}`) +
        ` pairingSuccess=${stats.pairingSuccess} pairingFailure=${stats.pairingFailure} ` +
        `latestStored=${stats.latestStored} diagnosticEcho=${stats.diagnosticEcho} diagnosticPing=${stats.diagnosticPing}` +
        (rejections === "" ? "" : ` rejections:${rejections}`) +
        `\n`,
    );
    printConnections(server, out);
    return false;
  }
  if (command === "connections" || command === "list") {
    printConnections(server, out);
    return false;
  }
  if (command === "disconnect") {
    const connectionId = rest[0];
    if (connectionId === undefined) {
      out.write("使い方: disconnect <connectionId>\n");
      return false;
    }
    try {
      server.disconnectConnection(connectionId);
      out.write(`disconnected ${connectionId}\n`);
    } catch (error) {
      // ADR: 不明IDで全切断へ fallback しない。明示エラーに留める。
      out.write(`disconnect 失敗: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return false;
  }
  if (command === "quit" || command === "exit") {
    return true;
  }
  if (command !== undefined && command !== "") {
    out.write(`未知の命令である: ${command}\n`);
  }
  return false;
}

/**
 * 接続一覧を表示する。接続ID・Origin・認証状態のみ出し、比較コードは出さない。
 *
 * @param server - 起動中のブリッジ。
 * @param out - 表示の出力先。省略時は標準出力。
 */
export function printConnections(server: BridgeServer, out: CommandOutput = stdoutOutput): void {
  const list = server.listConnections();
  if (list.length === 0) {
    out.write("connections: (none)\n");
    return;
  }
  for (const item of list) {
    out.write(
      `connection id=${item.connectionId} origin=${item.origin} authorized=${item.authorized ? "yes" : "no"} phase=${item.phase}\n`,
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
    "命令: accept open / accept close / pending / approve <requestId> <code> / reject <requestId> / status / connections / disconnect <connectionId> / quit\n",
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

// 試験で `src/index.ts` を取込むと待ち受け起動しないよう、
// CLI 起動として呼ばれた場合だけ実行する。
const invokedAsCli = process.argv.some(
  (arg) => arg.endsWith("index.ts") || arg.endsWith("index.mjs"),
);
if (invokedAsCli) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`起動失敗: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
