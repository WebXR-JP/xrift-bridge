---
name: xrift-world-component
description: XRift のワールド内で使うコンポーネント（操作盤・表示板など）を作るとき、それをワールドへ組み込むときに読む。@xrift/world-components と world-client で、ローカルブリッジへ接続する通信 UI を組む手順と制約をまとめる。
---

# XRift ワールド内で使うコンポーネント

XRift のワールド内でローカルブリッジと通信する UI（操作盤・表示板など）を作り、ワールドへ組み込むための案内である。通信の意味や PC 側 GUI の作り方は扱わない。

全体の見通しだけをここに置き、細部は xrift-bridge リポジトリの次の正本を参照する。パスはリポジトリのルートからの相対であり、https://github.com/WebXR-JP/xrift-bridge 配下の `blob/main/<パス>` に当たる。

- 接続の使い方と公開型: `packages/world-client/README.md`、`packages/world-client/src/session.ts`
- 通信の意味と配送: `design/protocol.md`、`design/bridge-connection.md`
- 実例: `apps/diagnostic-world/`（`src/components/`、`src/diagnostic/`、`src/text/`、`src/udp/`）
- サンプルコンポーネント: `examples/bridge-components/`（接続盤 `BridgeConnectionPanel`・表示板 `BridgeTextBoard` と、結線した `BridgeExample`）
- 守る制約: `apps/diagnostic-world/AGENTS.md` と各ソース先頭の ADR
- 提出と実行環境: `apps/diagnostic-world/vite.config.ts`、`apps/diagnostic-world/xrift.json`

## 前提

- 実行基盤（Canvas・物理エンジン・`XRiftProvider`）は XRift 側が用意する。ワールドはシーンと操作だけを持つ。
- ワールド内の操作と表示には XRift 公開 API（`@xrift/world-components`）を使う。
- ブリッジへの接続は WebSocket 一本。認可はブリッジ側の人間の操作で成立し、以降はその接続上にセッション（一連のやり取り）を開いて通信する。
- 公開 API は 0.x で変わる。使うときは版をそろえる。

## 作り方

### 三つの層に分ける

`apps/diagnostic-world` が採っている形である。同じ形のサンプルが `examples/bridge-components/src/connection/`・`src/text/`・`src/components/` にある。

- UI 非依存のコア: 接続・受信・検証・後片付けを持つ。React・R3F・DOM に依存しない（`src/diagnostic/session.ts`、`src/text/receiver.ts`）。
- React 結合: コアの生成・購読・破棄を effect が所有する（`src/*/use*.ts`）。
- 3D コンポーネント: `Interactable`・`TextInput`・3D メッシュと文字板で操作と表示を作る（`src/components/`）。

コアを React から切り離すと、開発用パネルと in-world の盤で手順を共用できる。生成を描画時に行い破棄だけ effect で行う形は採らない。

### 守ること

詳細は `apps/diagnostic-world/AGENTS.md` と各ソース先頭の ADR を見る。要点は次のとおり。

- 新しい Canvas・物理エンジン・`XRiftProvider` を生成しない。
- ホストの DOM を探したり変えたりしない。文字表示は分離 canvas と `CanvasTexture` で行う（drei `Html` や uikit `Input` はホスト DOM に触れるため使わない）。
- 秘密値や状態を `useInstanceState` で他利用者へ同期しない。比較コードは表示だけに使う。
- 外部フォントの取得を増やさない。

### 通信の形は契約に合わせる

PC 側と形を合わせる部分は、そのプラグインの `contract` subpath（例: `bridge-plugin-text/contract`）を参照する。ブラウザへサーバー実装を引き込まないため、契約は型と純粋関数だけで使う。

### ビルドと提出

- Module Federation で `./World` を公開し、共有依存（react・three・`@xrift/world-components` など）を singleton にする（`vite.config.ts`）。
- 提出宣言は `xrift.json`。`permissions.allowedDomains` に接続先（`127.0.0.1`）を、`allowedCodeRules` に必要な規則を書く。`ignore` に共有依存の分割ファイルを並べる。
- 宛先や規則を増やしたら審査を受け直す（`apps/diagnostic-world/README.md`）。

## 利用方法

### 接続する

`createConnectionRequest` が `{pairingInfo, sessionProvider}` を返す。`pairingInfo` は比較コード（承認時に両画面で見比べる数字6桁）の表示に使い、`sessionProvider` は承認後にセッションを開く管理口である。接続は呼び出した時だけ始まり、自動再接続・自動再送は無い。詳細は `packages/world-client/README.md` を見る。

### セッションを開く

認可後、`sessionProvider.tryCreateSession({sessionId, kind, direction})` でセッションを開く。順序を保つ通信は `reliable`、最新値だけ要る状態は `latest` を選ぶ。使い分けの理由は `design/protocol.md` にある。切断で全セッションが終わり、再接続は再ペアリングになる。

### 承認まで

ブリッジ側で受付を有効にし、ワールドから接続を開始する。両画面に比較コードが出るので、ブリッジ側で承認する。手順は `README.md` と `apps/bridge-cli/README.md` を見る。

## 確認

`apps/diagnostic-world/README.md` の起動・検証手順で確かめる。実ブラウザでの接続確認や審査は別の範囲である。

## これから

- 複数のワールドで配る共有コンポーネントとしてのパッケージ化は未定である。`examples/bridge-components` はその土台として置いたサンプルであり、他ワールドへは実装を写して使う。
