# 作業進捗

<!-- 形式: -->
<!-- ## [日付] [作業名] -->
<!-- - 状態: 完了/進行中/保留 -->
<!-- - ブランチ: claude/xxx -->
<!-- - 内容: -->

## 2026-07-18 不良率を症状別に戻す（フェーズ3）
- 状態: 完了（本番反映・実測確認済）
- ブランチ: claude/defect-symptom-handoff
- PR: cs-manager #75 / #76 / #77、ec-manager #457 / #458（全てmain へマージ）
- 内容:
  - **注文番号→製品の自動紐付け**: 楽天チケットの `channel_meta.orderNumber` → ec-manager `/api/external/rakuten-order-items`（新設）→ 商品管理番号/SKU管理番号 → Core `mall_identifiers` → 製品。誤帰属を防ぐため「注文の全明細行が解決でき、かつ解決先が単一 group の注文」のみ紐付ける（部分解決も曖昧扱い）。Core への lookup は (mall×slot) 単位の一括のみで N+1 を作らない。
  - **FBA返品の顧客コメントをAI症状分類**: 新テーブル `fba_return_symptoms` / `fba_return_classify_state` + RPC `claim_fba_return_classify_batch`、新 cron `/api/cron/classify-return-comments`（30分間隔）。PIIマスク後のみ origin-ai へ送信し、**原文はDB・ログ・エラーとも非保存**。マスク失敗時は fail-closed。ラベル語彙は tickets 分類と共有し同義語の分裂を防ぐ。
  - **責任区分（responsibility）の撤去 + 症状別UIへの刷新**: 承認済みモックどおり、症状を製品行の直下に常時表示（クリック不要）、症状ごとの横バー（製品内相対・上位8件+「他N件」）、文字拡大（本文16px/製品名18px/不良率22px）、上部サマリ4枚。期間チップ・粒度・basis・CSV・定義パネル・ドリルダウン・各種縮退注記は維持。
  - **定義と計算の整合**: 定義パネルは「配送中の破損・顧客都合の返品は不良に数えない」と表示しながら `DAMAGED_BY_CARRIER` / `DAMAGED_BY_FC` を不良に数えていた。責任区分の撤去で内訳表示が無くなり配送起因が製品の不良率を実態より高く見せるため、2コードを除外側へ移した（数字が変わる変更）。
- 実測（本番 `/api/diag/defect-rate?period=30d` を3連続実行し全て同一値）:
  `rows=44 totalCases=76 salesUnits=44367 / orderLinked=19 ambiguous=0 degraded=false / returnsWithSymptoms=44 unmappedDefectCases=7 / coreRequests=12→2→2`
- 症状ラベル実測: 動かない10 / 歪み10 / 吸水しない9 / 破損8 / 汚れ5 / 傷がある4 / 割れ4 / 貼り付かない / 電源が入らない
- 検証: tsc エラーなし、vitest 40 files・430 tests passed、npm run build 成功
- 残: 本番画面の目視はOIDCゲート内のためトムが実施

## 2026-07-18 FBA返品レポートの文字化けを根治（フェーズ3の派生）
- 状態: 完了（本番反映・修復済）
- PR: ec-manager #458
- 経緯: AI症状分類を本番で初回実行したところ **20件中19件が「症状を読み取れない」**。プロンプトの問題を疑ったが、実データを調べると顧客コメントが文字化けしていた。
- 根本原因: Amazon の JP マーケットプレイスは `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` を **`text/plain; charset=Windows-31J`（Shift_JIS）** で返すが、`fetchReturnsReportTsv` が `new TextDecoder()`（既定 UTF-8）で読んでいた。
- 実測（`scripts/probe-returns-encoding.ts`）: utf-8 → 日本語90字 / U+FFFD 18,615個、**shift_jis → 日本語14,322字 / U+FFFD 0個**、euc-jp → 日本語0字。
- なぜ長期間気づかれなかったか: 従来パースしていた列（return-date / order-id / sku / asin / reason / detailed-disposition 等）が**すべてASCII**だったため。日本語を含む `product-name` は取込当初から壊れていたが誰も参照しておらず、今回 `customer-comments` を読み始めて初めて顕在化した。
- 修正: 応答の `Content-Type` から charset を取り出してデコード（未知ラベルは utf-8 フォールバック + 警告）。特定charsetをハードコードせず Amazon の申告に従う。
- 修復実測（直近35日・コメント有98行）: customer_comments 日本語 23→94行・文字化け0行、product_name 日本語 46→98行・文字化け0行。`rawHashOf` の入力列は全てASCIIのため natural key は不変で、既存行は `onConflictDoUpdate` により in-place 修復された。
- 効果: 再分類で 20件中1件 → 86件中60件に症状ラベルが付くようになった。
- 教訓: **外部レポートの取込では Content-Type の charset を必ず尊重する。ASCII列しか見ていないと文字化けは何ヶ月も潜伏する。**
- 申し送り: 同レポートに `status` 列は実在せず（12列に無い）、既存パーサは `idx("status")` が -1 のため常に空文字を入れている。本タスク範囲外のため未修正。

## 2026-07-23 L1技術準備（Lステップ→LINE移行：併用期間の受け口設計）
- 状態: L1設計完了・コード実装待ち
- ブランチ: claude/lstep-handoff-note
- 内容:
  - **Lステップ併用期間の受信受け口設計を codex で APPROVE** (round1-5・残blocker/major=0)。同一エンドポイント内の段階認証: Tier1=既存 x-line-signature（透過対応・Case A カバー）。Tier2=opt-in で転送元共有token（Core credential line_webhook_forward・fail-closed・tier独立）。Tier2は Case B 確定時のみ実装。
  - **最重要の未知点Q2**: 「Lステップ Webhook転送がカスタムヘッダを透過するか」は公開情報未確定。Lステップ側は月5,500円オプション、転送先URL欄のみ公開・カスタムヘッダ可否は非公開。→ トム申込み後の実データ1通で Case A/B を確定する方針（推測で設計しない）。
  - **コスト・喪失・二重返信ガード**: RAG予算hard cap / outbox と failures を同一tx で登録 / forward_mode channel は送信 skip。
  - **ドキュメント作成**: `docs/design/line-webhook-forward-receiver.md`（設計文書）、`docs/lstep-line-migration-L1-tom-guide.md`（トム向け申込み/運用手順）。
  - **実装状況**: 設計書のみ。Case A/B 実測後に src/ コード着手。

---
*200行を超えたら完了済みタスクを月単位で要約すること*
