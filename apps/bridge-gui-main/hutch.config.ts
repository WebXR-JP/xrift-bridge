// @hutch cli=0.27.1 cottontail=0.7.1
export default {
  // 依存解決はルート pnpm に一本化する。bridge-gui-main 独自の install タスクは持たず、
  // hutch.lock も作らない。初回はルートで `pnpm install` すること。
  // ADR: Hutch 既定のリゾルバ（hutch.lock）を使わない理由は、独立 lockfile の
  // 持ち込み禁止と二重解決の防止である。外部管理に寄せる場合も pnpm を経由する。
  packageManager: "pnpm",
  electrobun: {
    // Electrobun 2.0.2（stable テンプレートの検証済み pin と同一）。
    version: "2.0.2",
  },
  scripts: {
    // 注意: これらは Hutch 名前空間のタスクであり、package.json の同名
    // スクリプトとは別物である。相互に呼び出さない（無限ループ防止）。
    // package.json の `build` は通常の再帰 build（型検査のみ）に合わせ、
    // ネイティブ包装を伴う Hutch ビルドは下記の opt-in 入口に分離する。
    dev: ["hutch", "electrobun", "dev", "--watch"],
    run: ["hutch", "electrobun", "run"],
    build: ["hutch", "electrobun", "build", "--env=stable"],
  },
};
