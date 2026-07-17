# Open Goals 台帳

セッションを跨いで継続すべきゴールの台帳。ゴール宣言 (`.claude/.session/goal-*.md`) と対で登録し、完遂時に消し込む。

## 進行中

### 不良発生率ライブ化（製品別×原因別・任意期間）
- 宣言: 2026-07-17 / セッション 2b90ec03 / ブランチ cs-manager `claude/defect-rate-live` + ec-manager `claude/external-sales-units-api`
- 内容: 分母=ec-manager 実売数（/api/external/sales-units 新設）、分子=クレーム+FBA返品（/api/external/customer-returns 新設）を案件ユニークに名寄せ、AI原因分類（複数原因・小分け防止）で /quality/defect-rate を実データ化
- 設計契約: scratchpad defect-rate-design.md（セッション内）/ codex レビューはトム指示によりスキップ
- 完了条件: 両APIの実応答確認・/quality/defect-rate 実表示確認・テスト/ビルド通過・両リポPR作成
