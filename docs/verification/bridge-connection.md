# ブリッジ検証計画

本番経路と審査で必要な証拠、配送と負荷の試作条件、計測項目、判定後の分岐を決める。

## 実行条件

- 実際の `location.origin`、`isSecureContext`、フレーム構造を記録する。
- ブラウザと OS の正確な版、実行ビルドの識別子を記録する。
- 本番 XRift からの昇格、認証、双方向の応答確認の成功を記録する。
- 実際の宛先に対応する `allowedDomains` とコード規則の宣言、審査結果を記録する。宣言要件の正本は[ブリッジ接続](../../design/bridge-connection.md)である。
- ローカル事前チェック結果（2026-10-10 実施済み）を記録する。`apps/diagnostic-world` を `vp run diagnostic-world#build` でビルド後、同ディレクトリから `npx` 経由の `@xrift/cli` 0.25.0 で `xrift check world` を実行し、`distDir=./dist` の 23 JS ファイルが APPROVE: 23（REVIEW・REJECT なし、exit 0）であった。宣言は `apps/diagnostic-world/xrift.json` の `allowedDomains: ["127.0.0.1"]`・`allowedCodeRules: ["no-network-without-permission"]` である。含まれる通信は `world-client` の `ws://127.0.0.1:<port>/v1` と開発専用の yamux 確認口の `ws://127.0.0.1:5180/spike` であり、dev バンドル（診断パネル・yamux 確認口）同梱でも REJECT にならなかった。これはローカル事前チェックであり、アップロード時のサーバ側審査そのものではない。サーバ側審査は次項に記録する。実ホスト実行時（`app.xrift.net` と同一文書での読み込み・LNA・混合コンテンツ）の確認は未了である。
- 実アップロードとサーバ側審査の観測（2026-10-10 実施済み）を記録する。前項のローカル事前チェックとは区別する。`apps/diagnostic-world` で `xrift upload world`（`@xrift/cli` 0.25.0、ログインユーザー HALBY）を実行し、`buildCommand`（`npm run build`）→ セキュリティチェック（APPROVE）→ アップロードの順で `version: 1` が受理された。World ID は `15cd8424-ac75-48d6-8b97-e7a0777dae2a`（`apps/diagnostic-world/.xrift/world.json` に保存。`.xrift/` は .gitignore 済み）である。記録時点で `status: ACTIVE`・`currentVersionNumber: 1`・`isPublic: false`（非公開のまま）、`worldType: CODE`、`sceneUrl: https://assets.xrift.net/users/9dd894c6-ea1b-42cf-af0b-7574558fcc17/worlds/15cd8424-ac75-48d6-8b97-e7a0777dae2a/25186149a2b8/remoteEntry.js`、`fileSize: 4383116` である。宣言は `allowedDomains: ["127.0.0.1"]`・`allowedCodeRules: ["no-network-without-permission"]` である。サーバ側審査はアップロード後に自動実行され、version 1 が受理され `status ACTIVE` になっている。審査通過と公開（`isPublic`）の関係は観測範囲では「非公開継続」であり断定しない（`isPublic` の意味・切替手段は未確認）。この記録は 0.2 系の実装時点のものであり履歴として残す。0.3 の実装を再アップロードしてのサーバ側審査・実ホスト実行時の確認は次項以降に記録する。
- 0.3 の実装完了とローカル事前検証（2026-10-10 実施済み）を記録する。`7f084dd`・`0660042`・`b7db41e`・`6063eb7` でコミット済みであり、`pnpm run ready` 相当で全 248 テスト通過・`vp check` 0 errors・全 build 成功である。内訳は bridge-protocol・world-client・bridge・diagnostic-world・tools/yamux-spike である。各パッケージのテストでは framing 境界（65,536／65,537）、window 自動拡大抑止（`maxStreamWindowSize`）、上限 32、keepalive 期限、終了契約等を確認している。
- 製品経路のローカル検証（2026-10-10 実施済み）を記録する。実ブラウザ（XRift 診断ワールド dev、`http://localhost:5173`）で製品経路を通し、比較コード承認→`auth_ok`→同一 WebSocket 上で yamux mux→診断 Session の echo 一致（op=1、104 bytes、10ms）・ping pong（op=2、7ms）を確認した。コンソールは無関係の PointerLock 警告のみであった。比較コードの目視照合は自動承認ハーネスで省略した（スモーク用）。人間の目視照合は[実機手順](pairing-approval-runbook.md)の実機手順で行う。Node 製品 E2E（`packages/bridge-server/tests/e2e.test.ts`）では実 `createBridgeServer` × 実 `world-client`（Node 22 の global WebSocket）で、ペアリング→認可→同一 WS で mux→reliable 双方向 echo→latest の latestMailbox 反映→FIN／RST／接続終了→再接続再承認→管理切断を通す。
- 0.3 の再アップロードとサーバ側審査の観測（2026-10-10 実施済み）を記録する。前項の 0.2 系 version 1 の記録は履歴として残し、読み替えない。0.3 を version 2 として `xrift upload world` で再アップロードし、セキュリティチェック APPROVE で受理された。記録後の再確認でサーバ側審査は通過し、`status: ACTIVE`・`currentVersionNumber: 2`・`isPublic: false`（非公開のまま）となり、`sceneUrl` の内容ハッシュは `c5847ad2a83f`、`fileSize: 4442473` になった。当初、実ホスト実行時の確認（同一文書読み込み・LNA・混合コンテンツ・in-world WS 接続）は未了であり、[実機手順](pairing-approval-runbook.md)に従い人間が行うとした。次項に実ホスト観測を記録する。
- 実ホスト（XRift 本番）での接続・認可・到達性の観測（2026-10-10 実施済み）を記録する。環境は通常の Google Chrome（利用者自身の端末）、XRift 本番 `https://app.xrift.net`、ログインユーザー HALBY。対象は診断ワールド World ID `15cd8424-ac75-48d6-8b97-e7a0777dae2a` の version 2（0.3 実装）であり、`app.xrift.net` と同一文書に Module Federation で読み込まれた。ワールド（Origin `https://app.xrift.net`）から `ws://127.0.0.1:3100`（loopback）へ WebSocket 接続成功（CSP `connect-src`・LNA ともに許容・ブロックなし）。`pairing_start`→比較コード発行→承認→`auth_ok`→同一 WebSocket 上で yamux 開始（認可）。ブリッジ側で `connection_accepted`（origin https://app.xrift.net）→`pairing_pending`→`pairing_approved` を確認。盤の echo 往復が「一致」・ping が「pong」（利用者の目視）であり、ブリッジ側でも `diagnosticEcho=1`・`diagnosticPing=1` を観測（Session 上の `data` 往復が成立）。この確認の承認は検証用ハーネスによる自動承認であり、人間が比較コードを目視照合して CLI で `approve` する正式手順は、この実行では行っていない。比較コード本文・業務 payload は残さない。実ホストで観測した不具合として、ワールド読み込み時に `assets.xrift.net` の外部 CSS がホストの CSP `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'` によりブロックされたことを残す。詳細な実施範囲と未実施手順は[実機手順](pairing-approval-runbook.md)の 2026-10-10 実ホスト観測を参照する。
- 実測のコンテンツセキュリティポリシー（`connect-src` など）を記録する。これまでの実測値は `connect-src * blob: data:` である。
- ローカル網アクセスの初回許可、拒否、権限取消後の挙動を記録する。
- 不許可 `Origin`、欠落 `Origin`、期限切れ・再利用のペアリング要求の拒否を記録する。要件の正本は[プロトコル](../../design/protocol.md)である。
- 待ち受けが LAN 側に露出していない証拠を残す。
- 対応表は観測結果で作る。対象ブラウザの必須範囲（必須は Google Chrome のみ）の判断は[ブリッジ接続](../../design/bridge-connection.md)を正本とする。
- ブラウザの安全機能を無効化した成功は合格にしない。

## ペアリングの観測手順

確定事項である。手順の確定を指し、結果は検証待ちである。要件の正本は[プロトコル](../../design/protocol.md)と[ブリッジ接続](../../design/bridge-connection.md)である。

- 受付開閉: 起動時は閉じていること、閉じている間の新規要求は upgrade 時に拒否され保留・通知しないこと、`accept open` で開き120秒で自動クローズすること、開いている間の再操作は期限を更新しないこと、手動／自動クローズで開始待ち・承認待ちをすべて終了し認可済みは維持することを記録する。
- 比較コードの照合: ワールド画面とブリッジの `pending` 表示が同じコードを示すこと、先頭ゼロを保持する6文字の文字列として扱い数値化しないこと（例: `000123`）、表示は `123 456` のように3桁区切りであること、承認時に要求 ID とコードの両方を照合することを記録する。
- 承認／拒否: 正しい要求 ID とコードの組だけが承認され `auth_ok{requestId,connectionId}` で接続単位に認可されること、コード不一致・書式不正は保留を残して拒否すること、`reject` で保留を取り下げ対象の接続を終了することを記録する。
- 期限: 接続から開始メッセージまで10秒、コード発行から承認まで120秒、保留の絶対期限は「コード発行＋120秒」と「受付終了時刻」の早い方であること、開始メッセージは接続につき1回で重複は終了することを記録する。
- 競合: 同一接続の二重開始は延長せず終了すること、二重承認は一度だけ成功すること、承認と受付クローズ・承認と切断が交差した場合は保留を残さず終了することを記録する。
- 上限: 全8・未認可2・保留2の枠組み（未認可は全接続の内数、保留は未認可の内数、認可済みを追い出さない）であること、`Origin` 別5回・全体10回（直近60秒）の受付レート超過は保留せず拒否すること、拒否ごとの通知は出さず `status` に集計することを記録する。
- 認可前データ拒否: 認可前の業務メッセージ（`create_session`・`data`）は終端エラーで終了すること、逆方向メッセージも受け付けないことを記録する。認証前に送受信してよいのはペアリングに限定した制御メッセージ（`pairing_start`・`pairing_pending`・認証前エラー）のみである。
- 再接続で再承認: 切断で認可が失効すること、切断・ワールド切替・ブリッジ再起動後に認可を継承せず再承認が必要であることを記録する。
- 比較コードは画面表示と照合にだけ使い、ログ・URL・永続保存・証拠に含めないことを記録する。

## 実機での人間確認

確定事項である。実機 Chrome とブリッジ CLI で人間が確認すべき範囲である。ローカル網アクセス・審査・対応表の記録は[実行条件](#実行条件)を正本とする。

- ワールド画面の比較コードとブリッジの `pending` 表示の両画面を人間が照合し、ブリッジ側で承認する流れを通す。コード一致だけでの自動認可はしない。
- 承認操作はローカルの CLI（将来は GUI）からのみ行い、ワールド側からの承認は受け付けないことを確認する。

## 配送と負荷の試作条件

確定事項である。試作は本番経路の成立後に行う。結果は検証待ちであり、全組み合わせは不要で代表点から段階的に負荷を上げる。

- センサー周期: 60Hz、120Hz、240Hz、負荷探索として 1000Hz。
- 送達物の大きさ: 64バイト、512バイト、4KiB。いずれも UTF-8 にシリアライズした JSON 全体のバイト数とし、framing 本体上限（`FRAME_MAX_BYTES`）と同じ尺で測る。
- ストリーム数: 1本、8本、32本。
- センサー、小コマンド、模擬 AI 逐次出力の混在。
- 受信消費の停止、主スレッド停滞、切断、ブリッジ再起動、バックグラウンドタブを含める。
- 周期・ストリーム数の発生方法は未定義である（診断ワールドに生成処理はなく、誰がその周期・本数を出すかは未確定）。大きさ以外の単位も未確認である。これらは UNRESOLVED とし、推測で埋めない。
- 待ち行列容量等の値は下表のとおりである。0.3 の採用値はコードを正本とし、この表は参照用に置く（値は複製せず、正本への参照に留める）。0.2 由来の行は撤去済みとして扱い、履歴の意味でのみ残す。ペアリングの120秒・数字6桁・接続単位・切断失効は確定要件であり、下表の値とは区別する。正本は[プロトコル](../../design/protocol.md)である。
- 0.3 で合意済みの方向として、framing 長ガード残置、監視切断→再承認の許容、Session＝既定 stream 1本を試作条件の前提とする（判断の正本は[プロトコル](../../design/protocol.md)）。

| 項目                                     | 扱い                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| framing 本体上限                         | 実装済み。正本は `packages/bridge-protocol/src/transport/framing.ts` の `FRAME_MAX_BYTES`                                             |
| yamux inbound／outbound                  | 実装済み。正本は `packages/bridge-protocol/src/transport/muxer.ts` の `MAX_INBOUND_STREAMS`・`MAX_OUTBOUND_STREAMS`（各接続）         |
| yamux window                             | 実装済み。正本は `packages/bridge-protocol/src/transport/muxer.ts` の `MUX_STREAM_WINDOW_BYTES`                                       |
| yamux maxStreamWindowSize                | 実装済み。初期 window と同値・自動拡大抑止。正本は `bridgeMuxer` の固定設定                                                           |
| keepalive 間隔                           | 実装済み。正本は `packages/bridge-protocol/src/transport/keepalive.ts` の `KEEPALIVE_*`                                               |
| keepalive 応答期限                       | 実装済み。正本は `packages/bridge-protocol/src/transport/keepalive.ts` の `KEEPALIVE_PING_TIMEOUT_MS`                                 |
| 同時 Ping 数                             | 1件（実装済み。正本は `keepalive.ts` とテスト）                                                                                       |
| `maxWebSocketMessageBytes`               | WS メッセージ1件の上限（`ws` の `maxPayload`）。framing 上限とは別。正本は `packages/bridge-server/src/config.ts` の `DEFAULT_LIMITS` |
| `maxMessageBytes`（0.2）                 | 0.3 で撤去済み                                                                                                                        |
| `maxReliableQueueMessages`               | 0.3 で廃止済み                                                                                                                        |
| `maxReliableQueueBytes`                  | 0.3 で廃止済み                                                                                                                        |
| `maxStreamsPerConnection`                | 0.3 の yamux 値に置き換え済み                                                                                                         |
| `initialCreditWindow`                    | 0.3 で廃止済み                                                                                                                        |
| `maxConnections`                         | 8                                                                                                                                     |
| `pairingStartTimeoutMs`                  | 10,000 ms                                                                                                                             |
| `pairingApprovalTimeoutMs`               | 120,000 ms                                                                                                                            |
| `acceptanceDurationMs`                   | 120,000 ms                                                                                                                            |
| `maxUnauthorizedConnections`             | 2／全8の内数                                                                                                                          |
| `maxPendingPairings`                     | 2／未認可2の内数                                                                                                                      |
| `pairingRateWindowMs`                    | 60,000 ms                                                                                                                             |
| `maxPairingRequestsPerOrigin`            | 5回／直近60秒                                                                                                                         |
| `maxPairingRequestsTotal`                | 10回／直近60秒                                                                                                                        |
| `maxPairingCodeGenerationAttempts`       | 16回                                                                                                                                  |
| `connectionCloseGraceMs`                 | 1,000 ms                                                                                                                              |
| world-client `requestTimeoutMs`（0.2）   | 0.3 で撤去済み（業務相関・要求待機は上位層の責務）                                                                                    |
| world-client `maxPendingReliable`（0.2） | 0.3 で撤去済み                                                                                                                        |
| world-client `maxMessageBytes`（0.2）    | 0.3 で撤去済み                                                                                                                        |

- 値の正本はコードである。サーバ側の制限値は `packages/bridge-server/src/config.ts` の `DEFAULT_LIMITS` に置き、`BridgeOptions.limits` で上書きする。0.3 の輸送採用値（framing・yamux・keepalive）は `packages/bridge-protocol/src/transport/` の各定数（`framing.ts`・`muxer.ts`・`keepalive.ts`）を正本とする。ワールド側の公開操作は `packages/world-client/src/client.ts`・`packages/world-client/src/session.ts` を正本とし、0.2 の要求相関・会計 API は撤去済みである。件数容量 `C`・初期付与の意味論は 0.2 の方式の履歴であり、0.3 ではクレジット層ごと廃止済みである（[プロトコル](../../design/protocol.md)を参照）。
- yamux 試作で確定した採用版の既定値は次のとおりである。上表の 0.3 採用値と異なる行は、製品実装で明示設定する（`bridgeMuxer` が固定設定として適用済み）。採用版は `@chainsafe/libp2p-yamux` 8.0.1（tag commit `7dca09b`）である。inbound／outbound 上限の既定は各1000であり、設計の各32へ明示設定する。`maxMessageSize` の既定は 64KiB である。受信 window は RTT 既知で最大 16MiB まで自動拡大するため、上表の `maxStreamWindowSize`（初期 window と同値）の明示設定で抑止する。`send()` は同期の真偽値であり、false は破棄ではなく writeBuffer への滞留を表す。`close()` は FIN 送出前に write queue の idle と drain を待つ。GoAway は mux を閉じるがトランスポートは閉じない。

## 計測項目

確定事項である。結果は検証待ちである。

- 往復時間の p50、p95、p99。
- 最新値の鮮度、置換数、欠番数。
- コマンド完了時間。
- AI 出力の到着間隔。
- 両端の待ち行列のバイト数と件数、`bufferedAmount`、yamux window・backpressure 時の `reliable` 送信 Promise の完了点（ローカル送信完了であり相手受信・業務完了ではないこと）。
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
- 試作の置き場と観測要点: 試作は `tools/yamux-spike/`（experimental、製品コードと分離）に置く。多重化（4本同時 echo の対応保持）、WS 分割（7B 刻みでも復元・送出数で発動を確認）・集約（25ms 窓の5連打が順序保持・送出数で発動を確認）、FIN（片方向終了と逆方向継続、双方 FIN 後も mux 維持）、RST（対象のみ中断・他 stream 継続）、GoAway（相手 mux の終了観測）、window backpressure（初期 window ちょうどで詰まり・pause 中 `onDrain` 不解・resume で解ける・全量到着）、認可プリリュード切替（同じ WS 上での mux 開始・混交なし）を観測する。試作時点で未確認のうち、受信 window 自動拡大抑止は製品の単体テスト（`transport-muxer.test.ts`）で確認済みである。inactivity timeout は現行固定版（`@libp2p/utils` 7.4.1・`@chainsafe/libp2p-yamux` 8.0.1）の読解では発火経路がなく（製品は指定せず、基底への受け渡しのみで未使用）、上流更新時に再確認する。ブラウザ実機は未確認のままである。詳細は試作の `README.md` を参照する。
- 診断の往復: 認可後の `data` 上で診断 payload が往復すること（echo は `{op: "echo", id, value}`→同形の返送、ping は `{op: "ping", id}`→`{op: "pong", id}`。`op`・`id` は payload 内であり、wire に業務 requestId は載せない）。形状の正本は `packages/bridge-app-core/src/plugins/diagnostic.ts` とする。
- 製品の未検証分岐: `auth_ok` 送信失敗・mux 初期化失敗・切替中 text 受信の3分岐は製品テスト未実施である。負荷試行は未了である。実ブラウザは[実行条件](#実行条件)に記録の dev（`http://localhost:5173`）での製品経路スモークのみ実施済みであり、実ホスト実行時の確認は未了である。

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

- 設計判断の正本は Design 側である。ループバック限定の待ち受け追加の許可範囲と WebTransport 比較へ進む条件は[ブリッジ接続](../../design/bridge-connection.md)、審査の宣言要件は[ブリッジ接続](../../design/bridge-connection.md)、同一実行基盤の前提は[プロトコル](../../design/protocol.md)を正本とする。

## 区分表

| 区分     | 内容                                                                                                                                                                                                            | 参照先                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 確定     | 実行手順、試作条件、計測項目、証拠の残し方、判定後の分岐、yamux 試作の検証項目                                                                                                                                  | 本文                                                                                                              |
| 合意済み | 0.3 の契約（yamux on WebSocket・認可後 mux 開始・件数クレジット層廃止・`seq` 廃止・配送順保証なし・終了契約・送信 API 契約）、framing 長ガード残置、監視切断→再承認の許容、Session＝既定 stream 1本             | [ブリッジ接続](../../design/bridge-connection.md)と[プロトコル](../../design/protocol.md)に反映済み               |
| 検証済み | 0.3 の製品実装・ローカル検証（単体・結合テスト、`vp check`、ビルド、実ブラウザ dev での製品経路スモーク・Node 製品 E2E）、実ホスト検証済み（接続・認可・echo／ping。承認は自動ハーネス。2026-10-10、version 2） | [実行条件](#実行条件)・各パッケージのテスト                                                                       |
| 検証待ち | 条件ごとの観測結果、対応表、時計差の誤差評価、yamux 試作の結果、検証待ち（正式目視承認フロー・未検証 3 分岐・負荷・CSP CSS。実ホストの接続・認可・echo／ping は検証済み）                                       | 本文の項目に記録する                                                                                              |
| 合意待ち | 必須対応範囲の将来拡大、ストリームごとの欠落許容、必要鮮度・遅延・負荷範囲、開発モードの許可Originの列挙場所                                                                                                    | 観測後に合意し[ブリッジ接続](../../design/bridge-connection.md)と[プロトコル](../../design/protocol.md)に反映する |

- 対象ブラウザの必須範囲（必須は Google Chrome のみ）の判断自体は[ブリッジ接続](../../design/bridge-connection.md)の確定事項であり、この表の「確定」は手順の確定を指す。
