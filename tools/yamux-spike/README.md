# yamux-spike（experimental・参照用）

> 製品輸送は `packages/bridge-protocol/src/transport/` に引き継がれた。以下は採用判断時の試作記録として残し、製品の正本にはしない。

libp2p なしの **yamux（muxer のみ）on 自前 WebSocket** の採用可否を判断するための限定試作。
製品実装ではなく、採用判断の証拠集めだけが目的。`apps/bridge`・`packages/*` の `src/` は変更しない。

## 採用版

| 項目                      | 値                                                                             |
| ------------------------- | ------------------------------------------------------------------------------ |
| `@chainsafe/libp2p-yamux` | **8.0.1**（固定。`7dca09b`、2025-10-15。`sendReset` 同期化の修正を含む）       |
| `@libp2p/interface`       | 3.3.0（解決値）                                                                |
| `@libp2p/utils`           | 7.4.1（解決値）                                                                |
| `uint8arraylist`          | 3.0.2（解決値。`@libp2p/utils` と同一コピーにする。v2 系だと型が不一致になる） |
| `ws`                      | 8.22.0（catalog）                                                              |

`pnpm-lock.yaml` の変更あり（新規 workspace の導入分のみ）。`pnpm-workspace.yaml` の変更なし（`tools/*` に一致済み）。

## 試作の採用設定（製品実装時の必須設定）

- `streamOptions: { maxStreamWindowSize: 256 * 1024 }` を全 muxer に明示する。ライブラリ既定は RTT 既知で受信 window を最大 16MiB まで倍増させるため、設計の「自動拡大しない」を守る必須設定である（`attachMuxer` で既定適用。対照実験の `uncappedWindow` のみ外す）。
- `enableKeepAlive: false` を全 muxer に明示する（Ping 監視シナリオのみ有効化）。内蔵 keepalive に障害検知を委ねない設計判断に従う。
- 輸送層（`WsMessageStream`）は `ws` の未送出量が目安（1MiB）を上回ると `canSendMore: false` を返し、未送出量の polling で `drain` を出す。`ws` に再開通知がないためであり、出さないと基底の `writableNeedsDrain` が残り `close()`・`onDrain()` が永遠に待つ不具合になる（試作中に 5MiB 送信後の `close()` 停止として発覚・修正済み）。

## 構成

```text
tools/yamux-spike/
  src/ws-transport.ts    WebSocket ↔ duplex アダプタ（yamux の MessageStream 実装）
  src/node-socket.ts     Node `ws` 用の輸送抽象
  src/browser-socket.ts  ブラウザ WebSocket 用の輸送抽象（分岐はこちら）
  src/raw-socket.ts      両者の最小共通抽象（バイナリ専用）
  src/framing.ts         固定4バイト長＋JSON本体、長さガード付き
  src/prelude.ts         認可プリリュード（pairing_start→auth_ok）の境界
  src/peer.ts            Node サーバ・クライアントの組み立てと観測用具
  src/scenarios.ts       観測シナリオ11件（tests と scenario 実行口で共用）
  src/scenario-main.ts   生の観測結果を出す実行口
  src/browser-server.ts  ブラウザ確認用の常駐サーバ（127.0.0.1:5180）
  src/browser-main.ts    ブラウザ確認口の画面処理
  index.html             ブラウザ確認口の入口
  tests/                 framing 4件＋scenario 10件
```

## 実行方法

```sh
pnpm --filter yamux-spike run scenario  # Node シナリオ11件の生出力
pnpm --filter yamux-spike run test      # vitest（14件）
pnpm --filter yamux-spike run typecheck # tsc --noEmit
pnpm --filter yamux-spike run build     # ブラウザ確認口の bundle（型・束ねの証明）
```

## 確認項目と観測結果（2026-10-10 実行）

`run scenario` の生出力が正本。以下は要点。

- **認可後 mux 開始**: 成功。テキスト交換後に同じソケットで echo が往復し、混ざらない。
- **多重化**: 成功。4本同時の echo が対応を保って往復。client/server の stream ID は `[1,3,5,7]`。
- **WS 分割**: 成功。7B 刻み分割でも復元できる。送信側は yamux 書き込み 3回に対し WS メッセージ 14件で、分割の発動を送出数で確認する（退化的に通らない）。
- **WS 集約**: 成功。25ms 窓への5連打が順序どおり復元できる。送信側は yamux 書き込み 6回に対し WS メッセージ 2件で、集約の発動を送出数で確認する。
- **FIN**: 成功。`close()` で送信方向が終わり、相手は `remoteCloseWrite→end` を観測。逆方向は継続でき、双方 FIN 後も muxer は `open` のまま。
- **RST**: 成功。`abort()` で対象だけ中断（相手は `close`、状態 `reset`）。他 stream の echo は継続。
- **GoAway**: 成功。`muxer.close()` で相手 muxer は `closed` になる。相手 stream も `closed`。
- **window/backpressure**: 成功。初期 window 256KiB ちょうどで詰まる（32KiB×40回送出のうち8回受付・32回拒否、未送出 1048576B が writeBuffer に残る）。pause 中の `onDrain()` は300ms 待っても解けず、resume で解ける。全量 1310720B を受信。
- **window 拡大抑止**: 成功。ping で RTT を確知させたうえで 5MiB を連続送信し、受信 window が初期 262144B から最大 262144B のまま拡大しない（抑止設定の効果を証拠化）。
- **window 拡大の対照**: 成功。抑止を外すと受信 window が初期 262144B から最大 8388608B（8MiB）へ拡大する。抑止設定が効くことの対照記録。
- **keepalive/Ping**: 成功。`ping()` は 1ms で解決。内蔵 keepalive（50ms間隔）の ping frame を16件観測。輸送喪失後に muxer は `closed` になり、終了後の `ping()` は `StreamStateError: Cannot write to a stream that is closed` で拒否する。

### 送信完了の時点（重要）

- `stream.send()` は同期で真偽値を返すだけで Promise ではない。完了＝相手受信ではない。
- `stream.close()` は送出待ち（idle＋drain）を満たしてから FIN するため、local 送出完了の時点を表す。相手が読んだ保証にはならない（当試作では 0ms で完了）。
- `getRTT()` の ping 前の値（実装は `-1` 初期化、doc は `0` と記述）は未確認。当試作では ping 後のみ `1` を観測した。

### 設定の既定値（採用版 8.0.1 の実測・読み取り）

- `enableKeepAlive: true`、`keepAliveInterval: 30_000`
- `maxInboundStreams / maxOutboundStreams: 1_000`
- `maxMessageSize: 64KiB`（muxer 既定。stream 側は初期 window−12B で上書きする）
- 初期 stream window `256KiB`（固定。引き下げは不可で検証エラーになる）
- 最大 stream window `16MiB`（上限 `2^32−1`。試作は自動拡大抑止のため初期 window と同値に明示設定する）
- `maxReadBufferLength: 4MiB`、`maxWriteBufferLength: Infinity`、`inactivityTimeout: 120_000ms`
- `maxEarlyStreams: 10`

## 既知の制約・未確認事項

- **ブラウザ確認口は未実行**。`build` で bundle が通ること（54KB、yamux がブラウザ束ね可能）まで確認。人間の実機手順は下記。
- **keepalive 単独での切断検出は未確認**。実装を読むと失敗時はログのみで abort しない（`TODO: should abort here?`）。輸送喪失時は輸送 close 経路で muxer が閉じるため、内蔵 keepalive に障害検知を委ねない設計判断と整合する。
- **inactivity timeout の発火は未確認**（120秒待ちを試作では行わない）。
- **受信 window 自動拡大抑止の実機確認は未確認**（試作の loopback 観測のみ。実機・長時間での挙動は製品実装時に再確認する）。
- `YamuxMuxer` 型は root から型輸出されないため、factory の型引数から取り出す小技を使う（`SpikeMuxer`）。製品実装時は輸出の有無を再確認すること。
- `sendData`・`sendReset` などは基底で公開抽象のため、輸送層の公開面に出る。製品実装時は薄い包みを検討すること。
- 同時待ちの `stream` 受け口は最初の1件が全員に届くため、複数待ちは1つの受け口で束ねること（`waitForInboundStreams`）。

## ブラウザ確認の手順（人間が実機で行う）

1. `pnpm --filter yamux-spike run spike-server`（127.0.0.1:5180 で待ち受け）
2. `pnpm --filter yamux-spike run dev`（http://localhost:5190 を開く。Chrome 前提）
3. 「接続して mux 開始」→「Ping（echo＋ping）」を押し、echo 応答と ping 往復を確認する

## design との衝突

なし。FIN／RST／GoAway／window／ping の観測は `design/protocol.md` の0.3 方向（終了契約・流れ制御・監視・送信 API 契約）と整合する。
ただし `send()` が Promise ではない点は、設計の「`reliable` 送信は `Promise<void>`」を製品実装時に包む必要があることを示す。
