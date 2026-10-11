# プロトコル

初期の認証、通信形式、二種類の配送、流れ制御、制限、エラーの扱いについての上位の設計判断を定める。

## 正本の分担

形状（フィールド名・型・必須/任意）は [packages/bridge-protocol/src/messages.ts](../packages/bridge-protocol/src/messages.ts)、
外部入力の境界検証は [packages/bridge-protocol/src/validate.ts](../packages/bridge-protocol/src/validate.ts)、
動的契約は各テスト、上位の設計判断はこの文書を正本とする。
輸送の採用値の正本は `packages/bridge-protocol/src/transport/` の各定数（`framing.ts` の `FRAME_MAX_BYTES`・`muxer.ts` の `MUX_STREAM_WINDOW_BYTES`・`MAX_INBOUND_STREAMS`・`MAX_OUTBOUND_STREAMS`・`keepalive.ts` の `KEEPALIVE_*`）とし、本文に複製しない。
ワールド側の公開操作の正本は `packages/world-client/src/client.ts` の `createConnectionRequest`・`packages/world-client/src/session.ts` の `SessionProvider`・`Session` とする。
Session capability（`kind`・`direction` 別の公開型）の形状の正本は [packages/bridge-protocol/src/transport/session-types.ts](../packages/bridge-protocol/src/transport/session-types.ts)、生成口の overload は [packages/bridge-protocol/src/transport/connection.ts](../packages/bridge-protocol/src/transport/connection.ts) の `Connection` とする。

### 版の方針

- セッション管理は **yamux on WebSocket（libp2p なし）**とする。0.x 台では破壊的変更を許容し、異なるバージョン間の互換設計はしない（ルートの `AGENTS.md` の方針どおり）。
- 形状・数値の正本はコードであり、以降の調整はコードの定数を正本として行う。
- `packages/bridge-protocol/src/messages.ts` が形状の正本である。

## 用語

本節で Connection／Session／yamux stream の呼び分けを自己完結して定義する。

- **Connection**＝WebSocket 接続1つ。認可は Connection 単位のみに属し、切断で失効する（[ブリッジ接続](bridge-connection.md)の接続認可の判断を維持する）。
- **Session**＝一連のやりとりの単位。既定は双方向 yamux stream 1本である。
- **yamux stream**＝多重化の輸送単位。論理名と yamux stream ID の対応はアプリが保持する。`latestMailbox`（接続をまたぐサーバ全体記録、キーは論理名）は変更しない。
- 複数の stream を束ねる終了プロトコルは導入しない。

## 判断と理由

### 接続前検証とペアリングを組み合わせる

- WebSocket の昇格前に、接続元がループバックであること、ホスト・ポート・パスが設定した接続先と一致すること、`Origin` の完全一致をいずれも確認する。ループバック到達だけでは利用者の認可の根拠にならないため、接続先の一致確認と明示的なペアリングを組み合わせる。
- WebSocket の安全性を CORS ヘッダに依存させない。CORS を認可の根拠にしない。
- 欠落した `Origin`、`null`、ワイルドカード、接尾辞一致は拒否する方針とする。具体的な符号・書式は型・境界検証・テストを参照する。
- ペアリングはワールド側から `pairing_start` で開始する。開始を受けるとブリッジは比較コードを発行し `pairing_pending` で通知し、人間がブリッジ側（ローカル CLI、将来は GUI）で承認したその接続だけを `auth_ok{requestId,connectionId}` で接続単位に認可する。ブリッジが発行するのは暗号学的乱数による数字6桁の比較コードであり、OTP 認証ではない（照合のための比較コード）。使い捨て秘密値（ワールド側での入力）は採用しない。
- 認証前はデータとローカル情報を送受信しない。ただしペアリングに限定した制御メッセージ（`pairing_start`・`pairing_pending`・認証前エラー）は例外として送受信する。
- 受付は起動時は無効であり、手動の有効化・無効化だけで切り替える。自動クローズ・期限・残時間表示は無い。保留に時限はなく、手動の承認・拒否か切断まで残る。無効化時は未認可接続をその場で終了・切断し（認可済みは維持）、再有効化しても終了済みの要求は復活しない。`pairing_pending` は `{v,type:"pairing_pending",requestId,code}` のみとし、期限フィールド（`expiresAt`・`expiresInMs`）は持たない。プロトコル版は `0.4.0` とする。権限範囲は現行同等とし、認可はその接続だけに属し、切断で失効し、再接続は再承認である。これらを設計判断とする。形状・数値・状態遷移の詳細は正本（[packages/bridge-protocol/src/messages.ts](../packages/bridge-protocol/src/messages.ts)・[packages/bridge-protocol/src/validate.ts](../packages/bridge-protocol/src/validate.ts)・[packages/bridge-server/src/config.ts](../packages/bridge-server/src/config.ts)・実装・テスト）へ置き、ここでは複製しない。
- 比較コード・要求 ID を URL・クエリ・Cookie・ログ・ブラウザの永続ストレージに入れない。比較コードは両画面への表示と照合にだけ使う。
- 受付レート・未認可接続数・保留数に上限を設け、超過は保留せず拒否する。具体値は `packages/bridge-server/src/config.ts` の `DEFAULT_LIMITS`・実装・テストを参照する。
- ローカル管理は受付の有効化・無効化・保留一覧・要求 ID と比較コードの両方を指定する承認／拒否、接続一覧と接続 ID 指定の切断を提供し、指定接続だけを切断して待ち受けと他接続は維持する。全体停止とは区別する。承認操作はローカル管理境界だけに置き、ワールド向け WebSocket には公開しない。
- 認可は接続単位にする。長期資格情報の保持と、再接続時の誤った権限継承を避けるためである。成功した WebSocket 接続だけを認可し、切断で認可は失効し、再接続には再承認が必要である。
- `Origin` は「そのワールド」の識別に使えない。同一文書・同一スクリプト実行基盤のため、XRift ホストと同じ基盤内のコードから比較コードや通信を隔離できない。コード一致は表示された要求との対応確認であり、ワールドの真正性の証明ではない。ワールド ID・表示名・SDK 内部変数は認証境界にならない。

### 通信形式と応答相関

- ペアリング完了までのやりとりは JSON とする。認可後は同じ WebSocket 上の yamux へ切り替える（境界は[認可後の輸送境界と framing](#認可後の輸送境界と-framing)を参照する）。バイナリ化の要否は計測後に判断する段階的な対応とし、要否は検証計画を参照する。
- 順序保証はストリーム内とする。異なるストリーム間の全体順序は保証しない。
- コマンド処理結果の request／response 相関はブリッジ設計に持たせない。echo／command は `data` に一本化し、当面の意味づけは上位層の責務とする。
- 切断後の自動再送を採らない。結果不明のコマンドを重複実行しないためである。切断時の未完了コマンドは結果不明として破棄し、通知する。

### 認可後の輸送境界と framing

- ペアリング完了までの既存 JSON によるやりとりは変えない。**認可（`auth_ok`）後に同じ WebSocket 上で yamux muxer を開始する**ことを輸送の境界とする。別 WebSocket での mux 開始・認可の継承はしない。
- yamux stream 上のメッセージ境界は **framing** で定める。固定4-byte長＋JSON本体（UTF-8 シリアライズ）とし、受信時は長さを読んだ時点で検査し、巨大領域を先に確保しない。本体上限は [`FRAME_MAX_BYTES`](../packages/bridge-protocol/src/transport/framing.ts) を正本とし、ここでは複製しない。WS `maxPayload` は別の輸送単位（WebSocket メッセージ単位）の制限として扱い、framing とは区別する。
- 超過・壊れた framing・途中 FIN は対象 Session を異常終了する。ローカル送信超過は投入前に拒否する。
- 形状・数値の詳細はコードを正本とする。ここでは境界と検査の方針のみを定める。

### `reliable` と `latest` を分ける

- 欠落不可の列と、古い値を置換できる状態とで配送を分ける。`reliable` はコマンド・テキスト・AI 逐次出力・欠落不可のセンサー列に使い、ストリーム内の順序を保持する。満杯時は待機または明示エラーとする。`latest` は独立した状態のスナップショットに使い、ストリームごとに未送信の古い値を最新値で置換でき、欠番を許容する。配送と遅延の上限は保証しない。
- 欠落許容は明示選択にする。高頻度という理由だけで間引かない。既定は `reliable` とし、`latest` は明示選択とする。位置の絶対値は `latest` に適するが、差分・積分用サンプル・イベントは欠落で意味が壊れ得るため `reliable` にする。
- `reliable` Session は**双方向**（どちらからも開始可）、`latest` は**一方向**とする。`latest` の置換は yamux 投入前に最新値を置き換える方式とし、投入後の取り消しはしない。WebSocket 送出済みの値は取り消せないため、`latest` も輸送全体の鮮度保証にはならない。この限界は方式選択の前提として残す。
- echo／command は `data` に一本化し、当面の意味づけは上位層の責務とする。request／response 相関をブリッジ設計に持たせない判断は[不採用](#不採用)に残す。
- `reliable` のアプリ層 `seq` を持たず、`UNEXPECTED_SEQ` 検出も持たない。順序は yamux stream に委ねる。判断の記録は[不採用](#不採用)に残す。

### 流れ制御を yamux に寄せる（件数クレジット層は不採用）

- 「受信容量に基づく件数クレジット」層（`auth_ok.window`・`credit` メッセージ・サーバ／クライアントの会計エンジン）は**持たない**（[不採用](#不採用)を参照）。理由は、順序・再送・流れ制御を yamux stream に委ねることで層を減らし、独自の会計と通知の行き違い（残量上書き・再通知の進行停止など）の問題ごと排除するためである。
- 流れ制御は yamux の window に寄せる。本数上限と window の正本は [`muxer.ts`](../packages/bridge-protocol/src/transport/muxer.ts) の定数（`MAX_INBOUND_STREAMS`・`MAX_OUTBOUND_STREAMS`・`MUX_STREAM_WINDOW_BYTES`）とし、独自の合算制限は作らない。window は自動拡大しない方針とする。ただし採用版のライブラリ既定は RTT 既知で受信 window を自動拡大するため、この方針を実装で守るには `maxStreamWindowSize` を初期 window と同値に明示設定する（必須設定である）。
- アプリ層の reliable 件数／バイト待機上限、接続全体の総バッファ上限は**設けない**。総メモリ上限は保証しない。シンプルさを優先し、yamux で扱えない上限は廃止する。
- 唯一の例外として **framing の長さガードは残す**（[認可後の輸送境界と framing](#認可後の輸送境界と-framing)を参照）。固定4-byte長＋JSON本体の上限検査であり、受信時に長さを読んだ時点で検査し、巨大領域を先に確保しない。

### 制限とエラーの扱い

- エラーは待機または明示エラーで返し、黙って捨てない。
- 切断時は送受信の待ち行列と未完了の待機を破棄して通知する。

### 終了契約

- **FIN**＝送信方向の正常終了（逆方向は継続可）。双方 FIN＝Session 正常終了（Connection と他 Session は維持する）。
- **RST**＝対象 Session の即時中断（待機送信・未完成フレーム破棄、他 Session は維持する）。
- **GoAway**＝mux 全体の終了通知（Session 終了ではない）。GoAway は相手の mux 終了通知であり、排出保証でも全データ到達保証でもない。受信後は Connection 終了へ進む。
- **WS close／輸送障害**＝Connection 全体終端、全 Session 終了、認可失効。再接続は再承認である。
- Connection 終端は開始通知（`onClosing`）→全 Session 終端→終端通知（`onClose`）の順序で一度だけ行い、開始後は全 Session を終了扱いにする（送信受付・受信配送を止める）。
- 正常終了も業務成功の証明ではない。ブリッジは EOF／中断／Connection 終了を通知し、待機中の送信 Promise を拒否する（二重決着しない）。完了確認できない業務は正常終了時も「結果不明」とする。RST は「未実行」を意味しない。自動再送しない。

### 配送順の保証を持たない

- 「制御優先・接続全体 FIFO」の配送順保証は**持たない**（[不採用](#不採用)を参照）。同一 stream 内の順序は維持するが、stream 間の順序・公平性・優先度は保証しない。制御専用 stream は作らない。
- 致命的エラーはエラー配送を待たず RST／Connection 終了へ進む（理由の通知はベストエフォート）。

### WebSocket close code の使い分け

- 1000＝正常終了、1001＝サーバ停止、1008＝ポリシー（`disconnectConnection` の即時切断を含む）、1009＝WSメッセージ超過、1011＝内部障害とする。1006 は観測値であり送信しない。
- `disconnectConnection` は排出待ちをせず、1008＋固定 reason で閉じ、1000ms で強制終了する（[ブリッジ接続](bridge-connection.md)の判断を参照）。

### 監視

- yamux の公開 `ping()` を使う自前の監視ループとする。同時 Ping 1件で動かし、不応答で Connection 終端とする。間隔・応答期限の正本は [`keepalive.ts`](../packages/bridge-protocol/src/transport/keepalive.ts) の定数（`KEEPALIVE_FIRST_DELAY_MS`・`KEEPALIVE_INTERVAL_MS`・`KEEPALIVE_PING_TIMEOUT_MS`）とし、ここでは複製しない。
- 内蔵 keepalive に障害検知を委ねない（`enableKeepAlive: false`）。`enableKeepAlive`／内蔵 keepalive の実挙動が採用版でどう振る舞うかは要確認であり、上流 master は失敗ログのみとする。
- WS Ping との二重監視はしない。独自アプリ heartbeat は追加しない。
- 認可前の期限監視は持たない（保留は無期限）。Ping（認可後）・`connectionCloseGraceMs`（終了開始後）は目的が別である。終了開始で監視を止め、強制終了タイマーは一度だけ動かす。
- Ping 成功は往復経路と相手の yamux 処理が動いたことのみを示し、業務ハンドラ・AI処理・要求完了を保証しない。

### 送信 API 契約

- `reliable` 送信は `Promise<void>` を返し、stream 内で直列化して下位 backpressure を待つ。成功＝ローカル送信処理完了であり、相手の受信・業務完了ではない。
- `sendLatest` は同期受付を維持する（検証後、yamux 投入前に最新値を置換）。戻りは配送完了を意味しない。投入中1件＋未投入最新1件で動く。
- `latest` の非同期失敗は Session／Connection の終端通知で知らせる。値ごとの配送 Promise は作らない。
- 公開 `Session` は `kind`・`direction` を判別子とする合併で capability を型に表す。`reliable`（双方向のみ）は `sendReliable` と `onMessage` を持ち、`latest`（一方向のみ）は送信側が `sendLatest` のみ・受信側が `onMessage` のみを持つ。
- 生成側は常に送信側であり、`createSession` は合法な組合せ（`kind` と `direction`、role に応じた向き）だけを受ける overload とする。client の送信は `to_server`・受信は `to_client` であり、server は逆である。組合せ違いの誤用は型で棄却し、相手の主張しうる不正値に対する実行時の境界検証（種別・方向・方向違反・終端後の拒否）は残す。形状の詳細は正本の型に置き、ここでは複製しない。
- 相手起点の Session（`onSession` 通知）と取得口（`getSession`）は合併を返し、`kind`・`direction` で絞ってから使う。

## 図

接続の確立は、接続前検証・ペアリング認証・接続に属する認可の大枠で進む。

```mermaid
flowchart TD
    A[接続前検証: ループバック・接続先一致・Origin完全一致] --> B[比較コード発行: ワールド開始→ブリッジが発行→両画面表示]
    B --> C[ローカル承認: 人間が照合して承認→auth_okで接続単位に認可]
    C --> D[接続に属する認可: 切断で失効・再接続は再承認]
```

送信から終了までは、認可後の mux 開始・Session 単位の終了・Connection 終端の大枠で進む。符号・数値・全分岐は図に再現しない。

```mermaid
flowchart LR
    A[認可: 既存JSONでペアリング完了→同じWS上でmux開始] --> B[Session: 既定は双方向yamux stream 1本]
    B --> C[終了: FINは方向別・RSTは即時中断・GoAwayはmux全体]
    C --> D[Connection終端: WS closeで全Session終了・認可失効]
```

## 不採用

- CORS は認可の根拠にせず、昇格前の検証と明示的ペアリングで認可する。
- 長期資格情報を持たない。認可は接続に属し、切断で失効する。
- コード一致だけで自動認可しない。利用者の承認がなく、表示要求との対応確認にならないためである。
- ワールド発行コードを唯一の承認キーにしない。選択値・重複・取り違えの問題があるためである。
- 使い捨て秘密値をワールドで入力する方式は採用しない。開始・表示・承認の向きをワールド起点の比較コード方式に寄せ、入力の持ち回りをなくすためである。
- 初期のバイナリ化を採らない。計測後に判断する。
- 本物の非信頼データグラムを今は採らない。yamux 投入前置換の `latest` で置換の考え方だけを入れる。
- 切断後の自動再送を採らない。結果不明のコマンドを重複実行しない。
- エラーを黙って捨てない。待機または明示エラーで返す。
- 受信容量に基づく件数クレジット層（`auth_ok.window`・`credit` メッセージ・会計エンジン）を採らない。順序・再送・流れ制御を yamux に委ね、層と行き違い問題ごと排除するためである。
- `reliable` のアプリ層 `seq` と `UNEXPECTED_SEQ` 検出を採らない。順序は yamux stream に委ねるためである。
- request／response 相関をブリッジ設計に持たせない。当面は上位層の責務とし、echo／command は `data` に一本化する。
- 制御優先・接続全体 FIFO の配送順保証を採らない。同一 stream 内の順序のみ維持し、stream 間の順序・公平性・優先度は保証しない。シンプルさを優先するためである。

## 合意待ち・検証待ち

検証待ち・合意待ちの項目一覧は [docs/verification/bridge-connection.md](../docs/verification/bridge-connection.md) を正本とする。

## 正本へのリンク

- 上位の設計判断: この文書（[design/protocol.md](protocol.md)）、全体構成は [design/bridge-connection.md](bridge-connection.md)
- 形状（フィールド名・型・必須/任意）: [packages/bridge-protocol/src/messages.ts](../packages/bridge-protocol/src/messages.ts)
- 外部入力の境界検証: [packages/bridge-protocol/src/validate.ts](../packages/bridge-protocol/src/validate.ts)
- 輸送の採用値: [framing.ts](../packages/bridge-protocol/src/transport/framing.ts)（`FRAME_MAX_BYTES`）・[muxer.ts](../packages/bridge-protocol/src/transport/muxer.ts)（`MUX_STREAM_WINDOW_BYTES`・`MAX_INBOUND_STREAMS`・`MAX_OUTBOUND_STREAMS`・`enableKeepAlive: false`）・[keepalive.ts](../packages/bridge-protocol/src/transport/keepalive.ts)（`KEEPALIVE_*`）
- ワールド側の公開操作: [packages/world-client/src/client.ts](../packages/world-client/src/client.ts)（`createConnectionRequest`）・[packages/world-client/src/session.ts](../packages/world-client/src/session.ts)（`SessionProvider`・`Session`）
- Session capability の公開型: [session-types.ts](../packages/bridge-protocol/src/transport/session-types.ts)（`Session`・`InboundSession`・`OutboundSession`）、生成口の overload は [connection.ts](../packages/bridge-protocol/src/transport/connection.ts)（`Connection` の `createSession`・`getSession`・`onSession`）
- 検証計画: [docs/verification/bridge-connection.md](../docs/verification/bridge-connection.md)
