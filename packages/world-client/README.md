# world-client

ワールド内からブリッジへ接続するためのクライアントライブラリ。

形状の正本は `../bridge-protocol/src/messages.ts` の型、境界検証は `../bridge-protocol/src/validate.ts`、動的契約はテストとする。上位の設計判断は `../../design/protocol.md`・`../../design/bridge.md`、検証計画は `../../docs/verification/bridge.md` を見る。

- 切断時は close code を通知し、未完了要求を結果不明として破棄する。処理済みかは確定しない。
- reliable 送信待機は最大 `maxPendingReliable` 件であり、各メッセージは受付前に `maxMessageBytes`（UTF-8 シリアライズ全体）の検査を受ける。既定値は `src/client.ts` を正本とし、ここでは値を再掲しない。超過はローカルで明示エラーにし、待機枠・クレジット・連番を消費しない。待機総バイトの独立上限は設けない。

## Development

```bash
vp test
vp pack
```
