/**
 * 共通フォーマッタ。
 */

export const STATUS_LABELS: Record<string, string> = {
  untouched: '未対応',
  in_progress: '対応中',
  done: '対応済み',
};

export const STATUS_BADGE_CLASS: Record<string, string> = {
  untouched: 'bg-rose-50 text-rose-700 border-rose-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export const CASE_CATEGORY_LABELS: Record<string, string> = {
  defect: '不良',
  shipping: '配送',
  usage: '使い方',
  other: 'その他',
};

export const SCOPE_LABELS: Record<string, string> = {
  company: '会社共通',
  store: '店舗共通',
  product: '商品別',
};

export const DEFECT_TYPE_LABELS: Record<string, string> = {
  size_mismatch: 'サイズ違い',
  color_mismatch: '色違い',
  damaged: '破損',
  missing_part: '部品欠損',
  other: 'その他',
};

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || isNaN(value)) return '—';
  return (value * 100).toFixed(digits) + '%';
}

export function formatRelative(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'たった今';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}日前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}か月前`;
  const yr = Math.floor(mon / 12);
  return `${yr}年前`;
}

export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}
