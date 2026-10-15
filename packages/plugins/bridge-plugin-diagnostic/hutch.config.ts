// @hutch cli=0.27.1 cottontail=0.7.1
export default {
  // 依存解決はルート pnpm に一本化する。bridge-gui-main と同じく独自の
  // install タスクは持たず、hutch.lock も作らない。初回はルートで
  // `pnpm install` し、この package で `hutch electrobun prepare` すること。
  // ADR: Hutch 既定のリゾルバ（hutch.lock）を使わない理由は、独立 lockfile の
  // 持ち込み禁止と二重解決の防止である（text と同じ規約の複製）。
  packageManager: "pnpm",
  electrobun: {
    // Electrobun 2.0.2（text・app の pin と同一。`bridge-gui-main` の stage script が
    // 包装前に一致を検証する。不一致は包装せず失敗させる）。
    version: "2.0.2",
  },
  // 注意: Hutch 名前空間の build/run/dev タスクは持たない。子画面の完成資産は
  // `vite.view.config.ts`（`pnpm build`）で作り、Hutch の view バンドルは
  // app 側の汎用 stub に任せる。この package で Hutch を使うのは devkit の
  // 用意だけであり、`pnpm build` が先に `hutch electrobun prepare` を満たすため
  // 別途 `gui:prepare` を叩かずに build できる（`gui:prepare` は単独再用意の口である）。
};
