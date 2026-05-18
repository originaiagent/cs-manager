/**
 * 不良率ページの期間 / 月選択ヘルパ (Asia/Tokyo 固定)
 *
 * 月別は今月を含む過去 12 ヶ月のみ navigable。範囲外は今月にクランプ (400 にしない、共有 URL 堅牢性のため)。
 */

export const PERIODS = ['30d', '90d', 'all', 'monthly'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  '30d': '直近30日',
  '90d': '直近90日',
  all: '全期間',
  monthly: '月別',
};

export const GRANULARITIES = ['parent', 'variation'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  parent: '親 SKU',
  variation: '子バリエーション',
};

/**
 * Asia/Tokyo タイムゾーンで現在の年・月を取得 (UTC オフセット +09:00 固定で十分)。
 * サーバー TZ に依存しないように Intl.DateTimeFormat を使う。
 */
function jstNow(): { year: number; month: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = f.formatToParts(new Date());
  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  return { year, month };
}

/** "YYYY-MM" を返す (Asia/Tokyo) */
export function currentMonthKey(): string {
  const { year, month } = jstNow();
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** monthIdx = year * 12 + (month - 1) */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * URL ?month=YYYY-MM を validate + clamp する。
 *   - 形式不正 / MM 範囲外 → 今月
 *   - 未来月 (今月超) → 今月
 *   - 12 ヶ月より古い → 今月
 */
export function clampMonth(raw: string | undefined | null): string {
  const { year: cy, month: cm } = jstNow();
  const thisMonth = `${cy}-${String(cm).padStart(2, '0')}`;
  if (!raw) return thisMonth;
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return thisMonth;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  // MM 範囲を厳格 validate (codex R2 round 2 指摘)
  if (mo < 1 || mo > 12) return thisMonth;
  const curr = monthIndex(cy, cm);
  const req = monthIndex(y, mo);
  if (req > curr || req < curr - 11) return thisMonth;
  return raw;
}

/**
 * monthKey ("YYYY-MM") を [startISO, nextStartISO] の Asia/Tokyo 月境界に変換。
 * JST 月初 0:00 → UTC は前月末 15:00 になる。
 *
 * 結果は Postgres timestamp 比較に使える ISO 文字列 (UTC, "Z" 終端)。
 */
export function monthRangeJstAsUtcIso(monthKey: string): {
  startUtc: string;
  endUtc: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`invalid monthKey: ${monthKey}`);
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);

  // JST 月初 00:00 = UTC: 前日 15:00
  // Date.UTC で UTC タイムスタンプを直接組み立てる
  const startMs = Date.UTC(y, mo - 1, 1, -9, 0, 0); // y/(mo-1)/1 00:00 JST → -9h UTC
  const endMs = Date.UTC(y, mo, 1, -9, 0, 0); // 翌月 1 日 00:00 JST → -9h UTC
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  };
}

/**
 * 月別ナビゲーション用: 今月を起点に過去 12 ヶ月 (含む今月) の monthKey 配列を返す。
 * 結果は新しい月が先頭。
 */
export function recentMonths(): string[] {
  const { year, month } = jstNow();
  const result: string[] = [];
  for (let i = 0; i < 12; i++) {
    let y = year;
    let m = month - i;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    result.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return result;
}

/** 与えられた monthKey の前月・翌月 (範囲外は null) */
export function prevMonth(monthKey: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10) - 1;
  if (mo < 1) {
    mo = 12;
    y -= 1;
  }
  const key = `${y}-${String(mo).padStart(2, '0')}`;
  // 12 ヶ月以内かチェック
  const months = recentMonths();
  return months.includes(key) ? key : null;
}

export function nextMonth(monthKey: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  const key = `${y}-${String(mo).padStart(2, '0')}`;
  const months = recentMonths();
  return months.includes(key) ? key : null;
}
