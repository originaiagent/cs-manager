import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import ArticleForm from '../_components/article-form';

export const dynamic = 'force-dynamic';

export default async function NewKnowledgePage() {
  const sb = await getSupabaseAdmin();
  const { data: channels } = await sb
    .from('channels')
    .select('code, display_name')
    .order('display_name');
  return (
    <div className="max-w-3xl">
      <Link
        href="/knowledge"
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 mb-3"
      >
        <ChevronLeft size={14} /> ナレッジ一覧に戻る
      </Link>
      <PageHeader title="ナレッジ新規作成" description="3階層スコープでナレッジ記事を新規作成します" />
      <ArticleForm channels={channels ?? []} mode="create" />
    </div>
  );
}
