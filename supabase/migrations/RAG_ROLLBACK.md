# RAG Stage 2 — Rollback 手順 (cs-manager)

対象 DB: cs-manager (Supabase project `jpnsoqzzylahpandbfcz`)
対象マイグレーション:
- `20260522123834_rag_phase0_01_enum_config.sql`
- `20260522123925_rag_phase0_02_chunk_tables.sql`
- `20260522124005_rag_phase0_03_business_hours.sql`
- `20260522124143_rag_phase0_04_search_rpc.sql`
- `20260522225010_rag_phase1_05_activate_generation.sql`
- `20260522225419_rag_phase1_06_rrf_require_acl.sql`

これらは全て **新規 object のみ** を追加する（既存テーブルへの ALTER は無い）。
従って rollback による既存データへの影響は無い。

---

## ステップ 0: ソフト無効化（推奨・第一選択）

DDL を DROP せず、feature flag を落とすだけで RAG 機能を停止できる。
本番影響を最小化したい場合はまずこれを実行する。

```sql
UPDATE public.rag_config SET config_value = 'false', updated_at = now()
  WHERE config_key IN (
    'rrf_search_enabled',
    'rerank_enabled',
    'contextual_prefix_enabled',
    'rakuten_auto_send_enabled'
  );
```

- `rrf_search_enabled=false`: RRF 検索系統の利用を停止（呼び出し側で参照）
- `rakuten_auto_send_enabled=false`: 営業時間外 R-MessE 自動送信を停止（dry-run のみ）
- `rerank_enabled` / `contextual_prefix_enabled` は既定 false

---

## ステップ 1: 完全 DROP（DDL ロールバック）

スキーマ自体を撤去する場合。**DROP 順序は FK 依存に従う**こと。
`rag_chunk_access_stats` → `rag_chunk_embeddings` → `rag_chunks` → その他、の順。

```sql
-- 1. 関数（テーブルより先に落としてよい）
DROP FUNCTION IF EXISTS public.search_knowledge_rrf(public.vector, text, int, int, text[], uuid, uuid, uuid, text[], text[], jsonb, text, text, text, boolean);
DROP FUNCTION IF EXISTS public.search_knowledge_rrf(public.vector, text, int, int, text[], uuid, uuid, uuid, text[], text[], jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.rag_activate_generation(uuid, int, uuid);
DROP FUNCTION IF EXISTS public.is_within_business_hours(uuid, timestamptz);

-- 2. テーブル（依存順: access_stats → embeddings → chunks → 他）
DROP TABLE IF EXISTS public.rag_chunk_access_stats;
DROP TABLE IF EXISTS public.rag_chunk_embeddings;       -- FK → rag_chunks
DROP TABLE IF EXISTS public.rag_chunks;                 -- FK → rag_indexing_jobs, knowledge_articles
DROP TABLE IF EXISTS public.rag_article_active_generations;
DROP TABLE IF EXISTS public.rag_indexing_jobs;
DROP TABLE IF EXISTS public.pii_mask_tokens;
DROP TABLE IF EXISTS public.first_response_templates;
DROP TABLE IF EXISTS public.business_hours;
DROP TABLE IF EXISTS public.rag_config;

-- 3. ENUM 型（参照テーブルを全て落とした後）
DROP TYPE IF EXISTS public.chunk_status;

-- 4. role（他で未使用を確認の上）
DROP ROLE IF EXISTS role_rag_search;
```

注意:
- `ON DELETE CASCADE` を貼っているため `rag_chunks` を落とせば embeddings は連鎖削除されるが、明示順で落とすのが安全。
- `role_rag_search` は他機能で共有していないことを確認してから DROP する。
- DROP した場合 `supabase_migrations.schema_migrations` の対応行は手動で削除しないと再適用時に齟齬が出る（CLI 運用時）。
