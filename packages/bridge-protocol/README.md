# bridge-protocol

ワールド内クライアントとブリッジ間で共有するプロトコル定義。

形状の正本は `src/messages.ts` の型、境界検証は `src/validate.ts`、動的契約はテストとする。上位の設計判断は `../../design/protocol.md`・`../../design/bridge.md`、検証計画は `../../docs/verification/bridge.md` を見る。

## Development

```bash
vp test
vp pack
```
