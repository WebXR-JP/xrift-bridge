# bridge-gui-main（Electrobun 実現性スパイク・段0〜2）

XRift Bridge の管理画面。Electrobun 2.x＋Bun main を前提とする。
管理画面（mainview）の正本は Angular 実装（`apps/bridge-gui-ui`）である。
設計の正本は `design/bridge-app.md`（三層責務・GUI 境界）である。
標準の GUI 手順は設計の移行節（「管理画面の Angular 移行（設計変更）」）に従う。

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
# Hutch の生成物（plugin 閉包の dist と各パッケージの devkit）を用意する
# （初回・pin 変更時。`electrobun/*` の型解決と hutch の config 読込みに要るため
# `vp run -r build` より先に行う。plugin 閉包の build は依存順で回り、
# 各 devkit の用意は plugin の `build` が満たす）
pnpm --filter bridge-gui-main gui:prepare
# 上流の dist を作る（段2以降で backend が参照するため。Angular の production AOT・
# 子画面事前ビルド・staging 生成を含む。plugin の `build` が自前 devkit の再用意を
# 内包するため `hutch` を要求する。初回はネットワーク取得）
vp run -r build
```

`hutch` が `PATH` に無い環境では `export PATH="$HOME/.hutch/bin:$PATH"` を足すこと
（`gui:prepare`・`vp run -r build`（plugin の `build` 経由）・`gui:run`・`gui:build` は `hutch` 呼び出しのため）。

順序を変えると devkit・上流 dist の未生成で `TS2307` になるため、
`gui:run` 等に入る前に上記を済ませること。
fresh 直後でも `vp run -r build` が vp のキャッシュに救われて通る場合がある。
失敗の再現確認はキャッシュ外（`--no-cache`）か `tsc` 直叩きで行うこと。

`apps/bridge-gui-main/.hutch/`・`build/`・`artifacts/` は生成物のためコミット対象外である。

## 入口

`vp run -r build`・`vp test`・`vp check` を壊さないため、通常の再帰 build
（`build`＝型検査＋子画面事前ビルド＋staging 生成）に Hutch のネイティブ包装を混ぜない。判断理由は
`hutch.config.ts` の ADR コメントを参照。GUI の起動・包装は opt-in の入口を使う。
`gui:prepare` は plugin 閉包の build（依存順。各 devkit の用意を含む）と app devkit の用意を
まとめて行うため、`gui:run` 系に入る前に別途プラグイン操作は要らない。

```sh
pnpm --filter bridge-gui-main gui:run          # 開発実行（単発。Angular dev 生成＋dev 包装＋起動）
pnpm --filter bridge-gui-main gui:run:console  # 上記に開発観測（ngDebugProbe）と開発口を足す
pnpm --filter bridge-gui-main gui:build        # 配布用に包装（stable。Angular prod 生成＋stable 包装）

# ローカル開発ワールド（http://localhost:5173）から接続して確認する場合
BRIDGE_GUI_DEV_ORIGINS=http://localhost:5173 pnpm --filter bridge-gui-main gui:run
```

管理画面の実体は `apps/bridge-gui-ui/`（UI 専用に TS 6.0 系を局所固定。
契約型は `bridge-gui-contract` の公開 subpath から再利用し、DTO の重複定義はしない）。
AOT 生成物は UI パッケージ自身の `dist/`（`dist/dev/browser`・`dist/prod/browser`。
dev と prod を別ディレクトリに分け、混在させない。生成物のため無視）に作り、
`gui:run`・`gui:build` が選んだ側を `src/mainview-dist/dev`・`prod` へ写してから
Hutch の `copy` で `views/mainview/` に載せる（ディレクトリごと。将来 chunks／
assets が増えた場合も写し経由で同梱される）。再帰 build には Angular の
production AOT を含める（`tsc --noEmit` だけではテンプレートを検証できない）。
GUI から UI への `workspace:*` ビルド依存を明示し、再帰 build で UI が先行する。
コピー元は環境変数 `BRIDGE_GUI_UI_DIR` で選ぶ（未指定時は prod の写しを既定。
`gui:run` 系は dev、`gui:build` は prod を設定する）。生成物が無ければ包装は
失敗する（存在時のみコピーにしない）。
開発観測は `BRIDGE_GUI_NG_DEBUG=1`（既定無効）である。
Angular 画面の起動時間（main 起動→`viewReady` で測る）・配布物寸法の差分は
未計測である（`ng:build:*` の wall を起動時間としない）。
`ng:build:*` 実行時の `File '../bridge-gui-main/.hutch/devkit/api/browser/global.d.ts'
not found in TypeScript compilation` は既知の非致命の警告である
（終了符号 0 に影響しない。devkit 内の型宣言が ng の編集単位外にあるための表示であり、
型検査は `build`（`tsc --noEmit`）で行う）。

## 開発専用の AI 操作・観測口（`BRIDGE_GUI_DEV_CONSOLE=1`）

AI からの自動操作用の loopback 接続口。Bun main 上で完結し、別プロセスは要らない。
経路は AI → loopback 接続口 → Bun main → 限定 Webview RPC → 共通操作サービス →
既存管理 RPC → backend である。契約の正本は `bridge-gui-contract/dev-console`
（有効条件・認証・許可操作・段階観測・制限値）である。

- 有効条件は三つ: 開発ビルド かつ 明示 opt-in（`BRIDGE_GUI_DEV_CONSOLE=1`）かつ
  隔離実行。**stable は環境変数を設定しても待受を開かない**。
  開発ビルドの判定は包装時チャンネルで行う（dev 包装の `Resources/version.json` が
  `"channel":"dev"`、stable 包装の `Resources/metadata.json` が `"channel":"stable"`。
  devkit の `BuildConfig`（`.hutch/devkit/api/sdks/main/core/BuildConfig.ts`）も
  同じ `channel` を読む）。不明時は閉じたままにする。
  隔離実行は構造で保つ（`127.0.0.1` 束縛・実行ごとの乱数 token・`Origin`／`Host`
  制限・CORS 無効・終了時の閉鎖）。
- 待受は `127.0.0.1` の空きポート自動選択（既存の待受 port 3100 とは別）であり、
  起動時に `port` と実行ごとの乱数 `token` を標準出力に記録する。
- 要求は `POST /dev/op`（本文は JSON の `{ op, params?, correlationId? }`）と
  `GET /dev/status` のみである。認証は `Authorization: Bearer <token>`、
  `Host` は `127.0.0.1` 自身、`Origin` は非ブラウザ（頭なし・空・`null`）か
  待受自身の起点だけを通す。応答に `Access-Control-Allow-Origin` は載せない。
  本文上限は 64 KiB、操作1件の期限は 10 秒（超過時は `504` の定型応答）、DOM 観測の待ち上限は 5 秒である。
- 許可操作は固定 allowlist のみである: `getSnapshot`・受付の有効/無効・
  `getPairingView`・承認/取り下げ・接続切断・汎用プラグインの割当て/解除・
  個体限定の再試行（`retryPluginMount`）。アプリ終了（`quit`）・任意 JS・任意関数名・DOM 全文・
  実体/injector 取得口は持たない。`ng.*` は可否・件数等の補助観測のみである。
  プラグイン操作画面は簡素化後であり、段0スパイク操作と全体再試行は持たない。
  失敗した個体は対象の実インスタンスを指定して再試行し、他個体には触れない。
- 応答は段階を分けて返す: 操作受付（`acceptedAt`）／業務結果の要約／snapshot 採用
  （`snapshotRevision`）／Angular の DOM 反映（`dom`。`ngDevObserve` の到達を観測と
  し、RPC 成功や rAF を描画完了とは呼ばない）／native 画素観測（`native`。
  Webview 単体の取得は未対応の定型で返し、後続単位に委ねる）。
  DOM 反映の観測は固定要素キー・矩形・表示/disabled・`document.hasFocus()`・
  activeElement キーに限る。比較コード取得の要約は有無だけに落とし、取得からの
  自動承認はしない（承認は独立操作として呼ぶ）。
- 秘密（比較コード本文・業務 payload・テキスト本文）をログ・生成物・応答に残さない。
  `token` は実行時の標準出力にだけ記録し、終了処理（`GuiBackend.close()` と同じ
  終了経路）で待受を必ず閉じる。

```sh
pnpm --filter bridge-gui-main gui:run:console  # dev 包装＋開発口で起動
# 起動記録の port・token を見て curl 等で叩く（例: 受付の無効化）
curl -s -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"op":"disableAcceptance","correlationId":"probe-1"}' \
  http://127.0.0.1:<port>/dev/op
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
apps/bridge-gui-main/
  package.json hutch.config.ts electrobun.config.ts tsconfig.json
  src/main/index.ts        # バックエンド組立て、終了集約、RPC接続
  src/main/backend.ts      # bridge-server＋bridge-app-core の組立て（GuiBackend）
  src/main/rpc.ts          # main 側 RPC 定義（表示DTOと限定操作のみ）
  src/mainview-stub.ts     # Hutch view 用の最小スタブ（実体は Angular 生成物の写し）
  src/mainview-dist/dev    # Angular dev 生成物の写し（`gui:run` 系が作る。生成物のため無視）
  src/mainview-dist/prod   # Angular prod 生成物の写し（`gui:build` が作る。生成物のため無視）
  ../../packages/bridge-gui-contract/src/management.ts # 表示DTO・限定操作の型（実行時依存なし）
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
- 現状のファイル構成はコードを正本とする。上記は段2時点であり、
  開発口（`src/main/dev-console.ts`）・プラグイン埋込み等のモジュールが増えている。

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
  受付→比較コード取得→要求 ID だけの承認→Session 生成→診断割当て→
  echo 同形返送・ping→pong→運用切断で一覧除外→再接続で新要求・再承認
  （承認前の管理口未解決を含む）、未割当て reliable への送信中断、
  引数・終了中検証、終了後の同一ポート再束縛（待受解放の証明）。
- 段2発煙（`records/seg2-smoke.log`。同ログは `*.log` 無視のためリポジトリに含まれず、
  ローカル参照である）: Bun main で実バックエンドが `3100` 待受けし、
  遷移規則下で管理画面の読込み・`getSnapshot`・`viewReady` が通ることを確認した。
  SIGTERM 経路では取消し→後始末（`shutdown` 記録）→再要求で待受ポートが解放され、
  アプリ固有プロセスの残存が無いことを確認した。
- 目視確認（画面描画・操作フロー・閉窓経路の終了）は
  人間の GUI セッションで実施済みである（下記の人間確認の記録）。
  比較コード本文・業務 payload をログに残さない運用は変えないこと。
- 段5・段6（2026-10-11）: stable 包装を生成し、配布物からの起動で
  `getSnapshot`／`viewReady` の往復（main 側記録）・正常終了（待受解放・残存なし）を
  確認した。寸法・メモリ・起動時間を初期計測した（条件・絶対値・未確認の分離を含む）。
  詳細は検証計画（`docs/verification/bridge-app.md`「Electrobun スパイクの記録（段5〜6）」）を正本とし、
  生ログは `records/seg5-*.log`・`records/seg6-*.log`
  （`*.log` 無視のためリポジトリに含まれないローカル参照）に残す。
- その後の Angular 移行は完了した（mainview 限定。契約＋設計 `d1179a4`、基盤 `379a632`、
  管理機能 `8983d68`、子画面 `51e3c81`、AI 観測口 `0ace1f0`、既定切替・vanilla 削除 `5e811ae`）。
  既定の管理画面は Angular（`views://mainview/index.html`）であり、vanilla は削除済みである。
  詳細は設計（`design/bridge-app.md`「管理画面の Angular 移行（設計変更）」）と
  検証計画（`docs/verification/bridge-app.md`「Angular 移行の完了記録」）を正本とする。

## 人間確認の記録（2026-10-11 確認済み）

人間の GUI セッションで以下を確認済みである。判定材料の確定値は検証計画
（`docs/verification/bridge-app.md`「人間の判断に必要な材料」・「Angular 移行の完了記録」）にまとめてある。

- 管理画面の描画（状態・受付・保留・接続・セッション・割当て・受信記録。カード等の見た目・CSS を含む）。
- 保留の比較コード表示と目視照合→承認・取り下げ、接続の切断、
  生存セッションへの診断割当て（テキスト表示用は対象外表示）、固定テキストカード、子画面埋込み、終了。
- 操作後の `stateChanged` push による表示更新（改訂番号の進行）。
- ローカル開発ワールドとの往復の再現手順:
  1. `BRIDGE_GUI_DEV_ORIGINS=http://localhost:5173 pnpm --filter bridge-gui-main gui:run`
     で GUI を起動する。
  2. 別ターミナルで `vp run diagnostic-world#dev` を起動し、ブラウザで
     `http://localhost:5173` を開く。
  3. ワールドの操作盤から接続を開始し、表示された比較コードを GUI の保留表示と
     目視照合して承認する。
  4. 認可後、GUI でセッションへ診断を割り当て、ワールド側の echo/ping を確認する。
  5. 固定テキスト送信の入力欄と表示板の往復は、検証計画の人間確認手順で行う。
- 子画面マウントの半自動検証：マウント前に窓をクリックして操作対象にしてから操作する。失敗時は窓をクリックしてから対象個体の「再試行」を押す。`activate`・`open -a`・System Events の frontmost 到達を成功条件にしない。

残る未確認は以下である。

- 配布物（`build/stable-macos-arm64/XRift Bridge.app`。dmg は `artifacts/`）からの導線:
  1. `open "apps/bridge-gui-main/build/stable-macos-arm64/XRift Bridge.app"` で起動する。
     初回は自己展開（`Application Support/net.xrift.bridge-gui` への書込み）が入る。
  2. 管理画面で保留の比較コードを目視照合して承認し、診断割当て後の echo/ping 往復を確認する。
  3. 終了後に `nc -z 127.0.0.1 3100` が失敗することと、Activity Monitor 等で
     `XRift Bridge` が残っていないことを見る。
- 可視 Webview 条件下でのメモリ・起動時間の再測定（採用判断の材料。窓なし条件の値は計測済み）。
