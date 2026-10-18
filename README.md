# XRift Bridge

XRift のワールドとローカル PC をつなぐブリッジ。デスクトップ GUI アプリと、ワールド側で使うクライアントライブラリ・サンプルコンポーネントから成る。

v0 台ではプロトコルと公開 API に破壊的変更を加えることがある。使うときは版をそろえる。

## 入手と起動

配布物は GitHub Releases から入手する（https://github.com/WebXR-JP/xrift-bridge/releases）。

- macOS (Apple Silicon): `macos-arm64-XRiftBridge.dmg` を開いてアプリを Applications などへ移す。未署名のため初回起動が Gatekeeper に止められることがある。その場合は「システム設定 > プライバシーとセキュリティ」から開く。
- Windows: `win-x64-XRiftBridge-Setup.zip` を展開し、中の `XRift Bridge-Setup.exe` を実行する。
- Linux: `linux-x64-XRiftBridge-Setup.tar.gz` を展開し、中の installer を実行する。

実行時の確認は macOS (Apple Silicon) のみ行っている。Windows / Linux は包装のみで、実行時の確認はこれからである。

包装は未署名・未公証の検証用であり、本番向けの品質保証はしない。

起動すると管理画面が立ち上がり、ローカル（既定 `127.0.0.1:3100`）で待ち受ける。

## 使い方

受付を有効化し、ワールド側で接続を開始すると、両方の画面に数字6桁の比較コードが出る。目視で照合し、保留一覧から対象を選んで承認する。

承認後、接続へプラグインを割り当てて使う（診断、テキスト、UDP など種別ごと）。

切断で認可は失効し、再接続は再承認になる。

## ワールドコンポーネントを作る

ワールド内でブリッジと話す操作盤・表示板などの作り方である。作り方と制約の正本は [`skills/xrift-world-component/SKILL.md`](skills/xrift-world-component/SKILL.md)、接続の使い方と公開型の正本は [`packages/world-client/README.md`](packages/world-client/README.md) とし、実例は [`examples/bridge-components`](examples/bridge-components/README.md) に置く。要点だけここに置く。

前提として、実行基盤（Canvas・物理・`XRiftProvider`）は XRift 側が用意する。操作・表示には `@xrift/world-components` を使う。ブリッジへの接続は WebSocket 一本で、認可はブリッジ側の人間の操作で成立する。公開 API は 0.x で変わるので、使うときは版をそろえる。

作るときは三つの層に分ける。UI 非依存のコア（接続・受信・後片付け）、React 結合（生成・購読・破棄を effect が所有する）、3D コンポーネント（操作と表示）である。

守ることとして、新しい Canvas・物理・`XRiftProvider` を生成しない。ホスト DOM に触れない。比較コードは表示だけに使う。外部フォント取得を増やさない。

## 開発

開発者向けの手順・構成・配布は [DEVELOPMENT.md](DEVELOPMENT.md) を見る。

## ライセンス

MIT。`LICENSE` を見る。
