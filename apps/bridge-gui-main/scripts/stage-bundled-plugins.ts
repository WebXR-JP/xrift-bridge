/**
 * プラグインパッケージの完成資産の staging。
 *
 * 各プラグインパッケージの完成資産（`dist/view/` の3件）を app 内 staging
 * （`src/plugin-view-dist/<種別>/`）へ実コピーする。`electrobun.config.ts` の
 * `copy` は staging を正本として `views/plugin-<種別>/` へ載せる。
 * 対象は同梱表（`src/composition/bundled-plugin-assets.ts`）から決まり、
 * 種別ごとの分岐を持たない。種別の追加は同梱表の1行である。
 *
 * 守る境界は以下である。
 * - プラグインの `src` は読まない。公開 export 越し（package 名解決）に
 *   完成資産だけを扱う。
 * - 完成資産の欠落・余剰があれば包装前に失敗させる（存在時のみコピーは
 *   しない。生成忘れの検出のために落とす）。
 * - プラグイン側と app 側の Electrobun pin が不一致なら包装前に失敗させる。
 *
 * 実行は `pnpm stage:plugins`（`node --experimental-strip-types` で走る。
 * 消去可能な型だけを使う）。引数なしは同梱表の全種別を写す。
 * `--kind <種別> --plugin-dir <path> --app-dir <path>` 指定は検証用の
 * 差し替えである（`--kind` 省略時は全種別。差し替え時は種別指定が必須）。
 *
 * @packageDocumentation
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 完成資産の固定集合。dev/prod 共通の一組であり、二重生成しない。 */
export const EXPECTED_VIEW_FILES = ["index.js", "index.html", "index.css"] as const;

/** staging の写し先（package 基準）。`copy` 表の複写元と一致させる。 */
export const STAGED_TEXT_DIR = "src/plugin-view-dist/text";

/** staging の写し先（diagnostic）。`copy` 表の複写元と一致させる。 */
export const STAGED_DIAGNOSTIC_DIR = "src/plugin-view-dist/diagnostic";

/** staging の写し先（udp）。`copy` 表の複写元と一致させる。 */
export const STAGED_UDP_DIR = "src/plugin-view-dist/udp";

/**
 * 種別から staging の写し先を求める。種別ごとの分岐を持たない。
 *
 * @param kind - companion の種別トークン。
 * @returns package 基準の staging 配置。
 */
export function stagedDirFor(kind: string): string {
  return `src/plugin-view-dist/${kind}`;
}

/**
 * 種別からプラグインパッケージ名を求める。種別ごとの分岐を持たない。
 *
 * @param kind - companion の種別トークン。
 * @returns package 名。
 */
export function pluginPackageFor(kind: string): string {
  return `bridge-plugin-${kind}`;
}

/**
 * `hutch.config.ts` 本文から Electrobun の pin を抜く。
 *
 * @param source - `hutch.config.ts` の本文。
 * @returns `electrobun.version`。書式が違えば `null`。
 */
export function extractElectrobunPin(source: string): string | null {
  const block = source.match(/electrobun\s*:\s*\{([\s\S]*?)\}/);
  if (block === null || block[1] === undefined) {
    return null;
  }
  const version = block[1].match(/version\s*:\s*"([^"]+)"/);
  return version?.[1] ?? null;
}

/** staging 計画の入力。省略時は正規配置を使う。 */
export interface StageOptions {
  /** staging 対象の種別。省略時は `pluginDir`・`appDir` の差し替え専用とみなさない。 */
  readonly kind?: string;
  /** プラグインパッケージの配置。省略時は種別から決まる package 名解決である。 */
  readonly pluginDir?: string;
  /** app（`bridge-gui-main`）の配置。省略時はこの script の親である。 */
  readonly appDir?: string;
}

/** staging 計画。実コピー前の検証済み材料である。 */
export interface StagePlan {
  /** staging 対象の種別。 */
  readonly kind: string;
  /** 完成資産の配置元。 */
  readonly pluginDistDir: string;
  /** staging の配置先。 */
  readonly stagedDir: string;
  /** 写す完成資産の名。 */
  readonly files: readonly string[];
  /** 両側の Electrobun pin（一致済み）。 */
  readonly electrobunPin: string;
}

/**
 * 正規配置の plugin・app 配置を求める。
 *
 * プラグインは種別から決まる package 名解決（公開 export 越し）で引き、
 * 相対 path の直書きや `src` 参照はしない。app はこの script の配置から求める。
 *
 * @param kind - staging 対象の種別。
 * @param options - 差し替え指定。
 * @returns plugin・app の配置。
 */
function resolveRoots(kind: string, options: StageOptions): { pluginDir: string; appDir: string } {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pluginDir =
    options.pluginDir ??
    dirname(createRequire(import.meta.url).resolve(`${pluginPackageFor(kind)}/package.json`));
  return { pluginDir, appDir: options.appDir ?? dirname(scriptDir) };
}

/**
 * 単一種別の staging 計画を作る。検証のみであり、書込みはしない。
 *
 * 完成資産の欠落・余剰・pin 不一致は実装の不備であり、黙って写さない。
 *
 * @param kind - staging 対象の種別。
 * @param options - 差し替え指定。
 * @returns 検証済みの staging 計画。
 * @throws `Error` — 完成資産の欠落・余剰・pin の不一致や読取り失敗の場合。
 */
export function planStage(kind: string, options: StageOptions = {}): StagePlan {
  const { pluginDir, appDir } = resolveRoots(kind, options);
  const pluginDistDir = resolve(pluginDir, "dist/view");
  const stagedDir = resolve(appDir, stagedDirFor(kind));
  let actual: string[];
  try {
    actual = readdirSync(pluginDistDir);
  } catch {
    throw new Error(
      `完成資産が無いため staging できない: ${pluginDistDir}（先に plugin を build すること）`,
    );
  }
  const expected = new Set<string>(EXPECTED_VIEW_FILES);
  const missing = EXPECTED_VIEW_FILES.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(`完成資産が欠けているため staging できない: ${missing.join(", ")}`);
  }
  const extra = actual.filter((name) => !expected.has(name));
  if (extra.length > 0) {
    throw new Error(`完成資産に余剰があるため staging できない: ${extra.join(", ")}`);
  }
  const pluginPin = extractElectrobunPin(
    readFileSync(resolve(pluginDir, "hutch.config.ts"), "utf8"),
  );
  const appPin = extractElectrobunPin(readFileSync(resolve(appDir, "hutch.config.ts"), "utf8"));
  if (pluginPin === null || appPin === null) {
    throw new Error("Electrobun の pin を読めないため staging できない。");
  }
  if (pluginPin !== appPin) {
    throw new Error(
      `Electrobun の pin が不一致のため staging できない: plugin=${pluginPin} app=${appPin}`,
    );
  }
  return { kind, pluginDistDir, stagedDir, files: EXPECTED_VIEW_FILES, electrobunPin: pluginPin };
}

/**
 * 同梱表の全種別の staging 計画を作る。対象は同梱表から決まり、
 * 種別ごとの分岐を持たない。
 *
 * @param options - 差し替え指定（`appDir` のみ使う）。
 * @returns 検証済みの staging 計画の一覧。
 */
export async function planAllStages(
  options: Pick<StageOptions, "appDir"> = {},
): Promise<StagePlan[]> {
  const { BUNDLED_PLUGIN_ASSETS } = await import("../src/composition/bundled-plugin-assets.ts");
  const kinds = (BUNDLED_PLUGIN_ASSETS as readonly { readonly kind: string }[]).map(
    (entry) => entry.kind,
  );
  return kinds.map((kind) => planStage(kind, options));
}

/** 写した完成資産1件の記録。 */
export interface StagedFile {
  /** 資産名。 */
  readonly name: string;
  /** バイト数。 */
  readonly size: number;
  /** sha256 十六進。 */
  readonly sha256: string;
}

/**
 * 計画どおりに実コピーする。写し先は作り直し、前回分は残さない。
 *
 * @param plan - `planStage` の検証済み計画。
 * @returns 写した完成資産の記録。
 */
export function runStage(plan: StagePlan): StagedFile[] {
  rmSync(plan.stagedDir, { recursive: true, force: true });
  mkdirSync(plan.stagedDir, { recursive: true });
  return plan.files.map((name) => {
    const source = resolve(plan.pluginDistDir, name);
    const target = resolve(plan.stagedDir, name);
    copyFileSync(source, target);
    const bytes = readFileSync(target);
    return {
      name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

/**
 * 引数を読む。`--kind <種別>`・`--plugin-dir <path>`・`--app-dir <path>` だけを受け付ける。
 *
 * @param argv - 実行時引数。
 * @returns 差し替え指定。
 */
function parseArgs(argv: readonly string[]): StageOptions {
  let kind: string | undefined;
  let pluginDir: string | undefined;
  let appDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--kind") {
      kind = argv[index + 1];
      index += 1;
    } else if (arg === "--plugin-dir") {
      pluginDir = argv[index + 1];
      index += 1;
    } else if (arg === "--app-dir") {
      appDir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`不明な引数である: ${arg}`);
    }
  }
  if (kind === undefined && (pluginDir !== undefined || appDir !== undefined)) {
    throw new Error("--plugin-dir と --app-dir は --kind と対で指定すること。");
  }
  if ((pluginDir === undefined) !== (appDir === undefined)) {
    throw new Error("--plugin-dir と --app-dir は対で指定すること。");
  }
  return { kind, pluginDir, appDir };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      const plans =
        options.kind !== undefined
          ? [planStage(options.kind, options)]
          : await planAllStages({ appDir: options.appDir });
      for (const plan of plans) {
        const staged = runStage(plan);
        for (const file of staged) {
          console.log(`staged[${plan.kind}]: ${file.name} size=${file.size} sha256=${file.sha256}`);
        }
      }
    } catch (error: unknown) {
      console.error(
        `staging に失敗した: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  })();
}
