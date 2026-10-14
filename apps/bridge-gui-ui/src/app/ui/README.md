# UI基盤の helm 部品（spartan/ui のコピー品）

取得元: `spartan-ng/spartan` のタグ `v1.6.3`（`libs/helm/<部品>/src`）。
ライセンス: MIT（`spartan-ng/spartan` の `LICENSE` に従う）。

## 取り込み一覧

- `utils/`: `hlm.ts`・`provide-spartan-hlm.ts`・`index.ts`
- `button/`: `hlm-button.ts`・`hlm-button.token.ts`・`index.ts`
- `accordion/`: `hlm-accordion.ts`・`hlm-accordion-item.ts`・`hlm-accordion-content.ts`・`hlm-accordion-content-lazy.ts`・`hlm-accordion-trigger.ts`・`index.ts`
- `card/`: `hlm-card.ts`・`hlm-card.token.ts`・`hlm-card-action.ts`・`hlm-card-content.ts`・`hlm-card-description.ts`・`hlm-card-footer.ts`・`hlm-card-header.ts`・`hlm-card-title.ts`・`index.ts`
- `separator/`: `hlm-separator.ts`・`index.ts`
- `badge/`: `hlm-badge.ts`・`index.ts`
- `input/`: `hlm-input.ts`・`index.ts`
- `tabs/`: `hlm-tabs.ts`・`hlm-tabs-list.ts`・`hlm-tabs-trigger.ts`・`hlm-tabs-content.ts`・`hlm-tabs-content-lazy.ts`・`index.ts`

`.spec.ts` は取り込まない。`ng-package.json` の示す `src/index.ts` の内容は各 `index.ts` に写した。

## 改変点

- `import` の `@spartan-ng/helm/utils` はローカルの `../utils/hlm` への相対 import に書き換えた。
- `provide-spartan-hlm.ts` の doc 内の使用例もローカル配置に合わせて直した。
- `brain`（`@spartan-ng/brain/<entry>`）・`clsx`・`tailwind-merge`・`class-variance-authority`・`@ng-icons` の参照はそのまま使う。

## 意匠表（`spartan-nova.css`）

部品テンプレートが載せる `spartan-*` という素の意匠名の実値は、同梱の
`spartan-nova.css` が与える。取得元は `spartan-ng/spartan` のタグ `v1.6.3`
（`libs/registry/src/styles/style-nova.css`、MIT）のうち、この単位の7部品の
節だけを抜粋したもの。nova は上流の既定意匠（単一意匠の基準）である。
文書用の `@scope` の入れ子（複数意匠の見本用）は単一意匠の本品には要らない
ため外し、大域の素の規則として置く。`tabs` の paginated 変種の節は部品ごと入れない。

## 取捨

- `tabs` の `hlm-tabs-paginated-list.ts` は取り込まない。ページネーション付きタブ頭は `@spartan-ng/helm/button`・`@angular/cdk/observers`・`rxjs` への追加依存と独自の描画機構を持ち込み、この単位の最小基盤には要らないため。必要になった単位で取り込む。
- `tabs` と `accordion` の `*-content-lazy` は残す。遅延内容の器だけであり依存を増やさないため。
- `<ng-icon>` を使うのは `accordion` の `hlm-accordion-trigger.ts` のみ。全アイコン登録や文字列からの任意解決、外部配信はしない。
- `sidebar`・`navigation-menu`・`dialog`・`data-table` 等はこの単位の範囲外であり入れない。

## 部品の再配置やシェル実装は後続担当

この単位では配置と基盤の成立だけを扱う。既存画面への組み込みは行わない。
