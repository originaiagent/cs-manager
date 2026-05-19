-- Soft delete for knowledge_articles: replace archive status with deleted_at
ALTER TABLE knowledge_articles ADD COLUMN deleted_at timestamptz NULL;

-- Migrate existing archived → deleted_at (ロスレス、updated_at を採用)
UPDATE knowledge_articles
SET deleted_at = COALESCE(updated_at, NOW())
WHERE status = 'archived' AND deleted_at IS NULL;

-- 既存 archived レコードは status を published に戻す (deleted_at が削除情報を保持)
-- これにより CHECK 制約 (status <> 'archived') を満たせる
UPDATE knowledge_articles
SET status = 'published'
WHERE status = 'archived';

-- 再混入防止 CHECK 制約
ALTER TABLE knowledge_articles
ADD CONSTRAINT knowledge_articles_status_not_archived_chk
CHECK (status <> 'archived');

COMMENT ON COLUMN knowledge_articles.deleted_at IS 'Soft delete timestamp. NULL = active.';
COMMENT ON COLUMN knowledge_articles.status IS 'DEPRECATED archive value: archived is no longer assignable (enforced by CHECK). Use deleted_at for soft delete.';

-- 一覧用部分 index (deleted_at IS NULL の active 記事に絞った status index)
CREATE INDEX IF NOT EXISTS knowledge_articles_active_status_idx
ON knowledge_articles (status)
WHERE deleted_at IS NULL;
