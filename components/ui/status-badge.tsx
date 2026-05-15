interface Props {
  status: string;
  variant?: 'knowledge' | 'suggestion' | 'proposal' | 'ticket';
}

const COMMON_LABELS: Record<string, string> = {
  draft: '下書き',
  published: '公開中',
  archived: 'アーカイブ',
  accepted: '採用',
  rejected: '却下',
  editing: '編集中',
  in_review: 'レビュー中',
  escalated: 'エスカレ',
  untouched: '未対応',
  in_progress: '対応中',
  done: '対応済み',
};

const COMMON_CLASSES: Record<string, string> = {
  draft: 'bg-gray-50 text-gray-600 border-gray-200',
  published: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  archived: 'bg-zinc-50 text-zinc-500 border-zinc-200',
  accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  editing: 'bg-amber-50 text-amber-700 border-amber-200',
  in_review: 'bg-blue-50 text-blue-700 border-blue-200',
  escalated: 'bg-orange-50 text-orange-700 border-orange-300',
  untouched: 'bg-rose-50 text-rose-700 border-rose-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export default function StatusBadge({ status, variant: _variant }: Props) {
  const label = COMMON_LABELS[status] ?? status;
  const classes =
    COMMON_CLASSES[status] ?? 'bg-gray-50 text-gray-600 border-gray-200';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${classes}`}
    >
      {label}
    </span>
  );
}
