# world-client

ワールド内からブリッジへ接続するためのクライアントライブラリ。

形状の正本は `../bridge-protocol/src/messages.ts` の型、境界検証は `../bridge-protocol/src/validate.ts`、動的契約はテストとする。上位の設計判断は `../../design/protocol.md`・`../../design/bridge.md`、検証計画は `../../docs/verification/bridge.md` を見る。

- 接続開始は `createConnectionRequest` が返す2つの約束（比較コード表示とセッション管理口）で行う。業務 request/response 相関・自動再送・要求待機は持たず、上位層の責務とする。
- 認可後は同一 WebSocket 上の yamux で Session を送受信する（`data` 一本化）。切断・GoAway で全 Session を終端し、未決着の送信は結果不明として拒否する（二重決着しない）。処理済みかは確定しない。切断後の再接続には再ペアリングが必要である。

## Development

```bash
vp test
vp pack
```
