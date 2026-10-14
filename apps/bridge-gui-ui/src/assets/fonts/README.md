# 同梱フォント

実行時に外部CDN・ネットワーク取得をしないため、WOFF2をローカルに同梱する。
日本語グリフまで両フォントで揃うとは扱わない（日本語はシステムフォントの fallback で描画する）。

## 入手元

- Inter v4.1: `rsms/inter` の `Inter-4.1.zip`（`web/Inter-*.woff2`）のうち本文用の Regular/Medium/SemiBold/Bold
- JetBrains Mono v2.304: `JetBrains/JetBrainsMono` の `JetBrainsMono-2.304.zip`（`fonts/webfonts/*.woff2`）のうち Regular/Medium/SemiBold/Bold
- weight は界面の4段階（通常・中・やや太・太）に絞り、Italic と Display 変種は入れない

## ライセンス

- `OFL-Inter.txt`: `google/fonts` の `ofl/inter/OFL.txt` の正典全文
- `OFL-JetBrainsMono.txt`: `google/fonts` の `ofl/jetbrainsmono/OFL.txt` の正典全文
- SIL OFL §1 条件2 の著作権表記を含む冒頭行ごと同梱している
