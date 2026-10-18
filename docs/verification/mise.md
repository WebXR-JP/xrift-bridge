# mise 導入の検証記録（2026-10-17 実施）

ツール選択版を `mise.toml` に寄せた変更の検証記録である。版の正本は `mise.toml`、手順の正本は `README.md`、CI 定義の正本は `.github/workflows/` とし、ここでは複製しない。

## 環境・対象

- macOS Apple Silicon、`mise` 2026.10.11（`/opt/homebrew/bin/mise`）。
- 対象は本変更の作業ツリー（`mise.toml` 新規、`package.json`・`pnpm-lock.yaml`・`ci.yml`・`release.yml`・`README.md`・`AGENTS.md` の変更）。
- 比較用として、mise 管理外の素の Node は v24.22.0（`mise exec` 配下では使わない）。

## 検証結果

- `mise trust`・`mise install` は成功する。`mise ls --current` で node 22.23.3・pnpm 12.10.1・act 0.2.89 が `mise.toml` 由来であること、`mise which` の実体が mise 配下であることを確認する。
- 版の確認は `mise exec -- node --version`（v22.23.3）、`mise exec -- node -p 'process.execPath'`（mise 配下の実体）、`mise exec -- pnpm --version`（12.10.1）、`mise exec -- act --version`（0.2.89）で行う。
- lockfile は pnpm の自己管理エントリを整理するため、pnpm 自身による再解決で書き直す。差分は 183 行削除・追加 0 で、アプリ依存の変動は無い。独立検証では整理前の 2 文書構成でも `--frozen-lockfile` が EXIT=0 となるため、この整理は CI 成功の必須条件ではない。整理後も `mise exec -- pnpm install --frozen-lockfile` が EXIT=0 となり、lockfile の変更や `devEngines` の復活が無いことを確認する。
- `vp` は `mise exec -- pnpm exec which vp` が workspace の `node_modules/.bin/vp` を指し、`mise exec -- pnpm exec vp --version` が 1.0.0 であること、使う Node が mise の v22.23.3 であることを確認する。
- `mise.lock` は存在しない（`lockfile = false` のとおり）。
- `mise exec -- pnpm --filter bridge-gui-main gui:prepare` は成功する（plugin 3件の build と `electrobun prepare complete`、EXIT=0）。
- `mise exec -- pnpm exec vp check` は EXIT=0（0 errors・51 warnings。警告は本変更と非交差の既存箇所）。
- 独立検証では、クリーンコピーで `mise exec -- pnpm ready` 全体（build・check・test・test:types）が EXIT=0 で完了する。

## 注意

- pnpm 12 の lockfile は自己管理用の別文書を含むことがあり、先頭の `---` を残した切り取りでは pnpm が lockfile を認識しない。文書ごと落とす場合は区切りの `---` ごと落とす。以後の版上げ時は `pnpm install` の差分で確かめる。
- リポジトリ外では `mise exec` が `mise.toml` を読まず別版（確認時は pnpm 11.5.1）になる。検証はリポジトリ直下で行う。
- 素の `node` は PATH 順に依存し、この検証環境では v24.22.0 を選ぶ。一方 `pnpm` は mise の shim を経由するため、`pnpm exec node` は v22.23.3 を選ぶ。`vp` も起動経路によって環境が変わる。これらは環境依存なので、再現用コマンドはリポジトリ直下で `mise exec --` を付け、workspace の `vp` は `mise exec -- pnpm exec vp ...` で起動する。

## 検証状況と未確認事項

- act による `ci.yml` の `check` ジョブと `release.yml` の macOS build は [act.md](act.md) に記録した（Linux は Lima の docker VM 上の arm64 コンテナ、macOS は `-self-hosted` によるホスト実行）。Windows runner は未確認。
- GitHub Actions 上の CI と `release.yml` の3OS build（`workflow_dispatch`）は [github-actions.md](github-actions.md) に記録した。`v0.1.0` タグ実行による Release 作成まで成功している。
