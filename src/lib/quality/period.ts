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

// ---------------------------------------------------------------------------
// 日付範囲正規化 (不良発生率ライブ化 C2-3)
//   全期間モード (30d/90d/all/monthly/custom) を [start, end] の YYYY-MM-DD
//   日付範囲 (JST 基準, end は inclusive) へ正規化する。
//   ec-manager API (startDate/endDate) と CSR record_date (date 型の文字列比較) が
//   同じ日付文字列をそのまま使い、tickets.created_at (timestamptz) だけ
//   dateRangeToUtcIso で JST 0:00 境界の UTC ISO に変換する。
// ---------------------------------------------------------------------------

/** 日付範囲 (YYYY-MM-DD, JST 基準)。end は inclusive */
export interface DateRange {
  start: string;
  end: string;
}

/** 'all' モードの開始日 (これ以前の業務データは存在しない前提の下限) */
const ALL_PERIOD_START = '2020-01-01';

/** Asia/Tokyo の今日を YYYY-MM-DD で返す (en-CA ロケール = ISO 形式) */
export function jstTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** YYYY-MM-DD 形式 + 実在日チェック (2月30日等を弾く) */
export function isValidYmd(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1) return false;
  // 当月末日 (Date.UTC の day=0 は前月末日)
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** YYYY-MM-DD に日数を加算 (UTC 演算で TZ 非依存) */
function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split('-').map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 既存 Period (30d/90d/all/monthly) を日付範囲へ正規化する。
 *   - 30d/90d: 今日 (JST) を含む直近 30/90 暦日
 *   - all: ALL_PERIOD_START (2020-01-01) 〜 今日
 *   - monthly: monthKey の月初〜月末 (monthKey 欠落時は今月)
 */
export function resolvePeriodRange(period: Period, monthKey: string | null): DateRange {
  const today = jstTodayYmd();
  if (period === '30d') return { start: addDaysYmd(today, -29), end: today };
  if (period === '90d') return { start: addDaysYmd(today, -89), end: today };
  if (period === 'monthly') {
    const key = monthKey ?? currentMonthKey();
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return { start: ALL_PERIOD_START, end: today }; // clampMonth 済み想定の防御
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, '0')}` };
  }
  // 'all'
  return { start: ALL_PERIOD_START, end: today };
}

/**
 * カスタム期間 (?period=custom&from=&to=) の validate。
 * 不正 (形式・実在日・from>to) は null (呼び出し側で既定期間へフォールバック)。
 */
export function resolveCustomRange(
  from: string | null | undefined,
  to: string | null | undefined,
): DateRange | null {
  if (!isValidYmd(from) || !isValidYmd(to)) return null;
  if (from > to) return null;
  return { start: from, end: to };
}

/**
 * 日付範囲 (JST) を timestamptz 比較用の UTC ISO 境界へ変換する。
 * startUtc = start 0:00 JST、endUtc = end 翌日 0:00 JST (exclusive、`.lt()` 用)。
 */
export function dateRangeToUtcIso(range: DateRange): { startUtc: string; endUtc: string } {
  const [ys, ms, ds] = range.start.split('-').map((v) => parseInt(v, 10));
  const [ye, me, de] = range.end.split('-').map((v) => parseInt(v, 10));
  // JST 0:00 = UTC 前日 15:00 → Date.UTC(hour=-9) で直接組み立て (monthRangeJstAsUtcIso と同流儀)
  const startMs = Date.UTC(ys, ms - 1, ds, -9, 0, 0);
  const endMs = Date.UTC(ye, me - 1, de + 1, -9, 0, 0);
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  };
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
