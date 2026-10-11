# bridge-gui（Electrobun 実現性スパイク・段0〜2）

XRift Bridge の管理画面。Electrobun 2.x＋Bun main を前提とする。
設計の正本は `design/bridge-app.md`（三層責務・GUI 境界）である。

## 版の記録

- Electrobun 2.0.2（`hutch.config.ts` の exact pin。stable テンプレートの検証済み版と同一）
- Hutch 0.27.1（`hutch.config.ts` 先頭の pragma に固定）
- Bun 1.4.0（Hutch 管理の同梱 toolchain。`~/.hutch/toolchains/bun/1.4.0/macos-arm64/bun`。
  取得元は Hutch の toolchain 配布であり、別途 install しない。
  `~/.bun/bin/bun`（1.3.14）は使わない）
- Cottontail 0.7.1（`hutch.config.ts` の pragma に残るが、段1以降の main 実行時は使わない。
  段0〜1の前半で Webview→main の RPC request が届かない不成立を確認した版）
- pnpm 12.10.1／Node v22.22.3（動作確認時の版）
- 古い Bun 前提の scaffold とは混ぜない。`electrobun.config.ts` が設定ファイル名である。

## 前提操作

依存はルート pnpm に一本化する。独立 lockfile・`node_modules` は持ち込まない。

```sh
# ルートで依存を入れる（初回・package.json 変更時）
pnpm install
# 上流をビルドしてから GUI を起動する（段2以降で backend が参照するため）
vp run -r build
# Hutch の生成物（.hutch/devkit）を用意する（初回・pin 変更時）
pnpm --filter bridge-gui gui:prepare
```

`hutch` が `PATH` に無い環境では `export PATH="$HOME/.hutch/bin:$PATH"` を足すこと
（`gui:prepare`・`gui:run`・`gui:build` は `hutch` 呼び出しのため）。

`apps/bridge-gui/.hutch/`・`build/`・`artifacts/` は生成物のためコミット対象外である。

## 入口

`vp run -r build`・`vp test`・`vp check` を壊さないため、通常の再帰 build
（`build`＝型検査のみ）に Hutch のネイティブ包装を混ぜない。判断理由は
`hutch.config.ts` の ADR コメントを参照。GUI の起動・包装は opt-in の入口を使う。

```sh
pnpm --filter bridge-gui gui:run    # 開発実行（単発。起動前に dev ビルドする）
pnpm --filter bridge-gui gui:dev    # 開発実行（監視付き再起動・再ビルド）
pnpm --filter bridge-gui gui:build  # 配布用に包装（stable）

# ローカル開発ワールド（http://localhost:5173）から接続して確認する場合
BRIDGE_GUI_DEV_ORIGINS=http://localhost:5173 pnpm --filter bridge-gui gui:run
```

`gui:run` は起動前に `hutch electrobun build --env=dev` で dev バンドルを作り直す。
`hutch electrobun run` 単体は既存バンドルを使い回すため、**ソース変更後に
`hutch electrobun run` だけを実行すると古い画面が動く**（実測で踏んだ罠である）。
上流（`bridge-server` 等）を変えた場合は先に `vp run -r build` すること。

許可 `Origin` は既定で `PRODUCTION_ORIGIN` のみである。追加は環境変数
`BRIDGE_GUI_DEV_ORIGINS`（カンマ区切り）の明示設定に限る。管理操作として
`Origin` を編集する口は公開しない。

## 構成（段2時点の最小実結線）

```text
apps/bridge-gui/
  package.json hutch.config.ts electrobun.config.ts tsconfig.json
  src/main/index.ts        # バックエンド組立て、終了集約、RPC接続
  src/main/backend.ts      # bridge-server＋bridge-app-core の組立て（GuiBackend）
  src/main/rpc.ts          # main 側 RPC 定義（表示DTOと限定操作のみ）
  src/shared/management.ts # 表示DTO・限定操作の型（実行時依存なし）
  src/mainview/index.html  src/mainview/index.ts  src/mainview/index.css
  tests/management.test.ts # revision 採用規約の単体検証
  tests/backend.test.ts    # backend 直接の統合検証（実WS・既存ws・yamux）
  records/                 # 段1の独立起動ログ（証拠）
```

- Webview へ関数や生オブジェクトを渡さず、表示データ（DTO）と限定操作だけを RPC で渡す。
- 比較コード本文は snapshot に載せない。選択した保留だけが限定 request
  （`getPairingView`）で取得する。比較コード本文・業務 payload はログに残さない
  （revision 番号と操作名のみ記録）。
- 状態同期の規約: Webview は更新ハンドラ登録後に `getSnapshot()` し、
  単調増加の revision が新しいときだけ採用する（`selectNewer`）。
  main→Webview の通知は `stateChanged` 一種類で最新の全状態を送る。
  画面再読込みで再取得する（履歴・再送基盤は作らない）。
- 受付は有効／無効の切替えのみとし、保留に期限・残時間表示は無い。承認可否は
  常に server が決める。コード一致による自動承認はしない。
- `assignDiagnostics` はスパイク専用の明示操作である（開始通知での自動割当ては
  しない。恒久採用は別判断）。

## 終了処理

終了経路を `GuiBackend.close()` に集約し、冪等にする。終了中は新規操作を拒否し、
受付を無効化 → `core.close()` → `await server.close()` → 購読・タイマー解除の順で
後始末する。

`before-quit` は Promise を待たないため、同期的に終了を取消し、後始末完了後に
終了を再要求する。最後の窓を閉じる際も `will-close` を同様に制御し（再要求は
`requestClose`）、非同期後始末を素通りさせない。生成前の終了要求には窓を作らず
後始末へ回す。

## 実現性スパイクの記録（段0〜2・2026-10-11）

- 段0: 足場は成立。`hutch electrobun prepare` で devkit を再現でき、
  `tsc`・`vp run -r build`・`vp test`・`vp check` が通る。
  独立 lockfile（`hutch.lock`）・持ち込み `node_modules` は無い。
- 段1: Bun main へ切り替えて独立起動3回で往復成立を確認した（`records/seg1-run*.log`。
  当該ログは `*.log` 無視のためリポジトリに含まれず、ローカル参照である）。
  各回とも `getSnapshot` 応答の Webview 到達・`viewReady` の main 到達・
  main push 3回での revision 3到達・同一 revision 再取得の無視を、
  main ログと Webview 側の受信・採用記録の両方で確認した。
  途中で画面側の選択子重複（`##revision`）による表示失敗を見つけ、呼び出し側を
  修正した。以降の2回は異常ログ無しである。Cottontail 0.7.1 での RPC 不成立の観測
  （Webview→main の RPC 要求が `RPC request timed out.` になる。無改変の公式
  `notes-app` でも再現）は、当該組合せ依存を示唆する所見として
  検証計画（`docs/verification/bridge-app.md`「観測・解釈・未確認の整理」）に残し、
  別版調査を行わず記録のみとする。
- 段2: `GuiBackend`（同一 main プロセス内で `createBridgeServer` 既定 port 3100・
  `PRODUCTION_ORIGIN` → `createBridgeAppCore`）で最小実結線した。
  `tests/backend.test.ts`（backend 直接・実 WebSocket・既存 `ws`・yamux）が通る:
  受付→比較コード取得→誤コード拒否→承認→Session 生成→診断割当て→
  echo 同形返送・ping→pong→運用切断で一覧除外→再接続で新要求・再承認
  （承認前の管理口未解決を含む）、未割当て reliable への送信中断、
  引数・終了中検証、終了後の同一ポート再束縛（待受解放の証明）。
- 段2発煙（`records/seg2-smoke.log`。同ログは `*.log` 無視のためリポジトリに含まれず、
  ローカル参照である）: Bun main で実バックエンドが `3100` 待受けし、
  遷移規則下で管理画面の読込み・`getSnapshot`・`viewReady` が通ることを確認した。
  SIGTERM 経路では取消し→後始末（`shutdown` 記録）→再要求で待受ポートが解放され、
  アプリ固有プロセスの残存が無いことを確認した。
- 目視確認（画面描画・操作フロー・閉窓経路の終了）は
  人間の GUI セッションで行うこと（下記の人間確認待ち）。
  比較コード本文・業務 payload をログに残さない運用は変えないこと。
- 段5・段6（2026-10-11）: stable 包装を生成し、配布物からの起動で
  `getSnapshot`／`viewReady` の往復（main 側記録）・正常終了（待受解放・残存なし）を
  確認した。寸法・メモリ・起動時間を初期計測した（条件・絶対値・未確認の分離を含む）。
  詳細は検証計画（`docs/verification/bridge-app.md`「Electrobun スパイクの記録（段5〜6）」）を正本とし、
  生ログは `records/seg5-*.log`・`records/seg6-*.log`
  （`*.log` 無視のためリポジトリに含まれないローカル参照）に残す。

## 人間確認待ち

GUI 目視・GUI 操作が要るため、この環境では未確認である。人間の GUI セッションで
以下を確認すること。判定材料の確定値は検証計画
（`docs/verification/bridge-app.md`「人間の判断に必要な材料」）にまとめてある。

- 管理画面の描画（状態・受付・保留・接続・セッション・割当て・受信記録）。
- 受付の有効化・無効化、保留の比較コード表示、目視照合後の承認・取り下げ、
  接続の切断、セッションへの診断割当て、アプリ終了ボタン。
- 操作後の `stateChanged` push による表示更新（改訂番号の進行）。
- ローカル開発ワールドとの往復（開発実行で確認する場合）:
  1. `BRIDGE_GUI_DEV_ORIGINS=http://localhost:5173 pnpm --filter bridge-gui gui:run`
     で GUI を起動する。
  2. 別ターミナルで `vp run diagnostic-world#dev` を起動し、ブラウザで
     `http://localhost:5173` を開く。
  3. ワールドの操作盤から接続を開始し、表示された比較コードを GUI の保留表示と
     目視照合して承認する。
  4. 認可後、GUI でセッションへ診断を割り当て、ワールド側の echo/ping を確認する。
  5. 固定テキスト送信の入力欄と表示板の往復は、次の段（mainview のUI）で確認する。
- 配布物（`build/stable-macos-arm64/XRift Bridge.app`。dmg は `artifacts/`）からの起動手順:
  1. `open "apps/bridge-gui/build/stable-macos-arm64/XRift Bridge.app"` で起動する。
     初回は自己展開（`Application Support/net.xrift.bridge-gui` への書込み）が入る。
  2. 管理画面で保留の比較コードを目視照合して承認し、診断割当て後の echo/ping 往復を確認する。
  3. 終了後に `nc -z 127.0.0.1 3100` が失敗することと、Activity Monitor 等で
     `XRift Bridge` が残っていないことを見る。
- 閉窓・通常終了で待受ポート（`3100`）が解放され、プロセスが残らないこと。
  手順: 終了後に `nc -z 127.0.0.1 3100` が失敗することと、Activity Monitor 等で
  `XRift Bridge` が残っていないことを見る。
- 可視 Webview 条件下でのメモリ・起動時間の再測定（採用判断の材料。窓なし条件の値は計測済み）。
