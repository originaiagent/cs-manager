/**
 * browse capability の静的カタログ (コード定数・凍結)。
 *
 * 能力自動増殖ループ M2「汎用読み層 data_browse」の cs-manager 側 browse 窓
 * (origin-ai docs/ops/capability-loop-impl-design.md §2.1/§2.2 の契約に準拠)。
 * 叩き台はライブ DB introspection (2026-07-24) をキュレーションして凍結した。
 * 以後の保守はこのファイルで行う (ライブ introspection はしない)。
 *
 * 除外ポリシー (契約 §2.1・判断がつかない列は除外側に倒す):
 *   1) 明確な PII: 顧客氏名・メール・受取人名・LINE アカウント・顧客本文
 *      (tickets.customer_name/customer_email, messages 全体, pii_mask_tokens 全体,
 *       customer_service_records.recipient_name/recipient_honorific/line_account 等)
 *   2) 秘密: 接続設定・hash 系列 (channels.config, channel_inboxes,
 *       send_audit.config_snapshot/body_hash, rag_indexing_jobs.content_hash)
 *   3) システム内部: ai_embed_*, channel_sync_state, rag_chunk_embeddings,
 *       embedding/vector 列 (恒久除外)
 *   4) 判断がつかない: customer_service_records.memo, ticket_drafts.body/last_error,
 *       rag_chunks.content (顧客文混入リスク) 等 → 除外
 * データ品質の罠は note で注記つき公開する (隠さない)。
 */

export interface BrowseCatalogEntry {
  /** テーブル名 (rows の table param はこれと完全一致のみ)。 */
  table: string;
  /** 1 行説明 (日本語)。 */
  description: string;
  /** 公開列 allowlist (この順で射影)。 */
  columns: string[];
  /** 固定ソート (クライアント指定不可・必ず PK を最終タイブレーカーに含める)。 */
  order_by: string;
  /** 死列・罠列警告等 (任意)。 */
  note?: string;
}

export const BROWSE_CATALOG: BrowseCatalogEntry[] = [
  {
    table: 'tickets',
    description: 'amazon・楽天・Yahoo 等のチャネル横断で取り込んだ顧客問い合わせチケット (受信箱)。',
    columns: [
      'id',
      'channel_id',
      'external_id',
      'subject',
      'status',
      'product_id',
      'case_category',
      'defect_type',
      'resolved_at',
      'is_kb_candidate',
      'assignee_user_id',
      'classified_at',
      'created_at',
      'updated_at',
    ],
    order_by: 'updated_at desc, id asc',
    note: 'customer_name/customer_email (PII)・channel_meta (チャネル生メタ) は非公開。',
  },
  {
    table: 'customer_service_records',
    description: '顧客対応記録 (返信のみ/不良再送/不良返金/お客様都合再送・返金/おまけ発送等を 1 レコード = 1 対応で保存)。',
    columns: [
      'id',
      'product_id',
      'product_name_text',
      'variation_text',
      'variation_id',
      'variation_jan',
      'order_number',
      'order_channel',
      'action_type',
      'amazon_gift_amount',
      'reship_tracking',
      'record_date',
      'defect_type',
      'ticket_id',
      'created_by',
      'created_at',
      'updated_at',
    ],
    order_by: 'updated_at desc, id asc',
    note: 'recipient_name/recipient_honorific/line_account (PII)・memo (自由記述) は非公開。order_number は注文番号 (業務データ)。',
  },
  {
    table: 'ticket_drafts',
    description: 'チケットへの返信文案の管理行 (状態・送信結果のみ。本文は非公開)。',
    columns: [
      'id',
      'ticket_id',
      'source',
      'status',
      'sent_at',
      'external_message_id',
      'is_separated',
      'first_send_at',
      'created_at',
      'updated_at',
    ],
    order_by: 'updated_at desc, id asc',
    note: 'body (返信文案・顧客名混入可能性)・last_error (未サニタイズ生エラー) は非公開。',
  },
  {
    table: 'ticket_defect_causes',
    description: 'チケットに付与された不良原因ラベル (原因ラベル・大分類・付与経路)。',
    columns: ['id', 'ticket_id', 'cause_label', 'major_category', 'source', 'created_at'],
    order_by: 'created_at desc, id asc',
  },
  {
    table: 'fba_return_symptoms',
    description: 'FBA 返品コメントから分類した症状ラベル (返品キー単位)。',
    columns: ['id', 'return_key', 'cause_label', 'major_category', 'source', 'created_at'],
    order_by: 'created_at desc, id asc',
  },
  {
    table: 'fba_return_classify_state',
    description: 'FBA 返品分類の処理状態 (分類済み日時・試行回数の冪等管理)。',
    columns: ['return_key', 'classified_at', 'attempts', 'claimed_at', 'created_at'],
    order_by: 'created_at desc, return_key asc',
  },
  {
    table: 'sales_stats_cache',
    description: '商品×期間の販売数キャッシュ (不良率の分母に使用)。',
    columns: ['id', 'product_id', 'period', 'sales_count', 'as_of', 'synced_at'],
    order_by: 'synced_at desc, id asc',
    note: 'ec-manager 販売実績のキャッシュで as_of 時点の値。最新の販売実績の正は ec-manager。',
  },
  {
    table: 'improvement_suggestions',
    description: '問い合わせ・不良データ由来の改善提案 (対象・提案内容・根拠・状態)。',
    columns: [
      'id',
      'target_type',
      'target_product_id',
      'current_content_ref',
      'suggested_change',
      'reasoning',
      'source_data_summary',
      'status',
      'created_at',
      'updated_at',
    ],
    order_by: 'updated_at desc, id asc',
  },
  {
    table: 'product_improvement_proposals',
    description: '不良率しきい値トリガーの商品改善提案 (不良率・内訳・提案・状態)。',
    columns: [
      'id',
      'product_id',
      'defect_rate',
      'threshold_at_trigger',
      'defect_breakdown',
      'suggested_changes',
      'reasoning',
      'source_ticket_ids',
      'status',
      'created_at',
      'updated_at',
    ],
    order_by: 'updated_at desc, id asc',
  },
  {
    table: 'knowledge_articles',
    description: 'CS ナレッジ記事 (タイトル・質問・回答・本文と適用範囲・参照回数)。',
    columns: [
      'id',
      'storage_scope',
      'storage_store_id',
      'storage_product_id',
      'applies_to_stores',
      'applies_to_products',
      'applies_to_categories',
      'applies_to_defect_types',
      'title',
      'question',
      'answer',
      'body_markdown',
      'source_ticket_ids',
      'tags',
      'reference_count',
      'reviewed_by',
      'status',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    order_by: 'updated_at desc, id asc',
    note: 'embedding (vector) は非公開。deleted_at が非 null の行は論理削除済み。',
  },
  {
    table: 'channels',
    description: '販売チャネル定義 (コード・表示名・状態)。',
    columns: ['id', 'code', 'display_name', 'status', 'created_at', 'updated_at'],
    order_by: 'updated_at desc, id asc',
    note: 'config (接続設定・秘匿) は非公開。',
  },
  {
    table: 'business_hours',
    description: 'チャネル別の営業時間定義 (曜日・開閉時刻・タイムゾーン・休日)。',
    columns: [
      'id',
      'channel_id',
      'day_of_week',
      'open_time',
      'close_time',
      'timezone',
      'is_holiday',
      'effective_from',
      'effective_to',
      'created_at',
    ],
    order_by: 'created_at desc, id asc',
  },
  {
    table: 'first_response_templates',
    description: '一次応答テンプレート (カテゴリ・チャネル別・本文テンプレート・版)。',
    columns: ['id', 'category', 'channel_id', 'body_template', 'is_active', 'version', 'created_at'],
    order_by: 'created_at desc, id asc',
  },
  {
    table: 'rag_config',
    description: 'RAG 検索の設定キー・値・説明。',
    columns: ['config_key', 'config_value', 'description', 'updated_by', 'updated_at'],
    order_by: 'updated_at desc, config_key asc',
  },
  {
    table: 'rag_indexing_jobs',
    description: 'ナレッジ記事の RAG 索引ジョブ (版・状態・世代・開始/完了時刻)。',
    columns: [
      'id',
      'article_id',
      'article_version',
      'chunking_version',
      'embedding_version',
      'status',
      'generation_number',
      'started_at',
      'completed_at',
      'created_at',
    ],
    order_by: 'created_at desc, id asc',
    note: 'content_hash (hash 系)・error (生エラー)・worker_id/worker_started_at (内部 worker 管理) は非公開。',
  },
  {
    table: 'rag_article_active_generations',
    description: 'ナレッジ記事ごとの有効な索引世代ポインタ (現行版・直前版)。',
    columns: [
      'article_id',
      'active_article_version',
      'active_indexing_job_id',
      'activated_at',
      'previous_article_version',
      'previous_deprecated_at',
    ],
    order_by: 'activated_at desc, article_id asc',
  },
  {
    table: 'send_audit',
    description: '返信送信の監査ログ (フロー・テンプレート・結果・サニタイズ済みエラー)。',
    columns: [
      'id',
      'ticket_id',
      'draft_id',
      'channel_id',
      'channel_code',
      'flow',
      'category',
      'template_id',
      'template_version',
      'result',
      'external_message_id',
      'error_sanitized',
      'created_at',
    ],
    order_by: 'created_at desc, id asc',
    note: 'masked_placeholders/config_snapshot (設定スナップショット)・body_hash (hash 系) は非公開。error_sanitized はマスク済み。',
  },
];

/** table 名から catalog entry を引く (完全一致のみ・fail-closed)。 */
export function getBrowseCatalogEntry(table: string): BrowseCatalogEntry | undefined {
  return BROWSE_CATALOG.find((e) => e.table === table);
}
