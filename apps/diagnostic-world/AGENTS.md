# 診断ワールド開発時の注意点

- 公式 XRift ワールドテンプレート（`WebXR-JP/xrift-world-template@05abcf6`）の最小化である。
  `Skybox`・画像・装飾・壁・影・独自 Canvas／物理エンジン生成を持たない。
- 本番公開（`src/index.tsx` の `./World`）は in-world 診断操作盤
  （`src/components/DiagnosticBoard.tsx`）を含む。XRift 公開 API
  （`Interactable`・`TextInput`・3Dメッシュ＋文字板）だけで作り、新しい
  Canvas／Physics／XRiftProvider を生成しない。通信・集計は UI 非依存の
  `DiagnosticSession` を共用する。DOM 要素は持たない。
- DOM 診断パネル（`src/components/DiagnosticPanel.tsx`）と文字入力の対話板
  （`src/components/DevTextInputDialog.tsx`）は開発エントリ（`src/dev.tsx`）専用であり、
  本番 `./World` から import しない。ホスト DOM の探索・改変はしない。
  drei `Html`（ホスト接続要素へ append する実装のため）と uikit `Input`
  （隠し input を `document.body` に追加する実装があるため）は採用しない。
- 初回のテスト実行前に `bridge-protocol` のビルドが必要（`world-client` と同じ）。
- 秘密値は `TextInput` の `value`／`initialValue` に渡さず、入力完了値を直接
  `connect` に渡すだけで、盤の表示状態・同期状態に保持しない。入力欄は覆い隠し
  （開発対話板は `password`）とし、永続保存・URL・console・証拠に入れない。
  秘密値・診断状態を `useInstanceState` 等で他利用者へ同期しない。
- 文字表示用の外部フォント取得を増やさない（状態板は分離 canvas の system font 描画）。
- `world-client` の `connect` 待機は診断用 120 秒（`DIAGNOSTIC_CONNECT_TIMEOUT_MS`）。
  bridge の認証待ち制限・秘密値の有効期限（120秒）は変更しない。
- セッションの生成・購読・破棄の所有は `useDiagnosticSession` の effect が持つ。
  描画時の生成物を effect が破棄する構成（StrictMode 再実行で破棄済み個体へ
  再購読する）は採らない。
- 共有設定は公式テンプレートと同一にする。パネル・シーン自体は drei・uikit を
  import しないが、`@xrift/world-components` が内部で参照するため、依存・設定とも置く。
