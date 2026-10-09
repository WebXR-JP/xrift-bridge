# world-client

ワールド内からブリッジへ接続するためのクライアントライブラリ。

仕様の正本は `../../design/bridge-v0.md`、`../../design/protocol-v0.md`、`../../design/verification-v0.md` とする。

- 切断時は close code を通知し、未完了要求を結果不明として破棄する。処理済みかは確定しない。
- reliable 送信待機は最大 `maxPendingReliable` 件（既定128件）であり、各メッセージは受付前に `maxMessageBytes`（既定65536 bytes、UTF-8 シリアライズ全体）の検査を受ける。超過はローカルで明示エラーにし、待機枠・クレジット・連番を消費しない。待機総バイトの独立上限は設けない。

## Development

```bash
vp test
vp pack
```
