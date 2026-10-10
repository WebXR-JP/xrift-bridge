# bridge-server

PC上で動作するブリッジのサーバーコア。GUI/CLI が利用する管理境界。

サーバーコアの正本はここにあり、実行アプリは `../../apps/bridge-cli` が担う。形状の正本は `../bridge-protocol/src/messages.ts` の型、境界検証は `../bridge-protocol/src/validate.ts`、動的契約はテストとする。上位の設計判断は `../../design/bridge.md`・`../../design/protocol.md`、検証計画は `../../docs/verification/bridge.md` を見る。

- 起動は `createBridgeServer` が返す管理口で行う。import しただけでは起動しない。
- 制限値の正本は `src/config.ts` の `DEFAULT_LIMITS` とする。

## Development

```bash
vp test
vp pack
```

初回のテスト実行前に `bridge-protocol` のビルドが必要。
