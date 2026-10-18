# GitHub Actions 初回実行記録（2026-10-18 実施）

`release.yml` の `build` ジョブを GitHub 上で `workflow_dispatch` により実行した記録と、`v0.1.0` タグによる Release 実行の記録である。

## 対象

- リポジトリ: `WebXR-JP/xrift-bridge`
- コミット: `4c2bdc9f4ace68e45c61074ad3acca8659125dfc`
- 実行: run `39117753259`（`workflow_dispatch`、`main`）
- URL: https://github.com/WebXR-JP/xrift-bridge/actions/runs/39117753259
- 同時に `main` push の CI も実行され、run `39117749404` が成功した。

## 結果

run 全体は成功した。

| job                                   | 結果                                    |
| ------------------------------------- | --------------------------------------- |
| `build (macos-14, macos-arm64)`       | success                                 |
| `build (ubuntu-24.04, linux-x64)`     | success                                 |
| `build (windows-latest, windows-x64)` | success                                 |
| `release`                             | skipped（ブランチからの手動実行のため） |

各 build job では次が成功した: Setup toolchain（mise-action）、Install Hutch、Install dependencies、Prepare GUI devkits、Build workspace、Build desktop app、List artifacts、Upload artifact。

## 成果物

Actions artifacts はすべて保存されている。

| artifact                   | サイズ (bytes) | 主なファイル                                                                                                                                     |
| -------------------------- | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xrift-bridge-macos-arm64` |     43,722,468 | `macos-arm64-XRiftBridge.dmg`（22,256,411）・`stable-macos-arm64-XRiftBridge.app.tar.zst`（21,522,927）・`stable-macos-arm64-update.json`（214） |
| `xrift-bridge-windows-x64` |     71,543,707 | `win-x64-XRiftBridge-Setup.zip`（35,990,945）・`stable-win-x64-XRiftBridge.tar.zst`（35,586,758）・`stable-win-x64-update.json`（202）           |
| `xrift-bridge-linux-x64`   |     73,875,343 | `linux-x64-XRiftBridge-Setup.tar.gz`（37,740,745）・`stable-linux-x64-XRiftBridge.tar.zst`（36,181,708）・`stable-linux-x64-update.json`（205）  |

- Windows の Setup ZIP には `XRift Bridge-Setup.exe` が含まれる。
- Linux の Setup tar.gz には `installer`・`README.txt` が含まれる。
- update JSON は `channel: stable`・`version: 0.0.1`・`platform: macos|win|linux`・`arch: arm64|x64` を持ち、更新用 tar.zst を参照する。

## 観測・注意

- `actions/checkout@v4` と `actions/upload-artifact@v4` について Node.js 20 の deprecation 警告が出た。GitHub 側で Node.js 24 上で実行され、ジョブは成功している。
- macOS arm64 runner の capacity に関する annotation が出たが、job は成功した。
- 包装は未署名・未公証である。

## タグ実行と Release（2026-10-18）

`v0.1.0` タグを push し、`push` イベントで `build` と `release` を実行した。

- タグ: `v0.1.0`（`6b3be81284e3d8d5d18f0d96ecd2d2b7dbfc1cf2`）
- 実行: run `39120391247`
- URL: https://github.com/WebXR-JP/xrift-bridge/actions/runs/39120391247
- Release: https://github.com/WebXR-JP/xrift-bridge/releases/tag/v0.1.0

| job                                   | 結果    |
| ------------------------------------- | ------- |
| `build (macos-14, macos-arm64)`       | success |
| `build (ubuntu-24.04, linux-x64)`     | success |
| `build (windows-latest, windows-x64)` | success |
| `release`                             | success |

`release` ジョブでは Download artifacts、Inspect downloaded artifacts、`gh release create` が成功した。GitHub Release は draft でも prerelease でもなく、次の9件の asset が `uploaded` 状態で添付されている。

| asset                                        | サイズ (bytes) |
| -------------------------------------------- | -------------: |
| `macos-arm64-XRiftBridge.dmg`                |     22,256,391 |
| `stable-macos-arm64-XRiftBridge.app.tar.zst` |     21,522,956 |
| `stable-macos-arm64-update.json`             |            214 |
| `win-x64-XRiftBridge-Setup.zip`              |     35,990,988 |
| `stable-win-x64-XRiftBridge.tar.zst`         |     35,586,793 |
| `stable-win-x64-update.json`                 |            202 |
| `linux-x64-XRiftBridge-Setup.tar.gz`         |     37,740,376 |
| `stable-linux-x64-XRiftBridge.tar.zst`       |     36,181,666 |
| `stable-linux-x64-update.json`               |            205 |

- `release` job には `actions/download-artifact@v4` の Node.js 20 deprecation 警告が出たが成功した。
- release job の runner は `ubuntu-latest` であり、2026-10-19 に Ubuntu 26 へ移行する旨の annotation が出た。現時点では成功している。
- Release 作成時の `contents: write` は job 側の指定で通り、権限エラーは出なかった。
- 署名・公証は未実施である。
