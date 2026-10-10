# world-client

ワールド内からブリッジへ接続するためのクライアントライブラリ。

形状の正本は `../bridge-protocol/src/messages.ts` の型、境界検証は `../bridge-protocol/src/validate.ts`、動的契約はテストとする。上位の設計判断は `../../design/protocol.md`・`../../design/bridge-connection.md`、検証計画は `../../docs/verification/bridge-connection.md` を見る。

- 接続開始は `createConnectionRequest` が返す `{pairingInfo, sessionProvider}` の2つの約束で行う。`pairingInfo` は比較コード表示用、`sessionProvider` は認証完了後の `SessionProvider` である。業務 request/response 相関・自動再送・要求待機は持たず、上位層の責務とする。
- 認可後は同一 WebSocket 上の yamux で `SessionProvider.tryCreateSession({sessionId, kind, direction})` により `Session` を開いて送受信する（`data` 一本化）。`Session` は `kind`・`direction` で判別する合併であり、`reliable`（双方向）は `sendReliable` と `onMessage`、`latest`（一方向）は送信側（client は `to_server`）が `sendLatest` のみ・受信側（`to_client`）が `onMessage` のみを持つ。`tryCreateSession` は要求の組合せに応じた枝の型で返し、相手起点の `onSession` は合併を返すため `kind`・`direction` で絞ってから使う。`sendReliable` は `Promise<void>`（ローカル送信完了で解決）、`sendLatest` は同期受付（戻りは配送完了を意味しない）。切断・GoAway で全 Session を終端し、未決着の送信は結果不明として拒否する（二重決着しない）。処理済みかは確定しない。切断後の再接続には再ペアリングが必要である。形状の詳細は `src/session.ts` の `SessionProvider`・`Session` と `../bridge-protocol/src/transport/session-types.ts` の公開型を正本とする。

## Development

```bash
vp test
vp pack
```
