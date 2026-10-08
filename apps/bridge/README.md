# bridge

PC上で動作するワールドとローカルをつなぐ中継アプリ。

仕様の正本は `../../design/bridge-v0.md`、`../../design/protocol-v0.md`、`../../design/verification-v0.md` とする。

## 起動

```bash
vp run build
node dist/index.mjs --port 3100
# 開発時（明示的開発モードのみ追加 Origin を許可）
node dist/index.mjs --dev --origin http://localhost:5173
```

- 待ち受けは `127.0.0.1` に明示 bind する（`0.0.0.0`/`::` は使わない）。
- 正規 endpoint は `ws://127.0.0.1:3100/v1`。ポート競合時は探索せず失敗する。
- 対話命令: `pair <origin>`（秘密値の発行）/ `status` / `connections` / `disconnect <connectionId>` / `quit`。
- `status` と `connections` は接続ID・Origin・認証状態の一覧を出す。秘密値は出さない。
- `disconnect <connectionId>` は指定接続だけを `1008`・固定 reason `operator disconnect` で切断する。待ち受けと他接続は維持する。不明IDは明示エラーとし、全切断へは fallback しない。
- 診断ログは標準エラーへ JSON 1行で出す。秘密値は標準出力の `pair` 応答にのみ出し、ログ・URL・query には出さない。
- 受信上限の超過は close 1009 で通知する。JSON の明示エラーや非空 reason は保証しない。

## B1 の計測用暫定値

有限・設定可能な値であり、合意値ではない。`design/verification-v0.md` の
試作条件へ転記し測定結果から合意することが前提である。定義場所は
`src/config.ts` の `DEFAULT_LIMITS` で、`BridgeOptions.limits` で上書きできる。

| 項目                       | 既定値  | 意味                                     |
| -------------------------- | ------- | ---------------------------------------- |
| `maxMessageBytes`          | 65536   | 1メッセージの最大長（UTF-8 JSON バイト） |
| `maxReliableQueueMessages` | 256     | 接続ごとの reliable 未応答キュー上限件数 |
| `maxReliableQueueBytes`    | 1048576 | 同上・上限バイト数（UTF-8 バイトで計上） |
| `maxStreamsPerConnection`  | 32      | 接続ごとのストリーム数上限               |
| `initialCreditWindow`      | 32      | 認証直後の reliable 送信クレジット       |
| `authTimeoutMs`            | 10000   | 認証待ちの制限時間（ミリ秒）             |
| `maxAuthAttempts`          | 3       | 接続ごとの認証試行上限                   |
| `maxConnections`           | 8       | 同時接続数上限                           |

固定値（設計で確定）: ペアリング秘密値は128ビット乱数・120秒有効・一度だけ・許可 Origin 紐付け。

## Development

```bash
vp test
vp run build
vp run start
```
