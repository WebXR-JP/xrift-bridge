import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import { defineConfig } from "vite-plus";

/** ビルド識別子に載せる git コミット。取得できない場合は `unknown`。 */
function resolveCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

/** ビルド識別子に載せるパッケージバージョン。 */
function resolveVersion(): string {
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // 読み取れない場合は下の既定値を使う。
  }
  return "0.0.0";
}

const buildInfo = {
  version: resolveVersion(),
  commit: resolveCommit(),
  builtAt: new Date().toISOString(),
};

/**
 * 共有依存の設定1件分。公式テンプレートと同値にする。
 *
 * @originjs/vite-plugin-federation の同梱 .d.ts は `singleton` を
 * コメントアウトしているが、実行時設定としてはテンプレートどおり
 * `singleton: true` を渡す（当該版の実行時に追加処理はなく、host 側の
 * 単一提供と合わせるための宣言である）。
 */
interface FederationSharedEntry {
  readonly singleton: boolean;
  readonly requiredVersion?: string;
}

/** 公式テンプレートと同一の共有・単一提供の設定。 */
const shared: Record<string, FederationSharedEntry> = {
  react: {
    singleton: true,
    requiredVersion: "*",
  },
  "react-dom": {
    singleton: true,
    requiredVersion: "*",
  },
  "react-dom/client": {
    singleton: true,
  },
  "react/jsx-runtime": {
    singleton: true,
  },
  three: {
    singleton: true,
    requiredVersion: "*",
  },
  "three/addons/loaders/GLTFLoader.js": {
    singleton: true,
  },
  "three/addons/loaders/DRACOLoader.js": {
    singleton: true,
  },
  "three/addons/loaders/KTX2Loader.js": {
    singleton: true,
  },
  "@react-three/fiber": {
    singleton: true,
    requiredVersion: "*",
  },
  "@react-three/rapier": {
    singleton: true,
    requiredVersion: "*",
  },
  "@react-three/drei": {
    singleton: true,
    requiredVersion: "*",
  },
  "@react-three/uikit": {
    singleton: true,
    requiredVersion: "*",
  },
  "@pmndrs/uikit": {
    singleton: true,
    requiredVersion: "*",
  },
  "@xrift/world-components": {
    singleton: true,
    requiredVersion: "*",
  },
};
// ADR: 共有設定は公式テンプレートと同一にする。パネル・シーン自体は
// drei・uikit を import しないが、`@xrift/world-components` が内部で
// 参照するため、解決と共有のために依存・設定ともテンプレートどおり置く。

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "xrift_diagnostic_world",
      filename: "remoteEntry.js",
      exposes: {
        "./World": "./src/index.tsx",
      },
      shared,
    }),
  ],
  // 開発サーバは http://localhost:5173 固定。競合時は別ポートへ退避せず失敗させる。
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
    minify: false,
    cssCodeSplit: false,
    assetsDir: "",
  },
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "./src"),
    },
  },
  define: {
    global: "globalThis",
    __DIAGNOSTIC_BUILD__: JSON.stringify(buildInfo),
  },
});
