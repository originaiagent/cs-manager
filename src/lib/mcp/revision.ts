/**
 * [P1] コレクション全体を対象とした revision ハッシュ — 共有ヘルパー
 *
 * handleRead が返す revision、checkRevision の expected_revision 比較、
 * write 成功後の new_revision がすべてこの関数を使うことで
 * read→write→次の write のラウンドトリップが一貫する。
 *
 * 旧実装 (rows[0].created_at のみ) の問題:
 * - 先頭以外の行を追加/削除/並び替えしても row0.created_at が変化しない
 * - stale な expected_revision が通過し、楽観ロックが機能しない
 *
 * この実装:
 * - コレクション全体の (id, sort_order, ts) を sort_order 昇順でハッシュ化
 * - 任意の行の変化が revision に反映される (行数変化・並び替え・更新すべて)
 * - 空コレクションは固定の "epoch" 文字列を返す
 */

import { createHash } from 'node:crypto';

export function computeCollectionRevision(
  rows: Array<{ id: string; sort_order: number; updated_at?: string | null; created_at?: string | null }>,
): string {
  if (rows.length === 0) return '1970-01-01T00:00:00.000Z';

  const body = JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      sort_order: r.sort_order,
      ts: r.updated_at ?? r.created_at ?? '',
    })),
  );
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
