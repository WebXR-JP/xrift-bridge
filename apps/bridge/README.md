# bridge

PC上で動作するワールドとローカルをつなぐ中継アプリ。

形状の正本は `../../packages/bridge-protocol/src/messages.ts` の型、境界検証は `../../packages/bridge-protocol/src/validate.ts`、動的契約はテストとする。上位の設計判断は `../../design/bridge.md`・`../../design/protocol.md`、検証計画は `../../docs/verification/bridge.md` を見る。制限値の正本は `src/config.ts` の `DEFAULT_LIMITS` とする。

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

有限・設定可能な値であり、合意値・性能保証ではない。値の正本は
`src/config.ts` の `DEFAULT_LIMITS` とし、ここでは値を再掲しない。
`BridgeOptions.limits` で上書きでき、計測時の実効設定は証拠に記録する。
検証計画は `../../docs/verification/bridge.md` を見る。

固定値: ペアリング秘密値の乱数長・有効期間は `src/config.ts` の
`PAIRING_SECRET_BYTES`・`PAIRING_TTL_MS` を見る。一度だけ使い、許可 Origin に紐付ける。

## Development

```bash
vp test
vp run build
vp run start
```
