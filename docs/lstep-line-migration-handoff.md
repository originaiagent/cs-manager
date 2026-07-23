# Lステップ脱却・LINE移行 — セッション引き継ぎメモ

作成: 2026-07-22 / 正本の計画は `docs/roadmap.md`「Lステップ脱却・LINE移行」(L1〜L5)。本ファイルは次セッションが即再開するための技術メモ。

## 決定事項（トム 2026-07-22）
- Lステップは最終的に**解約**する。LINE公式アカウント標準機能 + 自社ツール (cs-manager 等) でフォローする
- 移行の難所は「LINE の Webhook が1アカウント1枠で、Lステップが使用中」→ 素の切替はLステップ受信起点機能を止める
- 併用期間は**Lステップ「LINE Webhook転送」オプション**（全プラン可・月5,500円税込・LINE素のwebhookデータをそのまま外部転送、Lステップ固有タグは含まれない）で作る。トム承認済
- Webhook切替は即時可逆。切替後もLステップの push 系配信（一斉/ステップ配信）は動き続け、止まるのは受信起点機能のみ

## 現状の配線（実装済み・未接続）
cs-manager の LINE 受信・送信はコード実装済み。未了は go-live 設定のみ。
- 受信 webhook: `app/api/channels/line/inbound/route.ts`
  - **重要**: `x-line-signature` を raw body に対し channel secret で HMAC-SHA256 検証（`src/channels/line/verify.ts`）。検証前に body を parse しない設計
  - channel secret は Core `/api/credentials/line_messaging`（`ALLOWED_LINE_SERVICE_CODES` allowlist）から取得。ハードコード禁止
  - 検証OK後: `src/lib/sync/ingest-inbound.ts` で ticket+message 冪等 upsert → origin-ai RAG ドラフト → `ticket_drafts(source='rag', status='pending')`
- 送信: `src/channels/line/outbound.ts` / cron `app/api/cron/line-sync/route.ts`（`*/5 * * * *`, vercel.json 登録済）
- 参考メモリ: `[[line-reply-send-wiring]]`（go-live=キー投入 + config.scope_key + Webhook URL）

## L1 で最初に潰すべき技術的未知（★最重要）
**Lステップの Webhook 転送が `x-line-signature` をどう扱うか。** cs-manager の受信は署名検証必須。
- ケースA: Lステップが**元の raw body と元の x-line-signature をそのまま透過**転送 → cs-manager が同じ channel secret を持てば検証成功、無改修でいける
- ケースB: Lステップが body を再構成 / 署名を落とす / 別のヘッダで送る → 現行の署名検証が落ちる。転送元用の代替認証（共有 secret 等）を受け口に追加する改修が必要
- **やること**: 転送を1通実データで受けて、届く生ヘッダ（署名の有無・body の一致）を確認してから受け口の対応を決める。ここを推測で作らない

## フェーズ（roadmap 正本の要約）
- L1 併用開始: トムが転送オプション申込（課金・トム作業）→ 受け口の署名対応（上記）→ LINE go-live 受信実証。返信は当面Lステップ、cs-managerは閲覧+下書きのみ（二重返信防止）
- L2 CS一本化: 返信を cs-manager 承認制送信へ切替。Lステップは配信専用に
- L3 棚卸し: Lステップで実使用の機能をトムにヒアリング → 「LINE公式標準で足りる / 自社ツールで作る / やめる」3分類（着手時に承認）
- L4 代替実装: 「自社ツールで作る」分を構築（個別 goal 化）
- L5 切替・解約: Webhook を cs-manager 直結へ → 本番確認 → **Lステップ解約**

## トムにしかできない作業（着手時に依頼）
1. Webhook転送オプションの申込み（課金発生・L1）
2. L3 の機能棚卸しヒアリング（どの機能を実際に使っているか）
3. go-live 判断（本番フラグON = 世に出す）

## 未確定・トム判断待ち
- 各フェーズの着手時期・優先順位（business_priority 未確定）
- 併用期間を作るか、課金せず「夜間一発切替＋即戻し」で行くか（現状は併用＝転送オプション前提）
