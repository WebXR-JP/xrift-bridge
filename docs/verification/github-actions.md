# GitHub Actions 初回実行記録（2026-10-18 実施）

`release.yml` の `build` ジョブを GitHub 上で `workflow_dispatch` により実行した記録である。タグ実行ではないため `release` ジョブは実行していない。

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
- タグ実行による `release` ジョブ（artifact の集約、`gh release create`、GitHub Release への添付）は未検証である。
