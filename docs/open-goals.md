# Open Goals 台帳

セッションを跨いで継続すべきゴールの台帳。ゴール宣言 (`.claude/.session/goal-*.md`) と対で登録し、完遂時に消し込む。

## 進行中

（なし）

## 完了

### 不良率を症状別に戻す（フェーズ3） — 2026-07-18 本番反映済
- PR: cs-manager #75(本体) / #76(ラベル混入ガード) / ec-manager #457(外部API) / #458(文字化け根治)
- 反映内容:
  - 注文番号→製品の自動紐付け（楽天注文番号→ec-manager rakuten-order-items→Core→製品）。誤帰属防止のため「全明細行が解決でき単一groupの注文」のみ紐付け
  - FBA返品の顧客コメントをAI症状分類（保存前PIIマスク・原文非保存・マスク失敗時fail-closed）。新テーブル fba_return_symptoms / fba_return_classify_state、新cron 30分間隔
  - 責任区分の撤去＋症状別を製品行直下に常時表示（横バー・文字拡大・上部サマリ）
  - 配送/倉庫破損（DAMAGED_BY_CARRIER/FC）を不良から除外し、画面の定義文と計算を一致させた（数字が変わる変更）
- 実測（本番 /api/diag/defect-rate 3連続一致）: rows=44 / totalCases=76 / orderLinkedOrders=19 / ambiguous=0 / returnsWithSymptoms=44 / unmapped.defectCases=7 / coreRequests=2〜12
- 副産物（根治）: FBA返品レポートが `charset=Windows-31J` なのに UTF-8 で読まれており、顧客コメントも product_name も取込当初から文字化けしていた。Content-Type の charset に従うよう修正し再取込で解消（product_name 日本語 46→98行・文字化け0行）
- 申し送り: FBA返品レポートに `status` 列は実在せず既存パーサは常に空文字を入れている（本タスク範囲外）

### 不良率の工場エビデンス化（フェーズ2） — 2026-07-17 本番反映済
- PR: cs-manager #71 / ec-manager #454
- 反映内容: FBA返品の日次自動取込み（backfill 412行 + GH Actions 日次実行を実 run で実証）、責任区分（工場47/配送倉庫5/自社9 の恒等式実証）、注文日基準、案件ドリルダウン、CSVエクスポート（PII列なし・インジェクション対策）、定義パネル、製品改善タブ廃止
- 実測: 直近30日 不良17製品61件表示（0件問題の解消）、3連続リロード数字不変

### 不良発生率ライブ化（製品別×原因別・任意期間） — 2026-07-17 本番反映済
- PR: cs-manager #68 (機能) / #69 (小分け・二重分類の根治) / ec-manager #450 (外部API)
- 反映内容: migration 2本適用、ec-manager Cloud Run デプロイ、Vercel env 追加、cs-manager デプロイ、cron 実稼働
- 実測: 販売数 API と画面表示が一致 (20,987個)、原因ラベルの既存語彙再利用率 7%→93%
- 申し送り: CS対応記録の product 未入力 (177件) / case_category の非正規値3件 / 詳細は各PR本文
