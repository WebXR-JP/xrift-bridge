# XRift Bridge

XRift のワールド内からローカルのブリッジへ接続するためのモノレポ。ワールド内で動くクライアントライブラリ、共有する通信定義、PC 上で動くブリッジサーバー、デスクトップ GUI、CLI、プラグイン、接続診断用のワールドを含む。

v0 台ではプロトコルと公開 API に破壊的変更を加えることがある。異なる版の間の通信は考えず、使うときは版をそろえる。

## 構成

| パッケージ                         | 役割                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/bridge-protocol`         | ワールド内クライアントとブリッジで共有する通信定義                                                |
| `packages/bridge-server`           | PC 上で動くブリッジのサーバーコア。GUI と CLI が使う管理境界                                      |
| `packages/bridge-app-core`         | プラグイン基盤。接続口の適合判定・割当て・失効を担う                                              |
| `packages/world-client`            | ワールド内からブリッジへ接続するためのクライアントライブラリ                                      |
| `packages/bridge-gui-contract`     | GUI の表示 DTO と限定操作の契約                                                                   |
| `packages/bridge-gui-plugin-sdk`   | プラグイン実装者が参照する公開 SDK の契約                                                         |
| `packages/plugins/bridge-plugin-*` | 種別ごとの本体・通信契約・子画面 (`diagnostic` / `text` / `udp`)                                  |
| `apps/bridge-cli`                  | PC 上で動く中継アプリ (CLI)                                                                       |
| `apps/bridge-gui-main`             | デスクトップ GUI (Electrobun)。管理画面の実体は Angular 生成物を取り込む                          |
| `apps/bridge-gui-ui`               | 管理画面の Angular 実装                                                                           |
| `apps/diagnostic-world`            | 接続を診断するワールド (開発検証用)                                                               |
| `apps/website`                     | テンプレート由来の Vite+ サイト。ルートの `pnpm dev` がこれを起動するため、製品の起動には使わない |

子画面は各プラグインで事前ビルドし、GUI が staging (`apps/bridge-gui-main/src/plugin-view-dist/<種別>/`) 経由で取り込む。詳しい設計判断は `design/` を見る。

## 前提

- Node.js >= 22.18.0 (`engines`)、pnpm 12.10.1 (`devEngines`)
- `hutch` 0.27.1（`apps/bridge-gui-main/hutch.config.ts` と各プラグインの `hutch.config.ts` の pin）。`PATH` に要る
- Hutch の導入例。macOS / Linux は `curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh`、Windows は公式 PowerShell インストーラを使う。`~/.hutch/bin`（Windows は `%USERPROFILE%\.hutch\bin`）を PATH に追加する
- GUI の動作確認は macOS (Apple Silicon) のみ。Intel Mac は対象外（Electrobun に macOS x64 提供がないため）。release ワークフローでは Windows / Linux 向けの包装も行うが、実行時の確認はこれからである（`design/bridge-app.md`）

## セットアップと検証

```sh
pnpm install
pnpm --filter bridge-gui-main gui:prepare
pnpm ready
```

クリーンな状態では `gui:prepare` を先に行う。GUI の型検査は app の `.hutch/devkit` にある `electrobun/*` の型へ依存し、プラグインの build も各自の devkit を要求する。devkit が無いと `tsc` が `TS2307` で落ちるため、`gui:prepare` で app とプラグイン一式をまとめて用意する。

`pnpm ready` は build・check・test・test:types のまとめである（`package.json`）。個別には次のものを使う。

```sh
pnpm exec vp run -r build
pnpm exec vp check
pnpm exec vp run -r test
pnpm exec vp run -r test:types
```

## GUI

開発実行は次のものを使う。

```sh
pnpm --filter bridge-gui-main gui:run
pnpm --filter bridge-gui-main gui:run:console
```

`gui:run:console` は AI からの操作・観測用の接続口をつけた起動である。ローカル開発ワールド（`http://localhost:5173`）から接続する場合は、許可 Origin を明示する。

```sh
BRIDGE_GUI_DEV_ORIGINS=http://localhost:5173 pnpm --filter bridge-gui-main gui:run
```

許可 Origin の既定は `https://app.xrift.net` のみである。追加はこの環境変数の明示設定に限る（Windows の PowerShell では `$env:BRIDGE_GUI_DEV_ORIGINS = "http://localhost:5173"` を先に設定する）。

配布用包装は次のものを使う。

```sh
pnpm --filter bridge-gui-main gui:build
```

成果物は `apps/bridge-gui-main/artifacts/` に出る（git 管理外）。macOS は dmg・app の tar.zst・update.json、Windows は Setup exe・tar.zst・update.json、Linux は AppImage・tar.zst・update.json という構成である（Electrobun の命名に従う）。

包装は未署名・未公証の検証用配布物であり、本番向けの品質保証はしない。macOS の Gatekeeper 警告を避ける操作（例: `xattr -cr "apps/bridge-gui-main/build/stable-macos-arm64/XRift Bridge.app"`）は内部テスト用に限る。

`gui:build:dev` など詳しくは `apps/bridge-gui-main/README.md` を見る。

## CLI と診断ワールド

ブリッジを CLI で動かす最小手順は次のとおりである。

```sh
pnpm --filter bridge-cli build
node apps/bridge-cli/dist/index.mjs --dev --origin http://localhost:5173
```

ブリッジ側で `accept enable` により受付を有効にし、ワールドから接続すると比較コードが両画面に出る。`pending` で保留一覧とコードを目視し、`approve <requestId>` で承認する。切断で認可は失効し、再接続は再承認になる。

診断ワールドは次のもので動かす。

```sh
pnpm exec vp run diagnostic-world#dev
```

ブラウザで `http://localhost:5173` を開き、盤面から接続する。`xrift.json` の `permissions.allowedDomains` は `127.0.0.1` のみである。実際の接続先 (数値 IP のループバック) と XRift 側の許可宣言をそろえるためである (`design/bridge-connection.md`)。

## GitHub Actions

- `.github/workflows/ci.yml`: PR・`main` への push・手動実行で、ubuntu 24.04 上で install → Hutch → `gui:prepare` → build → `stage:ui` → check → test → test:types を回す。
- `.github/workflows/release.yml`: `v*` タグまたは手動実行で macOS arm64 / Windows x64 / Linux x64 を native runner で包装する。タグ時は GitHub Release に成果物を添付し、手動実行時は Actions artifacts のみとする。
- 包装は未署名であり、Windows / macOS の署名証明書は未設定である。初回の Windows / Linux 実行は未確認である（workflow 内のコメントに未検証点を残している）。

```sh
git tag v0.1.0
git push origin v0.1.0
```

## ライセンス

MIT。`LICENSE` を見る。

## 関連文書

- [design/bridge-app.md](design/bridge-app.md): GUI とプラグイン基盤の責務
- [design/bridge-connection.md](design/bridge-connection.md): 輸送手段と接続認可
- [design/protocol.md](design/protocol.md): 配送・流れ制御・終了の契約
- [docs/verification/](docs/verification/): 検証記録（[bridge-app.md](docs/verification/bridge-app.md)、[pairing-approval-runbook.md](docs/verification/pairing-approval-runbook.md) など）
- 各パッケージの使い方: [bridge-gui-main](apps/bridge-gui-main/README.md)、[bridge-cli](apps/bridge-cli/README.md)、[diagnostic-world](apps/diagnostic-world/README.md)、[world-client](packages/world-client/README.md)
