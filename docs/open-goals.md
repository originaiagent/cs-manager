# Open Goals 台帳

セッションを跨いで継続すべきゴールの台帳。ゴール宣言 (`.claude/.session/goal-*.md`) と対で登録し、完遂時に消し込む。

## 進行中

（なし）

## 完了

### 不良発生率ライブ化（製品別×原因別・任意期間） — 2026-07-17 本番反映済
- PR: cs-manager #68 (機能) / #69 (小分け・二重分類の根治) / ec-manager #450 (外部API)
- 反映内容: migration 2本適用、ec-manager Cloud Run デプロイ、Vercel env 追加、cs-manager デプロイ、cron 実稼働
- 実測: 販売数 API と画面表示が一致 (20,987個)、原因ラベルの既存語彙再利用率 7%→93%
- 申し送り: CS対応記録の product 未入力 (177件) / case_category の非正規値3件 / 詳細は各PR本文
