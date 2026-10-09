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
- 対話命令: `accept open` / `accept close` / `pending` / `approve <requestId> <code>` / `reject <requestId>` / `status` / `connections` / `disconnect <connectionId>` / `quit`。
- 接続の流れ: ワールド側で接続を開始するとブリッジが数字6桁の比較コードを発行して両画面に表示し、人間が `pending` で照合して `approve <requestId> <code>` で承認する。切断で認可は失効し、再接続は再承認である。
- `status` と `connections` は接続ID・Origin・認証状態の一覧を出す。比較コードは `pending` の明示表示にだけ出し、接続一覧には出さない。
- `disconnect <connectionId>` は指定接続だけを `1008`・固定 reason `operator disconnect` で切断する。待ち受けと他接続は維持する。不明IDは明示エラーとし、全切断へは fallback しない。
- 診断ログは標準エラーへ JSON 1行で出す。比較コードは標準出力の `pending` 表示にだけ出し、ログ・URL・query・永続保存には出さない。
- 受信上限の超過は close 1009 で通知する。JSON の明示エラーや非空 reason は保証しない。

## B1 の計測用暫定値

有限・設定可能な値であり、合意値・性能保証ではない。値の正本は
`src/config.ts` の `DEFAULT_LIMITS` とし、ここでは値を再掲しない。
`BridgeOptions.limits` で上書きでき、計測時の実効設定は証拠に記録する。
検証計画は `../../docs/verification/bridge.md` を見る。

固定値: 比較コードの形式・期限・上限・レートの正本は `src/config.ts` の
`DEFAULT_LIMITS` と `bridge-protocol` の定義・検証（`PAIRING_CODE_LENGTH`・`isPairingCode`・`formatPairingCode`）を見る。比較コードは暗号学的乱数による数字6桁であり、OTP 認証ではない。承認は接続単位であり、切断で失効する。

## Development

```bash
vp test
vp run build
vp run start
```
