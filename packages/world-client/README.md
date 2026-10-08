# world-client

ワールド内からブリッジへ接続するためのクライアントライブラリ。

仕様の正本は `../../design/bridge-v0.md`、`../../design/protocol-v0.md`、`../../design/verification-v0.md` とする。

- 切断時は close code を通知し、未完了要求を結果不明として破棄する。処理済みかは確定しない。
- reliable 送信待機の上限は件数（`maxPendingReliable`、既定128件）のみである。

## Development

```bash
vp test
vp pack
```
