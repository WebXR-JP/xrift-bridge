# act によるローカル実行記録（2026-10-17 実施）

`ci.yml` の `check` ジョブと `release.yml` の macOS build を act で実行した記録である。workflow 定義の正本は `.github/workflows/`、手順の正本は `DEVELOPMENT.md` とし、ここでは複製しない。

## 環境

- macOS Apple Silicon
- mise 2026.10.11 / act 0.2.89（`mise.toml`）
- Linux コンテナ用 Docker 29.9.1（Lima 2.2.1 の docker テンプレート。VM は aarch64）
- コンテナイメージ: `catthehacker/ubuntu:act-24.04`（arm64）
- Node 22.23.3・pnpm 12.10.1（mise-action が `mise.toml` から導入）
- Hutch 0.27.1（公式 install.sh）

## CI check（Linux コンテナ）

```sh
limactl start --name=docker --mount-writable template:docker
export DOCKER_HOST="unix://$HOME/.lima/docker/sock/docker.sock"
mise exec -- act workflow_dispatch \
  -W .github/workflows/ci.yml \
  -j check \
  -P ubuntu-24.04=catthehacker/ubuntu:act-24.04 \
  --container-daemon-socket -
```

`--container-daemon-socket -` は転送された Unix ソケットを使う場合に要る。付けないと act がホスト側のソケットパス（`/Users/.../.lima/docker/sock/docker.sock`）をコンテナへ bind mount しようとし、VM 内の Docker デーモンがそのパスを作れず `operation not supported` で失敗する（実測）。Docker Desktop のようにホスト側にソケットが実在する場合は不要である。

結果:

- `CI/check`: 成功（`Job succeeded`）。
- 全 step が成功した: Set up job、Checkout、Restore Hutch store、Setup toolchain（mise-action）、Get pnpm store path、Restore pnpm store、Install dependencies、Install Hutch、Prepare GUI devkits、Build、Stage Angular UI、Check、Test、Test types、Post Restore pnpm store、Post Setup toolchain、Post Restore Hutch store、Complete job。
- `vp check`: 0 errors / 51 warnings（既存警告）。
- `vp run -r test`: 全テスト成功（`bridge-gui-main` は 24 files / 206 tests）。
- `vp run -r test:types`: 成功。
- act の cache server が pnpm store（約 162 MB）と `~/.hutch`（約 97 MB）を保存した。GitHub Actions の cache ではない。
- `pnpm install` で `msgpackr-extract` の prebuilt 読込みが一度失敗し、node-gyp によるローカル再ビルドへフォールバックして成功した。ジョブ全体は成功している（arm64 環境の optional native dependency）。

## macOS release build（ホスト実行）

macOS 上で act を動かし、`-self-hosted` を指定すると Docker を使わずホスト上でジョブを実行できる。macOS runner 向けの job を、登録済みの self-hosted runner なしで手元確認する用途である。

```sh
mkdir -p /tmp/act-artifacts
mise exec -- act workflow_dispatch \
  -W .github/workflows/release.yml \
  -j build \
  --matrix os:macos-14 \
  -P macos-14=-self-hosted \
  --artifact-server-path /tmp/act-artifacts
```

`--matrix os:macos-14` で matrix の macOS entry だけを選ぶ。`-P macos-14=-self-hosted` のキーは `runs-on` に渡るラベルと一致させる。`--artifact-server-path` を付けると `actions/upload-artifact` の保存先が作られ、upload step まで通る。

結果:

- `Desktop Release/build`: 成功（`Job succeeded`）。
- Setup toolchain、Install Hutch、Install dependencies、Prepare GUI devkits、Build workspace、Build desktop app、List artifacts、Upload artifact がすべて成功した。
- 生成物は 3 件: `macos-arm64-XRiftBridge.dmg`（21 MB）、`stable-macos-arm64-XRiftBridge.app.tar.zst`（21 MB）、`stable-macos-arm64-update.json`（214 B）。
- upload された artifact は `<artifact-server-path>/<run-id>/xrift-bridge-macos-arm64/xrift-bridge-macos-arm64.zip`（43,722,283 B）。
- act のホスト実行はリポジトリを作業用コピー（`~/.cache/act/<hash>/hostexecutor`）へ写して実行する。生成物はリポジトリには残らない。

## 注意

- act の `-self-hosted` はコンテナ分離のない実験的なホスト実行である。Docker を要求する action や、ホストに無いツールを使う step は動かない。macOS の release build は Docker を使わないため成立した。
- Linux の実行は arm64 コンテナであり、GitHub の `ubuntu-24.04` runner（x64）と native 依存の解決が同一ではない。x64 での再現は未実施（この Lima VM では `--platform linux/amd64` が `exec format error` になる）。
- Windows runner は Windows ホスト上で `-P windows-latest=-self-hosted` を使う形になるが、今回は未実施である。
- macOS のホスト実行は GitHub の macOS runner イメージと同一ではない。Xcode・CMake などの版はホスト依存であり、完全一致の保証はない。
- GitHub 上の `release.yml` build は `workflow_dispatch` で3OSとも成功し、`v0.1.0` タグ実行で `release` ジョブと GitHub Release 作成まで成功した（[github-actions.md](github-actions.md)）。
- ローカル成功は実 CI の代わりにならない。実 CI の結果は [github-actions.md](github-actions.md) を見る。

## 後片付け

```sh
limactl stop docker
```
