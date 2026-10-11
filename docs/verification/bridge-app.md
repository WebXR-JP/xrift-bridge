# ブリッジアプリ検証計画

アプリ固有の観測項目と判定観点を示す。手順の詳細まで作り込まない。

## 正本分担

- 設計判断の正本は [ブリッジアプリ](../../design/bridge-app.md)、接続認可・切断失効・サーバー管理境界としての公開は [ブリッジ接続](../../design/bridge-connection.md)、輸送・配送・方向・終了の契約は [プロトコル](../../design/protocol.md) とする。
- 形状（型・フィールド名・操作名・定数値）はコードを正本とし、ここでは複製しない。
- 接続の観測手順・試作条件・計測項目は [接続の検証計画](bridge-connection.md) を正本とする。本文書はアプリ固有の観測だけを扱う。

## セッション公開の観測

- 未認可セッションが公開されないこと。
- 一覧と通知の整合（購読から一覧取得での初期同期、重複除去、終了通知の一度きり）。
- 同名セッションの再作成（終了後の同名を古い割当てと混同しないこと）。
- 別接続での同名（表示・関連付け情報としてのみ扱うこと）。
- 対象接続の切断時の即時失効（終了開始で全セッションを失効させること）。

## 割当ての観測

- capability 不一致の割当てを拒否すること。
- 二重割当て（同一セッション・同一接続口への重複）を拒否すること。
- 解除後の操作拒否（解除後の送信・購読を禁止すること）。
- プラグイン削除で対象セッションを中断すること。
- 未割当ての `reliable` セッションへの到着で理由付き中断すること。

## 診断の観測

- 同梱診断プラグイン経由の echo・ping 往復が成立すること。
- 輸送統計から診断項目が除かれ、keepalive Ping と区別できること。

## 統合の観測

- 実 GUI から実ワールドへのテキスト表示が往復すること。
- 切断後の送信が不可になること。
- 再接続後に再承認が必要になること。

## 基盤の観測

- Electrobun 上での既存 `ws`・yamux の動作。
- 画面との通信用 RPC の往復。
- 埋込み UI の表示。
- 終了処理（起動・終了、切断時の失効を含む）。
- パッケージ化の可否。
- 配布サイズ・常駐メモリを記録する。軽量性が採用理由であるためである。

## 証拠の残し方

- 項目ごとの合否と判定観点を、版と識別子付きで残す。
- 成功と失敗のどちらも残す。
- 設計判断の変更が必要になった場合は観測で補完せず、設計へ戻す。

## Electrobun スパイクの記録（段5〜6・2026-10-11 実施済み）

段0-2（開発実行での RPC 往復・実結線・冪等終了。`apps/bridge-gui/README.md` に記録）に続く、
stable 配布物の確認（段5）と初期計測（段6）の結果である。計画節・MVP第1段の記録は書き換えない。
比較コード本文・業務 payload は残さない（以下は版・寸法・時刻・改訂番号のみ）。

- 環境・対象: ローカル macOS 26.7.1（Build 25G241）Apple Silicon（Apple M5）。
  対象コミット `6e3741c`（生成時は `git status --short` が空）。
  Electrobun 2.0.2／Hutch 0.27.1（`hutch --version` で確認）／
  Bun 1.4.0（Hutch 同梱 toolchain。`~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun --version` で確認。
  `~/.bun/bin/bun` 1.3.14 は使わない）／Cottontail 0.7.1（pragma のみ・段5以降の実行には使わない）／
  pnpm 12.10.1／Node v22.22.3。測定は同一マシン・同一 Webview（native WKWebView）・
  同一バックエンドの条件で行った。Cottontail との比較測定は行わない
  （Cottontail は RPC 不成立で使用可能化に未到達のため比較不能。段6節に記録）。
- GUI 条件: SSH 経由の操作であり、当該セッションに窓は開かない（WindowServer 自体は稼働）。
  System Events から当該プロセスは不可視で、`screencapture` は使えない。
  目視が要る確認は人間確認待ちに分け、環境不備を製品不適合と混同しない。

### 段5: stable 配布物の確認

- 生成: `pnpm --filter bridge-gui gui:build`（`hutch` 経由、`--env=stable`）で生成した。
  注意として `hutch` は `PATH` に無く `~/.hutch/bin` を足す必要があった（手順は README に残す）。
  包装時に `macOS icon source not found: .../icon.iconset` の警告が出る（icon 未用意。動作には影響なし）。
- 成果物（2026-10-11 09:41 生成）:
  - `apps/bridge-gui/artifacts/macos-arm64-XRiftBridge.dmg`: 21296346 B（20800 KiB）。
    sha256 `3ae535b70538922454973c4efee63b355051b6ecb6ee2b27cf2551d47b6c5a92`
  - `apps/bridge-gui/artifacts/stable-macos-arm64-XRiftBridge.app.tar.zst`: 20572275 B（20092 KiB）。
    sha256 `bb73d6c09cd7e420071509f1edfa3986bd8c1a7e4f4b40635267c63dc5d1ba18`
  - `apps/bridge-gui/artifacts/stable-macos-arm64-update.json`: 213 B。
    内容は channel `stable`・version `0.0.1`・hash `qu1nngpidtpo`。
    sha256 `3f8144eb783bc0533919c5ad3de21026f414c630890a4cfd99e88260ad9741e4`
  - `build/stable-macos-arm64/XRift Bridge.app`: ビルド直後は launcher＋tar.zst のみ（du 約 20M）。
    初回実行で自己展開し du 68436 KiB（66.8 MiB）になる。
    初回実行は `~/Library/Application Support/net.xrift.bridge-gui/stable/` に
    self-extraction（`qu1nngpidtpo.tar` 82304 KiB を含む全体 83068 KiB）と uninstall を作る。
    終了後も残る。`~/Library/Caches` への追加は無い。
- 配布物からの起動: 展開済み `.app` の launcher を直接実行し、以下を main 側記録で確認した
  （stable は Webview console 転送が無いため、画面側の受信・採用記録は開発版の代理確認で補う。
  生ログの例は `apps/bridge-gui/records/seg5-packaged-t1.log`。当該ログは `*.log` 無視のため
  リポジトリに含まれず、ローカル参照である）。
  - backend が `3100` で待受けする（`nc` で確認）。
  - `Webview が遷移した: views://mainview/index.html` → `Webview の文書を読み込んだ`（dom-ready）。
  - `表示状態の要求を受信した: count=1`（`getSnapshot` の main 到達）。
  - `画面通知を受信した: viewReady` → `管理画面の準備ができた`（`viewReady` の main 到達と処理）。
  - mainview のコード順序（`src/mainview/index.ts`）は `getSnapshot` 応答の `await`・採用の後に
    `viewReady` 送信である。開発版では画面側の `状態を更新した: via=getSnapshot revision=1` まで
    記録し、往復の成立を確認した（例は `records/seg6-dev-boot-t1.log`）。
- 承認・診断 echo/ping の配布物経路: 未確認。保留の承認操作に GUI が要り、本環境に窓が無いためである。
  backend 直結の統合検証（`tests/backend.test.ts`。実 WS・既存 `ws`・yamux）は緑であり、
  配布物と同一の `GuiBackend` を駆動している。手順は README に残し、人間確認待ちとする。
- 終了: 実 launcher プロセスへの SIGTERM で、後始末記録（`終了要求を受け付け`＋`shutdown`）・
  `3100` 解放・アプリ固有プロセスの残存なしを確認した（計測の全試行で毎回）。
  注意として launcher は起動直後に再実行して init 配下へ移る場合があり、起動シェルの `$!` が
  古くなる。終了確認ではアプリパスで実プロセスを特定すること（初回の計測手順がこの罠を踏み、修正した）。
- 目視（描画内容・操作フロー）・閉窓経路の終了は人間確認待ちとする。

### 段6: 初期計測（Bun main）

合否用の MB 上限は新設しない。以下は絶対値・条件・単位の記録である。
待機時とは実 server 結線後（backend が `3100` 待受け）・セッションなしの状態を指す。
Webview は起動するが窓は無い条件であり、可視時の値は未確認として分ける。

- サイズ: 圧縮配布（dmg 21296346 B＝20.31 MiB／tar.zst 20572275 B＝19.62 MiB／update.json 213 B）と
  実行時占有（展開後 `.app` 68436 KiB＝66.8 MiB＋`Application Support` 83068 KiB＝81.1 MiB。
  うち self-extraction `.tar` 82304 KiB＝80.4 MiB）を分けて記録した。
  参考として開発版 `.app` は 68436 KiB で stable 展開後と同一である。
- メモリ: 起動後30秒待ち、続く60秒間を1秒間隔で採取。独立起動3回。
  RSS を共通指標とし、`footprint` の physical footprint を併記する。
  RSS 合計は共有重複を含む参考値として扱う（下表の「合計（参考）」）。
  生系列は `records/seg5-mem-series.log`、footprint 全文は `records/seg5-mem-footprints.log`
  （いずれも `*.log` 無視のためリポジトリに含まれないローカル参照）。

  | 試行 | 条件                | launcher RSS（中央値）                 | bun main RSS（中央値／最大値／最小値、n=60） | bun phys（前／後、peak）   |
  | ---- | ------------------- | -------------------------------------- | -------------------------------------------- | -------------------------- |
  | run1 | 初回展開・/tmp 複写 | 参考外（旧手順の帰属不確かな値のため） | 137792 KB／138528 KB／135232 KB              | 43 MB／42 MB（peak 45 MB） |
  | run2 | 以後・build 成果物  | 1552 KB（一定）                        | 143456 KB／144240 KB／141296 KB              | 43 MB／43 MB（peak 45 MB） |
  | run3 | 以後・build 成果物  | 1536 KB（一定）                        | 143664 KB／144416 KB／141136 KB              | 43 MB／43 MB（peak 45 MB） |

  launcher の phys は run2 で 1072 KB・run3 で 1056 KB（peak 同値）だった。
  run2 時点の合計（参考）: 1552＋143456＝145008 KB。

- Webview プロセス: 起動前後の `com.apple.WebKit.WebContent` の PID 差分で1プロセスの出現を確認した
  （帰属は時刻一致による推定。別試行で RSS 40864 KB、phys 33 MB・peak 45 MB。
  同試行で main 側に `viewReady` 到達あり）。
  Networking プロセスの新規出現は無かった（既存共有または未生成。帰属不明として扱う）。
  上記と合わせた合計（参考）: 約 1552＋143456＋40864＝185872 KB。
- 起動: 配布物の起動開始→`dom-ready`、起動開始→初回 snapshot 採用・描画完了を別計測する。
  stable の Webview console 転送が無いため、stable 側は main 側到達記録
  （`dom-ready`／`getSnapshot` 到達／`viewReady` 到達）を測り、snapshot 採用の直接確認は
  開発版（同一 Bun main・同一 backend・同一 Webview。console 転送あり）を代理とした。
  初回展開を含む初回1回と以後5回を分けた。

  | 試行         | 条件・指標                                                  | 結果                                                      |
  | ------------ | ----------------------------------------------------------- | --------------------------------------------------------- |
  | 初回1回      | stable・dmg 由来の純粋複写・起動開始→3100 待受（port poll） | 2.62 s                                                    |
  | 初回1回      | 同上・展開ログの内訳（別試行の参考）                        | decompress 約 1.09 s＋untar 約 0.06 s                     |
  | 以後5回      | stable・起動開始→dom-ready（main 側記録）                   | 0.358／0.307／0.329／0.335／0.310 s                       |
  | 以後5回      | stable・起動開始→getSnapshot 到達                           | 0.369／0.319／0.347／0.363／0.326 s                       |
  | 以後5回      | stable・起動開始→viewReady 到達                             | 0.386／0.336／0.364／0.380／0.343 s                       |
  | 以後5回＋2回 | stable・起動開始→3100 待受（port poll）                     | 0.068／0.076／0.072／0.073／0.069 s および 0.128／0.068 s |
  | 以後5回      | 開発版・起動開始→dom-ready                                  | 1.216／1.126／1.112／1.131／1.120 s                       |
  | 以後5回      | 開発版・起動開始→初回 snapshot 採用（画面側記録）           | 1.232／1.143／1.126／1.145／1.146 s                       |

  開発版が stable より遅いのは dev channel・console 転送等の条件差であり、
  版をまたぐ比較には使わないこと。

- Cottontail 参考: 省略した。Cottontail は RPC 不成立のため使用可能になるまでの時間は未到達であり、
  タイムアウト時間を起動時間にしない。別版の挙動は未確認である。
  メモリの「表示のみ・RPC 不成立」の参考値も費用対効果で測らず、正常稼働する Bun の値と混ぜない。
- 診断往復時のメモリ: 未計測。診断割当てに至る承認操作が GUI を要し、本環境に窓が無いためである。
- 再検証: `vp run -r build`（11/11）・`vp test`（33 ファイル・299 合格）・
  `vp check`（0 errors。29 warnings は本変更と非交差の既存警告）の緑を確認した。

### 観測・解釈・未確認の整理（段0-2 および段5-6）

- 観測: Cottontail 0.7.1 では Webview→main の RPC request が main に届かない
  （無改変の公式 notes-app でも再現）。Bun main では開発実行・stable 配布物のいずれでも
  `getSnapshot`／`viewReady` の往復が main 側記録で成立し、開発版では画面側の採用記録まで確認した。
- 解釈: 当該組合せ（Cottontail 0.7.1 × 本構成）依存の不成立を強く示唆する。
  Bun main への切替えで往復が成立することは複数試行で再現した。
- 未確認: 人間環境での GUI 目視（描画内容・操作フロー）・閉窓経路の終了・
  配布物からの承認と診断 echo/ping 操作・Cottontail の別版挙動・
  可視 Webview 条件下でのメモリと起動時間。
  Bun main の採用確定は人間の GUI 確認と計測の後とする（設計 `design/bridge-app.md` は変更しない）。

### 人間の判断に必要な材料

| 項目                       | 値・結果                                                            | 条件・単位                                                    |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| 配布サイズ（圧縮）         | dmg 20.31 MiB／tar.zst 19.62 MiB                                    | 実バイト数。dmg・tar.zst・update.json の sha256 は段5節に記録 |
| 実行時占有                 | .app 66.8 MiB＋AppSupport 81.1 MiB（終了後も残る）                  | `du`。Caches 追加なし                                         |
| 待機時メモリ（RSS 中央値） | bun main 約 140 MB／launcher 約 1.5 MB／WebContent 約 40 MB         | SSH・窓なし・セッションなし。合計は共有重複を含む参考値       |
| 待機時メモリ（phys）       | bun 43 MB（peak 45）／launcher 約 1 MB／WebContent 33 MB（peak 45） | `footprint`。同条件                                           |
| 起動（以後）               | dom-ready 0.31〜0.36 s・viewReady 到達 0.34〜0.39 s                 | stable 配布物・main 側記録・n=5                               |
| 起動（初回展開含む）       | 待受まで 2.62 s                                                     | stable・n=1                                                   |
| 機能ゲート                 | RPC 往復（配布物・main 側）成立。承認・診断の配布物経路は未確認     | 目視・閉窓も未確認                                            |
| Cottontail との増分        | 比較不能（Cottontail は RPC 不成立で使用可能化に未到達）            | 混ぜないこと                                                  |

## GUI 自動検証（2B: 承認・診断の往復）

段5〜6の人間確認待ちのうち、承認から診断割当てまでの往復を自動操作で確認した結果である。計画節・段5〜6節・MVP第1段の記録は書き換えない。比較コード本文・業務ペイロードは残さない（以下はダミー値のみ）。

- 環境・対象: ローカル macOS Apple Silicon、実施日 2026-10-11、対象コミット `a1ea5a8`。Electrobun 2.0.2／Bun main の開発実行である。
- 方法: 画面操作は合成クリック（cliclick）と画面撮影（screencapture）、判定はアプリの記録で行った。ワールド側はビルド済み `world-client` を Node で駆動し、`origin` に `https://app.xrift.net` を指定した。画面の窓は (0,33)・960x832 に配置した。
- 流れと結果: 画面で受付を開く（`acceptance_opened`）→ ワールド接続で保留を発行する（`pairing_pending`。要求識別子と照合符号はダミー記載）→ 画面の保留行に照合符号を入力して承認する（`pairing_approved`／承認の結果 `status=APPROVED`）→ ワールド側で `AUTHORIZED` と専用セッション（論理名 `diag-1`）を生成する → 画面で診断を割り当てる（`localSessionId=session-2`・`instanceId=instance-1`）→ ワールドから `{op:"ping"}` を送り `{op:"pong"}` を受けた（PONG）。
- 観測: ワールド駆動側は応答受信後に終了するため接続が切れ、最終表示は接続0・セッション0である。切断は想定どおりであり、再接続には再承認が要る。割当て表示は実体1・割当て0で残った。試作の `assignDiagnostics` はセッション終了時に個体を回収しておらず、固定文側は回収済みである。
- 未確認・対象外: 実ホスト・実閲覧器での目視、可視窓条件での記憶域の再測定、文面送信用画面の往復は扱わない（続く段で対応）。
- 操作環境の備考: 合成クリックと画面収録には、起動元バイナリへの macOS のアクセシビリティと画面収録の許可が要った。`hutch electrobun run` 単体は既存の開発束を使い回すため、源泉変更後は開発ビルド（`gui:run` か `gui:build:dev`）が要る。

## MVP第1段の実施結果（2026-10-11 実施済み）

MVP第1段（セッション公開＋診断移設）の実施結果を記録する。上記の計画節は書き換えない。設計判断の追加・変更はしない。比較コード本文・業務 payload は残さない（以下はダミー値のみ）。

- 環境・対象: ローカル macOS Apple Silicon、対象コミット `a0faaa6`。
- ビルド: `vp run -r build` 成功。
- テスト・型検査: `vp test`（ルート）で 291 合格／31 ファイル。`vp run -r test:types` で 4 パッケージ成功。
- 統合スモーク（3/3 回・各 15 項目 PASS）: ビルド済み `apps/bridge-cli` を実プロセス起動 × `packages/world-client` を Node の `origin` 指定で実行し、実 WebSocket・yamux で往復した。流れは `accept open` → ワールド起点 `pairing_start` → 比較コード受信 → CLI 標準入力で `approve <requestId> <code>` → `auth_ok` → reliable Session 生成 → `{op:"echo"}` の同形返送と `{op:"ping"}` → `{op:"pong"}` → CLI `status` に `diagnosticEcho`・`diagnosticPing` が反映 → 切断で認可済み接続が消える → 再接続で新しい要求 ID・新しい比較コードと再承認が必要（承認前に `sessionProvider` は未解決＝認可を継承しない）。
- 応答の出所: echo／ping 応答を生成するのは `packages/bridge-app-core/src/plugins/diagnostic.ts` のみであり、`packages/bridge-server/src` に診断参照は無い（`diagnostic-handler.ts` は削除済み）。`status` の診断項目は `server.getStats()` ではなく CLI の `startDiagnostics()` 由来である。
- 契約の実測: `getStats()` のキーから診断項目が消えていること、reliable Session にサーバ側の既定応答が無いこと、認可前・切替中はセッションが公開されないこと、session 終了で一覧・取得から外れ終了通知が一度だけであることを確認した。
- 制限・未再現（失敗側の記録）: `packages/bridge-server/tests/server.test.ts` の「受付の自動クローズでも開始待ちは失効する」（実タイマー系）が負荷時に間欠失敗するとの報告があったが、41 回の再現試行で未再現であり、本変更の経路（セッション公開・診断・管理購読）と非交差と確認した。解消の主張はしない。
- 未計測（第1段の対象外）: `apps/bridge-gui`（Electrobun）そのもの、実 GUI→実ワールドの往復、native↔webview の RPC、埋込み UI、パッケージング／配布サイズ・常駐メモリは未計測である。`design/bridge-app.md`「基盤の観測」の該当項目は未計測である。
