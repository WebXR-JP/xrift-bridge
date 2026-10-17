/**
 * 管理画面（Angular）の事前生成物の staging。
 *
 * UI パッケージ自身の生成物（`apps/bridge-gui-ui/dist/<channel>/browser`）を
 * app 内 staging（`src/mainview-dist/<channel>/`）へ実コピーする。
 * `electrobun.config.ts` の `copy` は staging を正本として
 * `views/mainview/` へ載せる（package 外の直接指定は `UnsafeOutputPath` で
 * 却下される実測のため、写しを経由する）。
 *
 * 守る境界は以下である。
 * - 生成物の欠落（配置自体・`index.html`）があれば包装前に失敗させる
 *   （存在時のみコピーはしない。生成忘れの検出のために落とす）。
 * - 写し先は作り直し、前回分は残さない（dev/prod 混在の罠の排除）。
 * - POSIX 専用の shell 書換え（`rm -rf`・`mkdir -p`・`cp -R`）を持たない。
 *   `package.json` の `gui:run` 系から呼ぶ cross-platform の写しである。
 *
 * 実行は `pnpm stage:ui dev` または `pnpm stage:ui prod`
 * （`node --experimental-strip-types` で走る。消去可能な型だけを使う）。
 *
 * @packageDocumentation
 */
import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** staging 対象の channel。UI 生成物の配置と写し先を切替える。 */
export type UiChannel = "dev" | "prod";

/** staging の差し替え指定。省略時は正規配置を使う。 */
export interface StageUiOptions {
  /** 生成物の配置元。省略時は channel から決まる正規配置である。 */
  readonly source?: string;
  /** staging の配置先。省略時は channel から決まる正規配置である。 */
  readonly destination?: string;
}

/** staging の解決済み配置。実コピー前の検証済み材料である。 */
export interface UiPaths {
  /** 生成物の配置元。 */
  readonly source: string;
  /** staging の配置先。 */
  readonly destination: string;
}

/** staging 実行の記録。 */
export interface StageUiResult extends UiPaths {
  /** 写したファイル数。 */
  readonly fileCount: number;
  /** 写した合計バイト数。 */
  readonly totalBytes: number;
}

/**
 * 引数が staging 対象の channel かを確かめる。
 *
 * @param value - 実行時引数。
 * @returns `dev`・`prod` のいずれかの場合に真。
 */
export function isUiChannel(value: string): value is UiChannel {
  return value === "dev" || value === "prod";
}

/**
 * 正規配置の生成物・staging 配置を求める。
 *
 * 生成物は UI パッケージ自身の `dist`（workspace 基準の正規配置）であり、
 * staging は app 内配置である。実パス解決は cwd に依存せず、
 * この script の配置から app 配置を求める。
 *
 * @param channel - staging 対象の channel。
 * @param appDir - app（`bridge-gui-main`）の配置。省略時はこの script の親である。
 * @returns 生成物と staging の配置。
 */
export function resolveUiPaths(channel: UiChannel, appDir?: string): UiPaths {
  const resolvedAppDir = appDir ?? dirname(dirname(fileURLToPath(import.meta.url)));
  return {
    source: resolve(resolvedAppDir, "..", "bridge-gui-ui", "dist", channel, "browser"),
    destination: resolve(resolvedAppDir, "src", "mainview-dist", channel),
  };
}

/**
 * 配置下の通常ファイルを数える。合計バイト数の材料である。
 *
 * @param dir - 数える配置。
 * @returns ファイル数と合計バイト数。
 */
function countFiles(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = countFiles(full);
      fileCount += inner.fileCount;
      totalBytes += inner.totalBytes;
    } else if (entry.isFile()) {
      fileCount += 1;
      totalBytes += statSync(full).size;
    }
  }
  return { fileCount, totalBytes };
}

/**
 * 生成物を staging へ写す。写し先は作り直し、前回分は残さない。
 *
 * 生成物の欠落（配置自体・`index.html`）は実装の不備であり、黙って写さない。
 *
 * @param channel - staging 対象の channel。
 * @param options - 差し替え指定（検証用の source/destination）。
 * @returns 写し先と写した規模の記録。
 * @throws `Error` — 生成物の欠落や読取り失敗の場合。
 */
export function stageUi(channel: UiChannel, options: StageUiOptions = {}): StageUiResult {
  const defaults = resolveUiPaths(channel);
  const source = options.source ?? defaults.source;
  const destination = options.destination ?? defaults.destination;
  let isDirectory = false;
  try {
    isDirectory = statSync(source).isDirectory();
  } catch {
    throw new Error(
      `生成物が無いため staging できない: ${source}（先に bridge-gui-ui を build すること）`,
    );
  }
  if (!isDirectory) {
    throw new Error(`生成物がディレクトリでないため staging できない: ${source}`);
  }
  let entries: string[];
  try {
    entries = readdirSync(source);
  } catch {
    throw new Error(`生成物を読めないため staging できない: ${source}`);
  }
  if (!entries.includes("index.html")) {
    throw new Error(`生成物に index.html が無いため staging できない: ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  const { fileCount, totalBytes } = countFiles(destination);
  return { source, destination, fileCount, totalBytes };
}

/**
 * 引数を読む。`dev`・`prod` のいずれか1件だけを受け付ける。
 *
 * @param argv - 実行時引数。
 * @returns staging 対象の channel。
 * @throws `Error` — 欠落・複数・未知の channel の場合。
 */
function parseArgs(argv: readonly string[]): UiChannel {
  if (argv.length !== 1 || argv[0] === undefined) {
    throw new Error("引数は dev または prod のいずれか1件である。");
  }
  if (!isUiChannel(argv[0])) {
    throw new Error(`不明な channel である: ${argv[0]}（dev または prod を指定すること）`);
  }
  return argv[0];
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const channel = parseArgs(process.argv.slice(2));
    const result = stageUi(channel);
    console.log(
      `staged[${channel}]: files=${result.fileCount} bytes=${result.totalBytes} -> ${result.destination}`,
    );
  } catch (error: unknown) {
    console.error(`staging に失敗した: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
