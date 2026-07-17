'use client';

/**
 * 不良率テーブル (client component) — 工場エビデンス化 C3b-2
 *
 * サマリ行クリックで案件ドリルダウン (原因別内訳 + 案件一覧) を展開する。
 * データ取得・名寄せは server (page.tsx → defect-rate-data.ts) が行い、
 * ここには serializable な行 VM だけが渡る。view (全体/工場起因のみ) の再計算は
 * 純関数 (defect-view.ts) を server/CSV と共用して定義ズレを防ぐ。
 * 顧客名・問い合わせ本文は表示しない (案件詳細はリンク先で見る)。
 */

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatPercent } from '@/lib/format';
import {
  RESPONSIBILITY_LABELS,
  resolveCaseResponsibility,
  type Responsibility,
} from '@/lib/quality/defect-taxonomy';
import type { DefectAggRow, DefectBasis, DefectCaseDetail } from '@/lib/quality/defect-aggregate';
import {
  applyViewToRow,
  caseRouteLabel,
  topCauses,
  type DefectView,
} from '@/lib/quality/defect-view';

/** サマリ 1 行分の VM (server で名寄せ済み。serializable) */
export interface DefectRateTableRow {
  rowKey: string;
  productName: string;
  /** variation 粒度のみ (parent 粒度は null) */
  variationLabel: string | null;
  row: DefectAggRow;
}

interface Props {
  rows: DefectRateTableRow[];
  granularity: 'parent' | 'variation';
  view: DefectView;
  basis: DefectBasis;
  /** 不良率の閾値 (view 適用後の率で超過判定) */
  threshold: number;
}

/** 責任区分バッジの配色 */
const RESPONSIBILITY_BADGE_CLASS: Record<Responsibility, string> = {
  factory: 'bg-rose-50 text-rose-700 border-rose-200',
  logistics: 'bg-sky-50 text-sky-700 border-sky-200',
  listing: 'bg-amber-50 text-amber-700 border-amber-200',
  unverified: 'bg-gray-50 text-gray-600 border-gray-200',
};

function ResponsibilityBadge({ value }: { value: Responsibility }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${RESPONSIBILITY_BADGE_CLASS[value]}`}
    >
      {RESPONSIBILITY_LABELS[value]}
    </span>
  );
}

/** 案件明細集合のソース別件数 (view 適用後の内訳(t/c/f) 表示用に再計算) */
function sourcesOfCases(cases: readonly DefectCaseDetail[]): {
  tickets: number;
  csr: number;
  fba: number;
} {
  const acc = { tickets: 0, csr: 0, fba: 0 };
  for (const c of cases) {
    if (c.sources.includes('ticket')) acc.tickets += c.count;
    if (c.sources.includes('csr')) acc.csr += c.count;
    if (c.sources.includes('fba')) acc.fba += c.count;
  }
  return acc;
}

export default function DefectRateTable({ rows, granularity, view, basis, threshold }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const colCount = granularity === 'variation' ? 8 : 7;

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-sm" data-testid="defect-rate-table">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="text-left px-4 py-2.5 font-medium">製品</th>
            {granularity === 'variation' && (
              <th className="text-left px-4 py-2.5 font-medium">バリエーション</th>
            )}
            <th className="text-right px-4 py-2.5 font-medium">販売数</th>
            <th className="text-right px-4 py-2.5 font-medium">不良数</th>
            <th className="text-right px-4 py-2.5 font-medium">不良率</th>
            <th className="text-right px-4 py-2.5 font-medium">工場起因</th>
            <th className="text-left px-4 py-2.5 font-medium">主な原因</th>
            <th className="text-right px-4 py-2.5 font-medium">内訳(t/c/f)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ rowKey, productName, variationLabel, row }) => {
            const adjusted = applyViewToRow(row, view);
            const over =
              adjusted.rate != null && (row.sales_units ?? 0) > 0 && adjusted.rate >= threshold;
            const factoryRate =
              row.sales_units != null && row.sales_units > 0
                ? row.factory_cases / row.sales_units
                : null;
            const top2 = topCauses(adjusted.cause_breakdown, 2);
            const src = sourcesOfCases(adjusted.cases);
            const isOpen = expanded.has(rowKey);
            const expandable = adjusted.cases.length > 0;
            return (
              <Fragment key={rowKey}>
                  <tr
                    data-testid="defect-rate-row"
                    onClick={expandable ? () => toggle(rowKey) : undefined}
                    className={`border-t border-gray-100 ${over ? 'bg-rose-50/40' : ''} ${
                      expandable ? 'cursor-pointer hover:bg-gray-50/60' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {expandable ? (
                          isOpen ? (
                            <ChevronDown size={13} className="text-gray-400 shrink-0" />
                          ) : (
                            <ChevronRight size={13} className="text-gray-400 shrink-0" />
                          )
                        ) : (
                          <span className="w-[13px] shrink-0" />
                        )}
                        <div>
                          <div className="font-medium text-gray-900">{productName}</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            product_id: {row.group_id}
                          </div>
                        </div>
                      </div>
                    </td>
                    {granularity === 'variation' && (
                      <td className="px-4 py-3 text-gray-700">{variationLabel}</td>
                    )}
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {row.sales_units != null ? row.sales_units.toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {adjusted.total_cases}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums font-semibold ${
                        over ? 'text-rose-700' : 'text-gray-700'
                      }`}
                    >
                      {adjusted.rate != null ? formatPercent(adjusted.rate, 2) : '-'}
                      {over && (
                        <span className="ml-1 text-[10px] font-medium uppercase tracking-wide">
                          超過
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {row.factory_cases}
                      <span className="ml-1 text-[10px] text-gray-400">
                        ({factoryRate != null ? formatPercent(factoryRate, 2) : '-'})
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {top2.length > 0
                        ? top2.map((c) => `${c.label}${c.count}`).join('・')
                        : '-'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[11px] text-gray-400">
                      {src.tickets}/{src.csr}/{src.fba}
                    </td>
                  </tr>
                {isOpen && expandable && (
                  <CaseDrilldown
                    colCount={colCount}
                    adjustedCases={adjusted.cases}
                    causeBreakdown={adjusted.cause_breakdown}
                    salesUnits={row.sales_units}
                    basis={basis}
                  />
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** ドリルダウン (原因別内訳 + 案件一覧)。展開行として colSpan で全幅表示 */
function CaseDrilldown({
  colCount,
  adjustedCases,
  causeBreakdown,
  salesUnits,
  basis,
}: {
  colCount: number;
  adjustedCases: DefectCaseDetail[];
  causeBreakdown: Record<string, number>;
  salesUnits: number | null;
  basis: DefectBasis;
}) {
  // 原因ラベル → 責任区分 (同一ラベルが複数区分を持つ縁ケースは案件代表値と同じ優先順)
  const responsibilityByLabel = new Map<string, Responsibility[]>();
  for (const c of adjustedCases) {
    for (const cause of c.causes) {
      const list = responsibilityByLabel.get(cause.label) ?? [];
      list.push(cause.responsibility);
      responsibilityByLabel.set(cause.label, list);
    }
  }
  const causeRows = topCauses(causeBreakdown, Number.MAX_SAFE_INTEGER);

  return (
    <tr className="border-t border-gray-100 bg-gray-50/50" data-testid="defect-rate-drilldown">
      <td colSpan={colCount} className="px-6 py-4">
        <div className="space-y-4">
          {/* 原因別内訳 */}
          <div>
            <p className="text-[11px] font-medium text-gray-500 mb-1.5">原因別内訳</p>
            <table className="text-xs">
              <thead className="text-[10px] text-gray-400">
                <tr>
                  <th className="text-left pr-6 pb-1 font-medium">原因</th>
                  <th className="text-right pr-6 pb-1 font-medium">件数</th>
                  <th className="text-left pr-6 pb-1 font-medium">責任区分</th>
                  <th className="text-right pb-1 font-medium">率 (対販売数)</th>
                </tr>
              </thead>
              <tbody>
                {causeRows.map(({ label, count }) => (
                  <tr key={label} className="text-gray-700">
                    <td className="pr-6 py-0.5">{label}</td>
                    <td className="pr-6 py-0.5 text-right tabular-nums">{count}</td>
                    <td className="pr-6 py-0.5">
                      <ResponsibilityBadge
                        value={resolveCaseResponsibility(responsibilityByLabel.get(label) ?? [])}
                      />
                    </td>
                    <td className="py-0.5 text-right tabular-nums">
                      {salesUnits != null && salesUnits > 0
                        ? formatPercent(count / salesUnits, 2)
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 案件一覧 (発生日降順。顧客名・本文は出さない) */}
          <div>
            <p className="text-[11px] font-medium text-gray-500 mb-1.5">
              案件一覧 ({adjustedCases.length} 案件)
            </p>
            <div className="overflow-x-auto">
              <table className="text-xs min-w-full">
                <thead className="text-[10px] text-gray-400">
                  <tr>
                    <th className="text-left pr-4 pb-1 font-medium">発生日</th>
                    <th className="text-left pr-4 pb-1 font-medium">注文日</th>
                    <th className="text-left pr-4 pb-1 font-medium">経路</th>
                    <th className="text-left pr-4 pb-1 font-medium">原因</th>
                    <th className="text-left pr-4 pb-1 font-medium">責任区分</th>
                    <th className="text-left pr-4 pb-1 font-medium">注文番号</th>
                    <th className="text-left pb-1 font-medium">リンク</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustedCases.map((c, i) => (
                    <tr key={`${c.ticket_id ?? c.csr_id ?? i}-${i}`} className="text-gray-700" data-testid="defect-case-row">
                      <td className="pr-4 py-1 tabular-nums whitespace-nowrap">
                        {c.occurred_date || '-'}
                      </td>
                      <td className="pr-4 py-1 tabular-nums whitespace-nowrap">
                        {basis === 'ordered' && !c.order_date ? (
                          <span title="注文日不明のため発生日で代用">-</span>
                        ) : (
                          (c.order_date ?? '-')
                        )}
                      </td>
                      <td className="pr-4 py-1 whitespace-nowrap">{caseRouteLabel(c)}</td>
                      <td className="pr-4 py-1">
                        {c.causes.length > 0
                          ? c.causes
                              .map((x) => (x.fbaReason ? `${x.label} (${x.fbaReason})` : x.label))
                              .join('、')
                          : '-'}
                        {c.count > 1 && (
                          <span className="ml-1 text-[10px] text-gray-400">×{c.count}</span>
                        )}
                      </td>
                      <td className="pr-4 py-1">
                        <ResponsibilityBadge value={c.responsibility} />
                      </td>
                      <td className="pr-4 py-1 tabular-nums">
                        {c.order_numbers.length > 0 ? c.order_numbers.join(' / ') : '-'}
                      </td>
                      <td className="py-1 whitespace-nowrap">
                        {c.ticket_id && (
                          <Link
                            href={`/tickets/${encodeURIComponent(c.ticket_id)}`}
                            className="text-brand-700 hover:underline mr-2"
                          >
                            チケット
                          </Link>
                        )}
                        {c.csr_id && (
                          <Link
                            href={`/customer-records/${encodeURIComponent(c.csr_id)}`}
                            className="text-brand-700 hover:underline"
                          >
                            対応記録
                          </Link>
                        )}
                        {!c.ticket_id && !c.csr_id && <span className="text-gray-400">-</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}
