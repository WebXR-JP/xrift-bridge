# diagnostic-world

XRift とローカルブリッジの接続を診断するワールド（開発検証用、C1）。

上位の設計判断は `../../design/bridge.md`・`../../design/protocol.md`、検証計画は `../../docs/verification/bridge.md` を見る。ここでは契約の複製を作らない。

## 構成

- `src/World.tsx` — 最小シーン（床・collider・SpawnPoint・in-world 診断操作盤）。
  Skybox・画像・装飾・壁・影なし。Canvas・物理エンジン・XRiftProvider は生成しない。
- `src/index.tsx` — 本番公開（Module Federation `./World`）。DOM 要素は含まない。
  操作盤は XRift 公開 API（`Interactable`・`TextInput`・3Dメッシュ＋文字板）で作り、
  通信・集計は UI 非依存の `DiagnosticSession` を共用する。
- `src/components/DiagnosticBoard.tsx` — 本番の in-world 操作盤。接続先表示・
  ポート変更・接続開始と比較コード表示・認証状態と失敗理由・echo／ping・明示的切断・
  環境とビルド識別子の表示を持つ。比較コードは表示のみに使い、表示状態・同期状態・証拠に保持しない。
- `src/dev.tsx` — 開発エントリ（`XRiftProvider`＋`DevEnvironment`＋診断パネル）。
  文字入力は既定実装（console・`window.prompt`）ではなく、自ツリーの対話板で
  受け付ける開発用アダプター（ログなし・覆い隠し）を注入する。
- `src/diagnostic/session.ts` — React/R3F 非依存の診断手順（接続・echo・ping・証拠化・後片付け）。
- `src/diagnostic/useDiagnosticSession.ts` — セッションの React 結合。
  生成・購読・破棄の所有は effect が持つ（StrictMode 再実行・再マウントで残留しない）。
- `src/diagnostic/endpoint.ts`・`display.ts`・`env.ts` —
  接続先・表示文言・環境採取の UI 非依存の共用部品（DOM パネルと in-world 盤で共用）。
- `src/components/DiagnosticPanel.tsx` — PC 向け操作盤（開発専用、自ツリーのみ、ホスト DOM 不可侵）。
- `src/components/DevTextInputDialog.tsx` — 開発用の文字入力の対話板（開発専用）。
  本番 `./World` から import しない。
- `xrift.json` — 提出宣言。`permissions.allowedDomains` は `127.0.0.1` のみ、
  `allowedCodeRules` は `no-network-without-permission`（WebSocket）のみ。
  clipboard・storage 系 API は使わない（コピーは手動選択、保存は JSON ダウンロード）。

## 起動

```bash
# 1) ブリッジ（明示開発モードで開発 Origin を許可）
vp run bridge-cli#build
node apps/bridge-cli/dist/index.mjs --dev --origin http://localhost:5173
# ブリッジの対話命令で受付を開く
#   accept open

# 2) 診断ワールド（http://localhost:5173 固定。競合時は失敗し退避しない）
vp run diagnostic-world#dev
```

ブラウザで `http://localhost:5173` を開き、パネルで接続を開始するとワールド画面に比較コードが表示される。ブリッジの `pending` 表示と照合し、ブリッジ側で `approve <requestId> <code>` を入力して承認する。
接続待機は診断用に 120 秒。期限切れ・拒否・切断後は新規に接続を開始すること（再接続の自動承認はしない）。

## 検証

```bash
vp run diagnostic-world#check
vp run diagnostic-world#test
vp run diagnostic-world#build
```

実ブラウザでの接続確認（LNA・混合コンテンツ・審査）は C2/C3 の範囲であり、
このパッケージのテストは手順・表示・後片付けの論理をスタブで検証する。
