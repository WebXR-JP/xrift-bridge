# ブリッジ検証計画

本番経路と審査で必要な証拠、配送と負荷の試作条件、計測項目、判定後の分岐を決める。

## 実行条件

- 実際の `location.origin`、`isSecureContext`、フレーム構造を記録する。
- ブラウザと OS の正確な版、実行ビルドの識別子を記録する。
- 本番 XRift からの昇格、認証、双方向の応答確認の成功を記録する。
- 実際の宛先に対応する `allowedDomains` とコード規則の宣言、審査結果を記録する。宣言要件の正本は[ブリッジ接続](../../design/bridge.md)である。
- ローカル事前チェック結果（2026-10-10 実施済み）を記録する。`apps/diagnostic-world` を `vp run diagnostic-world#build` でビルド後、同ディレクトリから `npx` 経由の `@xrift/cli` 0.25.0 で `xrift check world` を実行し、`distDir=./dist` の 23 JS ファイルが APPROVE: 23（REVIEW・REJECT なし、exit 0）であった。宣言は `apps/diagnostic-world/xrift.json` の `allowedDomains: ["127.0.0.1"]`・`allowedCodeRules: ["no-network-without-permission"]` である。含まれる通信は `world-client` の `ws://127.0.0.1:<port>/v1` と開発専用の yamux 確認口の `ws://127.0.0.1:5180/spike` であり、dev バンドル（診断パネル・yamux 確認口）同梱でも REJECT にならなかった。これはローカル事前チェックであり、アップロード時のサーバ側審査そのものではない。サーバ側審査は次項に記録する。実ホスト実行時（`app.xrift.net` と同一文書での読み込み・LNA・混合コンテンツ）の確認は未了である。
- 実アップロードとサーバ側審査の観測（2026-10-10 実施済み）を記録する。前項のローカル事前チェックとは区別する。`apps/diagnostic-world` で `xrift upload world`（`@xrift/cli` 0.25.0、ログインユーザー HALBY）を実行し、`buildCommand`（`npm run build`）→ セキュリティチェック（APPROVE）→ アップロードの順で `version: 1` が受理された。World ID は `15cd8424-ac75-48d6-8b97-e7a0777dae2a`（`apps/diagnostic-world/.xrift/world.json` に保存。`.xrift/` は .gitignore 済み）である。記録時点で `status: ACTIVE`・`currentVersionNumber: 1`・`isPublic: false`（非公開のまま）、`worldType: CODE`、`sceneUrl: https://assets.xrift.net/users/9dd894c6-ea1b-42cf-af0b-7574558fcc17/worlds/15cd8424-ac75-48d6-8b97-e7a0777dae2a/25186149a2b8/remoteEntry.js`、`fileSize: 4383116` である。宣言は `allowedDomains: ["127.0.0.1"]`・`allowedCodeRules: ["no-network-without-permission"]` である。サーバ側審査はアップロード後に自動実行され、version 1 が受理され `status ACTIVE` になっている。審査通過と公開（`isPublic`）の関係は観測範囲では「非公開継続」であり断定しない（`isPublic` の意味・切替手段は未確認）。実ホスト実行時の確認（`app.xrift.net` と同一文書での Module Federation 読み込み・LNA・混合コンテンツ・in-world での WebSocket 接続）は[実機手順](pairing-approval-runbook.md)に従い人間が行う。この記録時点では未了である。
- 実測のコンテンツセキュリティポリシー（`connect-src` など）を記録する。これまでの実測値は `connect-src * blob: data:` である。
- ローカル網アクセスの初回許可、拒否、権限取消後の挙動を記録する。
- 不許可 `Origin`、欠落 `Origin`、期限切れ・再利用のペアリング要求の拒否を記録する。要件の正本は[プロトコル](../../design/protocol.md)である。
- 待ち受けが LAN 側に露出していない証拠を残す。
- 対応表は観測結果で作る。対象ブラウザの必須範囲（必須は Google Chrome のみ）の判断は[ブリッジ接続](../../design/bridge.md)を正本とする。
- ブラウザの安全機能を無効化した成功は合格にしない。

## ペアリングの観測手順

確定事項である。手順の確定を指し、結果は検証待ちである。要件の正本は[プロトコル](../../design/protocol.md)と[ブリッジ接続](../../design/bridge.md)である。

- 受付開閉: 起動時は閉じていること、閉じている間の新規要求は upgrade 時に拒否され保留・通知しないこと、`accept open` で開き120秒で自動クローズすること、開いている間の再操作は期限を更新しないこと、手動／自動クローズで開始待ち・承認待ちをすべて終了し認可済みは維持することを記録する。
- 比較コードの照合: ワールド画面とブリッジの `pending` 表示が同じコードを示すこと、先頭ゼロを保持する6文字の文字列として扱い数値化しないこと（例: `000123`）、表示は `123 456` のように3桁区切りであること、承認時に要求 ID とコードの両方を照合することを記録する。
- 承認／拒否: 正しい要求 ID とコードの組だけが承認され `auth_ok{requestId,sessionId,window}` で接続単位に認可されること、コード不一致・書式不正は保留を残して拒否すること、`reject` で保留を取り下げ対象の接続を終了することを記録する（`window` は 0.2 の形状であり、0.3 ではクレジット層ごと削除方向のため実装時に手順を更新する）。
- 期限: 接続から開始メッセージまで10秒、コード発行から承認まで120秒、保留の絶対期限は「コード発行＋120秒」と「受付終了時刻」の早い方であること、開始メッセージは接続につき1回で重複は終了することを記録する。
- 競合: 同一接続の二重開始は延長せず終了すること、二重承認は一度だけ成功すること、承認と受付クローズ・承認と切断が交差した場合は保留を残さず終了することを記録する。
- 上限: 全8・未認可2・保留2の枠組み（未認可は全接続の内数、保留は未認可の内数、認可済みを追い出さない）であること、`Origin` 別5回・全体10回（直近60秒）の受付レート超過は保留せず拒否すること、拒否ごとの通知は出さず `status` に集計することを記録する。
- 認可前データ拒否: 認可前の業務メッセージ（`echo`・`command_request`・`data`）は終端エラーで終了すること、逆方向メッセージも受け付けないことを記録する（0.2 現行の形状であり、0.3 では `data` に一本化方向のため実装時に手順を更新する）。認証前に送受信してよいのはペアリングに限定した制御メッセージ（`pairing_start`・`pairing_pending`・認証前エラー）のみである。
- 再接続で再承認: 切断で認可が失効すること、切断・ワールド切替・ブリッジ再起動後に認可を継承せず再承認が必要であることを記録する。
- 比較コードは画面表示と照合にだけ使い、ログ・URL・永続保存・証拠に含めないことを記録する。

## 実機での人間確認

確定事項である。実機 Chrome とブリッジ CLI で人間が確認すべき範囲である。ローカル網アクセス・審査・対応表の記録は[実行条件](#実行条件)を正本とする。

- ワールド画面の比較コードとブリッジの `pending` 表示の両画面を人間が照合し、ブリッジ側で承認する流れを通す。コード一致だけでの自動認可はしない。
- 承認操作はローカルの CLI（将来は GUI）からのみ行い、ワールド側からの承認は受け付けないことを確認する。

## 配送と負荷の試作条件

確定事項である。試作は本番経路の成立後に行う。結果は検証待ちであり、全組み合わせは不要で代表点から段階的に負荷を上げる。

- センサー周期: 60Hz、120Hz、240Hz、負荷探索として 1000Hz。
- 送達物の大きさ: 64バイト、512バイト、4KiB。いずれも UTF-8 にシリアライズした JSON 全体のバイト数とし、`maxMessageBytes` と同じ尺で測る。
- ストリーム数: 1本、8本、32本。
- センサー、小コマンド、模擬 AI 逐次出力の混在。
- 受信消費の停止、主スレッド停滞、切断、ブリッジ再起動、バックグラウンドタブを含める。
- 周期・ストリーム数の発生方法は未定義である（診断ワールドに生成処理はなく、誰がその周期・本数を出すかは未確定）。大きさ以外の単位も未確認である。これらは UNRESOLVED とし、推測で埋めない。
- 待ち行列容量等の初期暫定値は下表のとおりである。0.2 由来の行と 0.3 の採用値の置き場が混在する。0.3 の行はコード未実装のため採用値をここに置き、コード実装後に正本をコードへ移す。ペアリングの120秒・数字6桁・接続単位・切断失効は確定要件であり、下表の暫定値とは区別する。正本は[プロトコル](../../design/protocol.md)である。
- 0.3 で合意済みの方向として、framing 長ガード残置、監視切断→再承認の許容、Session＝既定 stream 1本を試作条件の前提とする（判断の正本は[プロトコル](../../design/protocol.md)）。

| 項目                                    |                                 暫定値・扱い |
| --------------------------------------- | -------------------------------------------: |
| framing 本体上限（0.3 採用値、UTF-8）   |                                 65,536 bytes |
| yamux inbound／outbound（0.3 採用値）   |                                 各32本／接続 |
| yamux window（0.3 採用値）              |                                       256KiB |
| yamux maxStreamWindowSize（0.3 採用値） |   256KiB（初期 window と同値・自動拡大抑止） |
| keepalive 間隔（0.3 採用値）            |                                    30,000 ms |
| keepalive 応答期限（0.3 採用値）        |                                    60,000 ms |
| 同時 Ping 数（0.3 採用値）              |                                          1件 |
| `maxMessageBytes`（0.2 現行）           |                                 65,536 bytes |
| `maxReliableQueueMessages`              |                           0.3 で廃止（方向） |
| `maxReliableQueueBytes`                 |                           0.3 で廃止（方向） |
| `maxStreamsPerConnection`               |            0.3 の yamux 値に置き換え（方向） |
| `initialCreditWindow`                   |                           0.3 で廃止（方向） |
| `maxConnections`                        |                                            8 |
| `pairingStartTimeoutMs`                 |                                    10,000 ms |
| `pairingApprovalTimeoutMs`              |                                   120,000 ms |
| `acceptanceDurationMs`                  |                                   120,000 ms |
| `maxUnauthorizedConnections`            |                                 2／全8の内数 |
| `maxPendingPairings`                    |                             2／未認可2の内数 |
| `pairingRateWindowMs`                   |                                    60,000 ms |
| `maxPairingRequestsPerOrigin`           |                                5回／直近60秒 |
| `maxPairingRequestsTotal`               |                               10回／直近60秒 |
| `maxPairingCodeGenerationAttempts`      |                                         16回 |
| `connectionCloseGraceMs`                |                                     1,000 ms |
| world-client `requestTimeoutMs`         | 0.2 現行（0.3 では上位層の責務へ見直し対象） |
| world-client `maxPendingReliable`       |                           0.3 で廃止（方向） |
| world-client `maxMessageBytes`          |                                 65,536 bytes |

- 値の正本はコードである。サーバ側の 0.2 現行値は `apps/bridge/src/config.ts` の `DEFAULT_LIMITS` に置き、`BridgeOptions.limits` で上書きする。world-client の 0.2 現行値（`requestTimeoutMs`・`maxPendingReliable`・`maxMessageBytes`）は `packages/world-client/src/client.ts` の既定値に置く。0.3 の採用値（framing・yamux・keepalive）はコード未実装のため暫定的にこの表に置き、実装後に正本をコードへ移す。件数容量 `C`・初期付与の意味論は 0.2 の方式であり、0.3 ではクレジット層ごと削除方向である（[プロトコル](../../design/protocol.md)を参照）。
- yamux 試作で確定した採用版の既定値は次のとおりである。0.3 の採用値（上表）と異なる行は、コード実装時に明示設定が必要である。採用版は `@chainsafe/libp2p-yamux` 8.0.1（tag commit `7dca09b`）である。inbound／outbound 上限の既定は各1000であり、設計の各32へ明示設定する。`maxMessageSize` の既定は 64KiB である。受信 window は RTT 既知で最大 16MiB まで自動拡大するため、上表の `maxStreamWindowSize`（初期 window と同値）の明示設定で抑止する。`send()` は同期の真偽値であり、false は破棄ではなく writeBuffer への滞留を表す。`close()` は FIN 送出前に write queue の idle と drain を待つ。GoAway は mux を閉じるがトランスポートは閉じない。

## 計測項目

確定事項である。結果は検証待ちである。

- 往復時間の p50、p95、p99。
- 最新値の鮮度、置換数、欠番数。
- コマンド完了時間。
- AI 出力の到着間隔。
- 両端の待ち行列のバイト数と件数、`bufferedAmount`、クレジット待ち（クレジット待ちは 0.2 の項目であり、0.3 では yamux window・backpressure 時の Promise 完了点に置き換える）。
- CPU とメモリの推移、長時間タスク、XRift 描画への影響。
- 停滞解消後に古い値が流れ続けないこと。
- 片道時間と鮮度は時計差の推定方法と誤差を併記する。異なるプロセスの `performance.now()` を直接引かない。

## yamux 試作の検証項目（0.3）

確定事項である（試作条件・計測項目・判定後の分岐の 0.3 追加分）。結果は検証待ちである。採用版・commit を固定して行う。

- Ping 監視: 間隔・応答期限・同時 Ping 1件での往復確認、不応答での Connection 終端、終了開始での監視停止・強制終了タイマーの単発動作。
- FIN／RST／GoAway: 方向別 FIN・双方 FIN での Session 終了、RST での即時中断（待機送信・未完成フレーム破棄、他 Session 維持）、GoAway 受信後の Connection 終了。待機中 Promise の拒否（二重決着なし）。
- window／バッファ: yamux window での流れ制御、backpressure 時の `reliable` 送信 Promise の完了点（ローカル送信完了であり相手受信・業務完了ではないこと）。素物の `send()` は同期の真偽値であり false は writeBuffer 滞留のため、`reliable` の `Promise<void>` は `send()`＋`onDrain()`／`writeBufferLength` を包む実装になること。`close()` は FIN 前に idle＋drain を待つこと。受信 window の自動拡大は `maxStreamWindowSize`（初期 window と同値）の明示設定で抑止し、RTT 確知後の 5MiB 送信で拡大しないこと・抑止なしでは拡大することの対照を試作で観測する。
- WS 分割・集約: WebSocket メッセージの分割・集約をまたぐ framing の復元、framing 異常系（超過・破損・途中 FIN）での対象 Session 異常終了、ローカル送信超過の投入前拒否。本体上限は UTF-8 シリアライズのバイト数で測る。分割・集約は復元だけでなく発動自体（書き込み数に対する WS メッセージ数の増減）も試作で数える。
- 認可 JSON→yamux 切替: ペアリング完了→認可→同じ WS 上での mux 開始の境界、別 WS・認可継承の拒否。
- bundle 差分・審査・負荷: yamux 採用版の bundle 差分、XRift 審査の通過、センサー・小コマンド・模擬 AI 逐次出力の混在負荷（[配送と負荷の試作条件](#配送と負荷の試作条件)の周期・大きさ・本数で行う）。
- `latest` 置換: 投入前置換の動作、投入中1件＋未投入最新1件の範囲、値ごとの配送 Promise を作らないことの確認。
- 制御分離なし: 制御専用 stream を作らないこと（Session 間の優先度・分離を設けないこと）の確認。
- 試作の置き場と観測要点: 試作は `tools/yamux-spike/`（experimental、製品コードと分離）に置く。多重化（4本同時 echo の対応保持）、WS 分割（7B 刻みでも復元・送出数で発動を確認）・集約（25ms 窓の5連打が順序保持・送出数で発動を確認）、FIN（片方向終了と逆方向継続、双方 FIN 後も mux 維持）、RST（対象のみ中断・他 stream 継続）、GoAway（相手 mux の終了観測）、window backpressure（初期 window ちょうどで詰まり・pause 中 `onDrain` 不解・resume で解ける・全量到着）、認可プリリュード切替（同じ WS 上での mux 開始・混交なし）を観測する。未確認はブラウザ実機、inactivity timeout 発火、受信 window 自動拡大抑止の実機確認である。詳細は試作の `README.md` を参照する。

## 証拠の残し方

確定事項である。

- 実行条件の節の項目を、版と識別子付きで残す。
- 計測項目の節の値を、条件（周期、大きさ、本数、混在、異常系）とともに残す。
- 成功と失敗のどちらも残し、対応表に反映する。

## 判定後の分岐

確定事項である。

| 判定                       | 分岐先                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 審査と接続の成功           | WebSocket のまま性能計測へ進む                                                                                                                                        |
| ブラウザ固有の失敗         | `localhost` との差を限定確認し対応表を作る。比較時はループバック限定で待ち受けを追加してよい（LAN 側への露出はしない）。必須ブラウザが接続不可なら設計へ再相談する    |
| XRift 審査の不通過         | 正式な許可可否を確認する。検出されない API への置換で審査を迂回しない                                                                                                 |
| 性能不足                   | まず待ち行列、処理、描画の問題を切り分け、輸送手段が原因の場合だけ WebTransport 比較へ進む                                                                            |
| 同一実行基盤を信頼できない | ローカル権限や隔離構造の再設計へ進む                                                                                                                                  |
| yamux 試作の失敗           | Ping／FIN／RST／GoAway／window／framing のいずれの層の問題かを切り分け、採用版・commit を記録して設計へ再相談する。0.2 への復帰はしない（0.3 は破壊的変更として扱う） |

- 設計判断の正本は Design 側である。ループバック限定の待ち受け追加の許可範囲と WebTransport 比較へ進む条件は[ブリッジ接続](../../design/bridge.md)、審査の宣言要件は[ブリッジ接続](../../design/bridge.md)、同一実行基盤の前提は[プロトコル](../../design/protocol.md)を正本とする。

## 区分表

| 区分     | 内容                                                                                                                                                                                                | 参照先                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 確定     | 実行手順、試作条件、計測項目、証拠の残し方、判定後の分岐、yamux 試作の検証項目                                                                                                                      | 本文                                                                                                   |
| 合意済み | 0.3 の方向（yamux on WebSocket・認可後 mux 開始・件数クレジット層削除・`seq` 削除・配送順保証撤去・終了契約・送信 API 契約）、framing 長ガード残置、監視切断→再承認の許容、Session＝既定 stream 1本 | [ブリッジ接続](../../design/bridge.md)と[プロトコル](../../design/protocol.md)に反映済み               |
| 検証待ち | 条件ごとの観測結果、対応表、時計差の誤差評価、yamux 試作の結果                                                                                                                                      | 本文の項目に記録する                                                                                   |
| 合意待ち | 必須対応範囲の将来拡大、ストリームごとの欠落許容、必要鮮度・遅延・負荷範囲、開発モードの許可Originの列挙場所、0.3 採用値のコード正本化                                                              | 観測後に合意し[ブリッジ接続](../../design/bridge.md)と[プロトコル](../../design/protocol.md)に反映する |

- 対象ブラウザの必須範囲（必須は Google Chrome のみ）の判断自体は[ブリッジ接続](../../design/bridge.md)の確定事項であり、この表の「確定」は手順の確定を指す。
