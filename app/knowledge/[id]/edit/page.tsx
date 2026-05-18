import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import ArticleForm from '../../_components/article-form';

export const dynamic = 'force-dynamic';

export default async function EditKnowledgePage({
  params,
}: {
  params: { id: string };
}) {
  const sb = await getSupabaseAdmin();
  const [{ data: a }, { data: channels }] = await Promise.all([
    sb.from('knowledge_articles').select('*').eq('id', params.id).maybeSingle(),
    sb.from('channels').select('code, display_name').order('display_name'),
  ]);
  if (!a) notFound();

  return (
    <div className="max-w-3xl">
      <Link
        href={`/knowledge/${a.id}`}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 mb-3"
      >
        <ChevronLeft size={14} /> 詳細に戻る
      </Link>
      <PageHeader title="ナレッジ編集" description={a.title} />
      <ArticleForm channels={channels ?? []} initial={a as any} mode="edit" />
    </div>
  );
}
