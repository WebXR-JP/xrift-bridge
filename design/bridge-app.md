# ブリッジアプリ

アプリの三層責務、プラグインと割当ての契約、GUI境界を決める。

形状（型・フィールド名・操作名・定数値）はコードを正本とし、ここでは複製しない。接続認可・切断失効・サーバー管理境界としての公開は[ブリッジ接続](bridge-connection.md)、輸送・配送・方向・終了の契約は[プロトコル](protocol.md)を正本とする。

```mermaid
flowchart LR
    S["生存セッション<br/>(bridge-server が公開)"] -->|"割当て"| P["プラグインインスタンス<br/>(bridge-app-core が管理)"]
    P -->|"埋込み表示"| G["管理画面・比較コード照合<br/>(bridge-gui-ui + bridge-gui)"]
    G --- B["GUIバックエンド<br/>(両者を組み立て)"]
    B --- S
    G --- C["契約<br/>(bridge-gui-contract)"]
```

三層の関係は、公開された生存セッションを割当てで結び、画面に埋め込む大枠である。画面と backend が共有する契約は `bridge-gui-contract` に置く。詳細は本文に置く。

## 三層の責務

| 層                             | 担うこと                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bridge-server`                | 接続前検証・ペアリング・Connection認可・輸送・生存セッションの公開・輸送統計                                         |
| `packages/bridge-app-core`     | プラグイン定義とインスタンス管理、接続口の適合判定、割当て・解除、失効処理、UI非依存の状態と操作、同梱プラグイン     |
| `packages/bridge-gui-contract` | 契約（表示DTO・限定操作・純粋な微少ランタイム）。`management`／`plugin-instance`／`plugin-spike` の subpath を分ける |
| `apps/bridge-gui-ui`           | 管理画面（mainview）の Angular 実装。契約だけを参照する                                                              |
| `apps/bridge-gui`              | 起動・終了、比較コード照合、Angular 画面の包装・表示、プラグインUIの埋込み、デスクトップ機能、画面との通信           |

- `bridge-app-core` はサーバー管理境界を受け取り、GUIライブラリを参照しない。GUIのバックエンドが両者を組み立てる。
- 埋込み画面（Webview）へ `BridgeServer` や生の `Session` を渡さない。表示用データと限定した操作だけを渡す。
- 依存方向は Angular UI・GUI main・vanilla 子画面から contract へ向ける。contract から `bridge-app-core`／`bridge-server` への参照は型のみとし、逆依存は持たない。
- contract に Angular・Electrobun の実体、Bun・Node の実行依存、backend を入れない。contract のビルドを `.hutch` に依存させない。Angular UI から GUI ソースへの相対 import はしない。
- プラグイン UI（`plugin-ui/*`）は当面 vanilla のままとし、プラグイン UI 基盤として Angular を必須にしない。
- mainview の二重実装・フォールバックは恒久化しない。切替え方針は「管理画面の Angular 移行（設計変更）」節を正本とする。

## サーバーが公開するセッション口

- 生存セッションの一覧取得と取得口を `BridgeServer` の管理境界に追加する。
- 管理イベントに、セッション開始・セッション終了・接続状態変更を追加する。
- データの購読・送信・終了は既存の Session API（`onMessage`・`onEnd`・`onRemoteEnd`・`sendReliable`・`abort` 等）を再利用し、サーバー独自の登録機構は設けない。
- サーバー起点のセッション作成は公開しない。
- `sessionId` は別接続でも同一接続の終了後でも再利用され得るため、表示・関連付け情報としてのみ扱い、それだけで古い割当てを識別しない。再利用しないローカルのセッション識別子を別途導入する。
- 契約は以下とする。
  - 認可後のセッションだけを公開する。承認成功や切替中は利用開始ではない。
  - 登録を確定してから開始通知、一覧から除外してから終了通知を行う。終了通知は一度だけとする。
  - Connection の終了開始時に全セッションを失効させる。物理切断待ちまで利用可能にしない。
  - FIN は片方向終了であり、全体終了（`onEnd`）と区別する。
  - 通知は購読者の例外を隔離する。購読から一覧取得で初期同期でき、アプリ側は識別子で重複を除く。
- 名称・型の詳細はコードを正本とし、ここでは複製しない。CLI にもセッション公開は波及するが、GUI 向けの割当て操作は CLI に追加しない。

## プラグイン

- プラグインは本体機能と UI を持ち、UI は埋込み Webview として表示する。
- レシピ的に扱い、複数インスタンスを出せる。
- 初期対象はリポジトリに同梱する信頼済みプラグインに限る。外部の非信頼プラグイン読込みは対象外とする。
- セッションで送受信するデータの内容やプロトコルに、基盤は関心を持たない。

## 接続口と capability

- プラグインは名前付きの接続口を宣言する。各接続口は、受け入れる合法な `kind`・`direction` の組合せを列挙する。二つの独立した集合にはしない。
- 方向は常にワールド・サーバー基準とする。プラグイン基準に読み替えない。
- 現在利用可能な組合せは以下とする。
  - `reliable`・`bidirectional`：PC 側は送受信可能。
  - `latest`・`to_server`：PC 側は受信のみ。
  - `latest`・`to_client`：PC 側は送信のみ。サーバー起点作成をしない今回の範囲では利用不可。
- capability の一致は輸送上の適合にすぎず、データ内容の互換性は保証しない。データの検証・応答相関はプラグインの責務とする。

## 割当て

- 割当てはローカルのセッション識別子からインスタンス識別子と接続口識別子への対応で表す。
- 初期は一対一（一つのセッションに一つの割当て、一つの接続口に一つのセッション）とする。分配・合流は持たない。
- プラグインには割当て期間だけ有効な操作口を渡す。解除後の送信・購読は禁止する。
- 解除・インスタンス削除は対象セッションを中断する。切替えは新しいセッションを使い、未決着通信を混在させない。
- 再接続・同名セッションへ割当てを自動継承しない。
- 未割当ての `reliable` セッションにデータが届いた場合は、理由付きでそのセッションを中断する。GUI 操作待ちの無制限保留や黙った破棄はしない。
- 後から接続するプラグインへの過去値の再配信は保証しない。初期契約は割当て後の受信とする。

## 診断

- 応答確認相当（echo・ping）は `bridge-app-core` の同梱診断プラグインへ移す。プラグイン基盤本体には診断の解釈を持たせない。
- CLI は診断インスタンスを生成・割当てすることで診断用途を維持する。
- 輸送統計から診断 echo・ping の項目を削除する。互換用フィールドは残さない。
- 輸送の keepalive Ping はサーバー側に残す。診断 ping とは別機能である。
- `latest` の記録（内容を解釈しない既存機能）と関連統計は今回維持する。ただし接続をまたぎ切断後も残る記録であり、生存セッションや割当ての判定には使わない。

## 固定テキスト表示

- 固定テキスト表示は `packages/bridge-app-core` の同梱プラグインが行う。接続口は一つで、輸送上の適合は「接続口と capability」節の組合せのうち一つのみ受け付ける。相関・検証・応答期限はプラグイン側の責務とし、サーバー・輸送・基盤本体に追加しない。
- ワールドは認可後に専用セッションを開き、PC からワールドへは相関識別子付きのプレーンテキスト表示要求、ワールドから PC へは同じ識別子の反映確認（本文返送なし）を返す。HTML・Markdown・コマンド解釈はしない。直近一件の置換表示とし、履歴・保存・他利用者への同期はしない。
- 反映確認は「表示用状態に反映した」ことであり、送信 API の成功や描画完了とは区別する。同時実行は一件とし、期限切れ・切断は結果不明として自動再送しない。不正な応答は対象セッションのみ中断し、不正入力は送信前に拒否する。
- 形状・論理名・上限・応答期限・検証規則は契約モジュール（[`packages/bridge-app-core/src/text-contract.ts`](../packages/bridge-app-core/src/text-contract.ts)の公開 subpath）を正本とし、ここでは複製しない。契約モジュールはブラウザ安全な構成とし、ワールドは root import でサーバー依存を引き込まない。公開範囲は[`packages/bridge-app-core/package.json`](../packages/bridge-app-core/package.json)の exports を正本とする。プラグイン本体の振る舞いは[`packages/bridge-app-core/src/plugins/text/plugin.ts`](../packages/bridge-app-core/src/plugins/text/plugin.ts)、ワールド側の受信・表示は[`apps/diagnostic-world/src/text/`](../apps/diagnostic-world/src/text/)を正本とする。
- 割当ては固定プラグイン一種類・同時に一インスタンスとし、開始通知での自動割当てはしない。明示操作でのみ行い、論理名と capability が一致する唯一の候補が全接続を通じて一件だけの場合に割り当て、候補ゼロ・複数は理由付きで拒否する（先着順・一件目・Origin 推測をしない）。解除・インスタンス削除は対象セッションを中断する。再接続後は再承認・新規セッション・新規の明示割当てを要求し、同名でも旧操作口・未完了要求・本文を引き継がない。論理名の一致は内容互換性や真正性の証明ではない。
- 画面は埋込みの子画面（プラグイン UI 埋込み）で行い、管理 Webview 内の暫定 UI は使わない。同じ表示データ・限定操作の境界を再利用する。Webview へ生のサーバー・セッションを渡さない方針を維持し、本文は snapshot・ログ・永続保存に残さない。表示データと限定操作の正本は `bridge-gui-contract` の `management` subpath（[`packages/bridge-gui-contract/src/management.ts`](../packages/bridge-gui-contract/src/management.ts)）、組立ては[`apps/bridge-gui/src/main/backend.ts`](../apps/bridge-gui/src/main/backend.ts)を正本とする。
- 診断割当てはテキスト表示用セッションを対象外とし、テキスト割当てと排他にする。

## 管理画面の Angular 移行（設計変更）

mainview を Angular に本移行する。本節が設計変更の正本であり、他節は本節に従う。

- 移行方針：機能・実 Webview・人間の確認が揃った時点で既定を Angular に切り替え、vanilla mainview（`apps/bridge-gui/src/mainview/`）は削除する。恒久的な二重実装・フォールバックは残さない。
- 契約境界：契約（DTO・限定操作・純粋な微少ランタイム＝`selectNewer`、URL 組立て／解析、navigation-rules 属性値等）を `packages/bridge-gui-contract` へ切り出す。依存方向・禁止は「三層の責務」節を正本とする。
- ビルド：Angular 成果物は UI パッケージ自身の `dist` に生成する。再帰 `build` に Angular production AOT を含める（`tsc --noEmit` だけではテンプレートを検証できない）。GUI から UI への `workspace:*` ビルド依存を明示する。切替え時に URL を `views://mainview/index.html` に統一し、Hutch stub＋成果物コピーへ変える。`BRIDGE_GUI_VIEW`・`mainview-ng`・vanilla の views／copy を削除する。成果物が無ければ失敗させる。コピーは生成された chunks／assets を含める。
- Angular 構造：RPC アダプター（接続・型付き request／push。表示状態や DOM を持たない）／状態・操作サービス（signals で snapshot 採用、初期同期、共通操作処理、実行中／失敗表示、安全な受信記録）／表示コンポーネント（状態要約＋受付＋終了、保留一覧・行、接続一覧、生存セッション、固定テキストカード）／子画面ホスト（実プラグイン配置・失敗・再試行、段0スパイク操作。タグ同一性保持）／開発専用デバッグアダプター。汎用ストア・ルーターは追加しない。比較コードは保留行の一時状態だけに置き、消滅後の遅延取得は再表示しない。子画面は安定領域へ命令的に追加・削除し、revision 更新で再生成しない。スパイクの起動時自動走行は削除する。
- AI 観測口：開発ビルド＋明示 opt-in＋隔離実行の三条件で有効化する。経路は AI → loopback 接続口 → Bun main → 限定 Webview RPC → 共通操作サービス → 既存管理 RPC → backend とする。`127.0.0.1`・実行ごとランダム token・Origin／Host 制限・入力検証・サイズ／期限制限を設け、ブラウザ向け CORS は開かない。stable は環境変数を設定しても待受けを開かない。許可操作と DTO だけを通し、任意 JS・関数名・DOM 全文・実体取得口は持たない。`ng.*` は可否・件数等の補助観測だけに使う。操作受付・業務結果・snapshot 採用・Angular の DOM 反映は別々に返す（RPC 成功や rAF を描画完了と呼ばない）。native 画素観測は自動化の対象外とし、ここでは扱わない。比較コード取得からの自動承認はしない。汎用ジョブ履歴・再送基盤は作らない。
- 描画確認：native 画素観測（`Screen.captureRegion()` 等）と実入力送信（cliclick／System Events 等）の自動化は行わない（非目標）。`Screen.captureRegion()` はデスクトップ矩形で Webview 単体捕獲ではないため採用しない。自動観測は開発専用の操作・観測口による DOM 観測までとし、固定要素キー・矩形・表示／disabled・`document.hasFocus()`・activeElement キーだけを返し、入力値・本文は返さない。描画・フォーカス・操作フローの最終確認は人間の GUI セッションで行う。
- 未確認事項：`@angular/build:unit-test`（Vitest runner）と現 Vite+ override の互換、Hutch のディレクトリコピー可否。native 画素観測・実入力送信の自動化は非目標として確定し、本項目の対象外とする。成立しなければ独自試験基盤を作らず再相談する。

## 対象プラットフォームと GUI 基盤

- 対象は macOS（Apple Silicon）を最優先とする。Electrobun は macOS x64 を提供しないため、Intel Mac は対象外とする。
- GUI 基盤は Electrobun を採用する。実行ランタイムは Bun main、表示は native Webview 1枚とする。Electrobun 既定の Cottontail では Webview→main の RPC が本構成で成立しない観測があり、Bun main で成立することを確認した（観測は[アプリの検証計画](../docs/verification/bridge-app.md)を正本とする）。ベータ段階・単一メンテナというリスクは許容し、埋込み・配布・実行互換に問題が出た場合は Electron へ切り替える。その場合も本節の三層境界は維持する。
- 管理画面（mainview）に Angular を採用する（mainview 限定。プラグイン UI は含まない）。変更検知は zoneless＋signals とする。
- 再帰 `build` に Angular production AOT を含める（`tsc --noEmit` だけではテンプレートを検証できない）。成果物は UI パッケージ自身の `dist` に生成し、GUI から UI への `workspace:*` ビルド依存を明示する。
- native 包装・起動は引き続き opt-in とする。切替え全体は「管理画面の Angular 移行（設計変更）」節を正本とする。
- 非目標は以下とする。サーバー起点のセッション作成、外部の非信頼プラグインの実行、分配・合流、通信途中のプラグイン付替え、認可や割当ての継承、汎用の接続管理 UI・永続化・複数 Webview 管理（後工程）。

## 文書の正本分担

- 本文書：三層の責務、プラグインと割当ての契約、未割当て・解除方針、GUI 境界、非目標、採用理由と見直し条件。
- [ブリッジ接続](bridge-connection.md)：Connection 認可・切断失効、サーバー管理境界としてのセッション公開。
- [プロトコル](protocol.md)：輸送・配送・方向・終了の契約。
- コード：公開型・フィールド・操作名・データ形状。
- テキスト契約 subpath（`packages/bridge-app-core` の公開するテキスト契約）：固定テキスト表示の形状・論理名・上限・応答期限・検証規則。
- 契約パッケージ（`packages/bridge-gui-contract` の `management`／`plugin-instance`／`plugin-spike` subpath）：GUI 契約の形状・検証規則。
- [接続の検証計画](../docs/verification/bridge-connection.md)：接続の検証計画。[アプリの検証計画](../docs/verification/bridge-app.md)：アプリ固有の観測。

## 見直し条件

- 実行情報：Electrobun で直接実行できるならこの構成で進める。別プロセスが必要なら IPC・監視・終了処理の増加を示して再相談する。埋込み・配布・実行互換に問題があれば Electron へ切り替える。境界は維持する。
- 再相談：ローカル操作を行うプラグイン、非信頼コードの実行、分配・合流、通信途中の付替え、認可や割当ての継承が必要になった場合。
- capability の一致を権限判定として扱わない。既存の接続認可はあらゆるローカル操作の包括承認ではない。
- 観測能力：TestBed（`@angular/build:unit-test` の Vitest runner）と現 Vite+ override の互換、Hutch のディレクトリコピー可否は未確認である。成立しなければ独自試験基盤を作らず再相談する。機能移行の完了判断に視覚自動化を含めず、後者を完了扱いしない。native 画素・実入力の自動化が必要になった場合は再検討する。
