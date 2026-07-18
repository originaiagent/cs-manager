'use client';

/**
 * 不良率テーブル (client component) — 症状別ハンドオフ (defect-symptom-handoff)
 *
 * トム承認済みモック仕様: 製品ごとに tbody を分け、症状別の内訳をクリック不要で
 * 常時表示する (旧: クリックで開くドリルダウンの中に隠れていた)。
 * 案件一覧 (個別案件の明細) は既存どおりクリック展開のドリルダウンとして残す。
 * データ取得・名寄せは server (page.tsx → defect-rate-data.ts) が行い、
 * ここには serializable な行 VM だけが渡る。
 * 顧客名・問い合わせ本文は表示しない (案件詳細はリンク先で見る)。
 */

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatPercent } from '@/lib/format';
import type { DefectAggRow, DefectBasis, DefectCaseDetail } from '@/lib/quality/defect-aggregate';
import { caseRouteLabel, topCauses } from '@/lib/quality/defect-view';

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
  basis: DefectBasis;
  /** 不良率の閾値 (超過時に行を強調) */
  threshold: number;
}

/** 症状行の常時表示上限 (症状ラベルは AI 自由出力で無制限になり得るため頭打ちする) */
const MAX_VISIBLE_CAUSES = 8;

/** 製品内の症状件数の最大値 (バー幅の相対計算用。症状無しは 0) */
function maxCauseCount(breakdown: Record<string, number>): number {
  const values = Object.values(breakdown);
  return values.length > 0 ? Math.max(...values) : 0;
}

/** 症状件数の合計 (breakdown は 1 案件が複数症状を持つと重複計上され得る) */
function sumCauseCount(breakdown: Record<string, number>): number {
  return Object.values(breakdown).reduce((sum, n) => sum + n, 0);
}

export default function DefectRateTable({ rows, granularity, basis, threshold }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const colCount = granularity === 'variation' ? 6 : 5;

  return (
    <div
      className="overflow-x-auto rounded-xl border border-gray-200 bg-white"
      data-testid="defect-rate-table-container"
    >
      <table
        className="w-full min-w-[760px] text-[16px] leading-[1.6] text-gray-700"
        data-testid="defect-rate-table"
      >
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2.5 text-left text-[13px] font-semibold tracking-[0.06em] text-gray-400">
              製品 / 症状
            </th>
            {granularity === 'variation' && (
              <th className="px-4 py-2.5 text-left text-[13px] font-semibold tracking-[0.06em] text-gray-400">
                バリエーション
              </th>
            )}
            <th className="px-4 py-2.5 text-right text-[13px] font-semibold tracking-[0.06em] text-gray-400">
              期間販売数
            </th>
            <th className="px-4 py-2.5 text-right text-[13px] font-semibold tracking-[0.06em] text-gray-400">
              不良数
            </th>
            <th className="px-4 py-2.5 text-right text-[13px] font-semibold tracking-[0.06em] text-gray-400">
              不良率
            </th>
            <th className="hidden w-[190px] px-4 py-2.5 text-left text-[13px] font-semibold tracking-[0.06em] text-gray-400 sm:table-cell">
              症状の内訳
            </th>
          </tr>
        </thead>
        {rows.map(({ rowKey, productName, variationLabel, row }) => {
          const over =
            row.rate != null && (row.sales_units ?? 0) > 0 && row.rate >= threshold;
          const isOpen = expanded.has(rowKey);
          const expandable = row.cases.length > 0;
          const allCauses = topCauses(row.cause_breakdown, Number.MAX_SAFE_INTEGER);
          const causes = allCauses.slice(0, MAX_VISIBLE_CAUSES);
          const hiddenCauseCount = allCauses.length - causes.length;
          const maxCount = maxCauseCount(row.cause_breakdown);
          const causeSum = sumCauseCount(row.cause_breakdown);
          const showMismatchNote = row.total_cases > 0 && causeSum !== row.total_cases;
          const noDefects = row.total_cases === 0;

          return (
            <tbody
              key={rowKey}
              className={`border-t border-gray-200 ${over ? 'bg-rose-50/40' : ''}`}
              data-testid="defect-rate-product-group"
            >
              {/* tr.product: 製品サマリ行 */}
              <tr
                data-testid="defect-rate-row"
                onClick={expandable ? () => toggle(rowKey) : undefined}
                className={expandable ? 'cursor-pointer hover:bg-gray-50/60' : ''}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    {expandable ? (
                      isOpen ? (
                        <ChevronDown size={14} className="shrink-0 text-gray-400" />
                      ) : (
                        <ChevronRight size={14} className="shrink-0 text-gray-400" />
                      )
                    ) : (
                      <span className="w-[14px] shrink-0" />
                    )}
                    <div>
                      <div className="text-[18px] font-semibold text-gray-900">{productName}</div>
                      <div className="mt-0.5 font-mono text-[12px] text-gray-400">
                        product_id: {row.group_id}
                      </div>
                    </div>
                  </div>
                </td>
                {granularity === 'variation' && (
                  <td className="px-4 py-3 text-gray-700">{variationLabel}</td>
                )}
                <td className="px-4 py-3 text-right text-[17px] tabular-nums text-gray-700">
                  {row.sales_units != null ? row.sales_units.toLocaleString() : '-'}
                </td>
                <td className="px-4 py-3 text-right text-[17px] font-semibold tabular-nums text-gray-900">
                  {row.total_cases.toLocaleString()}
                </td>
                <td
                  className={`px-4 py-3 text-right text-[22px] font-bold tabular-nums ${
                    over ? 'text-rose-700' : noDefects ? 'text-gray-400' : 'text-gray-900'
                  }`}
                >
                  {row.rate != null ? formatPercent(row.rate, 2) : '-'}
                  {over && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-rose-600 px-2 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide text-white">
                      超過
                    </span>
                  )}
                </td>
                <td className="hidden px-4 py-3 sm:table-cell" />
              </tr>

              {/* tr.cause × N: 症状行 (クリック不要・常時表示) */}
              {noDefects ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-3 text-[15px] text-gray-400">
                    この期間に不良の報告なし
                  </td>
                </tr>
              ) : (
                <>
                  {causes.map(({ label, count }) => {
                    const rate =
                      row.sales_units != null && row.sales_units > 0
                        ? count / row.sales_units
                        : null;
                    const barPct = maxCount > 0 ? Math.max((count / maxCount) * 100, 3) : 0;
                    return (
                      <tr key={label} data-testid="defect-rate-cause-row">
                        <td className="py-1.5 pl-8 pr-4">
                          <span className="font-mono text-[15px] text-gray-400">┗</span>{' '}
                          <span className="text-[16px] text-gray-700">{label}</span>
                        </td>
                        {granularity === 'variation' && <td className="px-4 py-1.5" />}
                        <td className="px-4 py-1.5" />
                        <td className="px-4 py-1.5 text-right text-[16px] tabular-nums text-gray-700">
                          {count.toLocaleString()}
                        </td>
                        <td className="px-4 py-1.5 text-right text-[16px] font-semibold tabular-nums text-gray-700">
                          {rate != null ? formatPercent(rate, 2) : '-'}
                        </td>
                        <td className="hidden px-4 py-1.5 sm:table-cell">
                          <div className="h-[9px] w-full rounded-full bg-gray-100">
                            <div
                              className={`h-full rounded-full ${over ? 'bg-rose-500' : 'bg-brand-500'}`}
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {hiddenCauseCount > 0 && (
                    <tr data-testid="defect-rate-cause-row-more">
                      <td colSpan={colCount} className="py-1.5 pl-8 pr-4 text-[13px] text-gray-400">
                        他 {hiddenCauseCount} 件の症状
                      </td>
                    </tr>
                  )}
                </>
              )}

              {/* 症状の合計 ≠ 不良数 のときだけ注記 */}
              {showMismatchNote && (
                <tr>
                  <td colSpan={colCount} className="px-4 pb-2 text-[13px] text-gray-400">
                    ※ 1件に複数の症状があるため、症状の合計({causeSum})は不良数({row.total_cases}
                    )と一致しない
                  </td>
                </tr>
              )}

              {/* 案件ドリルダウン (個別案件の明細) */}
              {isOpen && expandable && (
                <CaseDrilldown colCount={colCount} cases={row.cases} basis={basis} />
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** ドリルダウン (案件一覧)。展開行として colSpan で全幅表示 */
function CaseDrilldown({
  colCount,
  cases,
  basis,
}: {
  colCount: number;
  cases: DefectCaseDetail[];
  basis: DefectBasis;
}) {
  return (
    <tr className="border-t border-gray-100 bg-gray-50/50" data-testid="defect-rate-drilldown">
      <td colSpan={colCount} className="px-6 py-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-gray-500">
            案件一覧 ({cases.length} 案件)
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-[13px]">
              <thead className="text-[11px] text-gray-400">
                <tr>
                  <th className="pb-1 pr-4 text-left font-medium">発生日</th>
                  <th className="pb-1 pr-4 text-left font-medium">注文日</th>
                  <th className="pb-1 pr-4 text-left font-medium">経路</th>
                  <th className="pb-1 pr-4 text-left font-medium">症状</th>
                  <th className="pb-1 pr-4 text-left font-medium">注文番号</th>
                  <th className="pb-1 text-left font-medium">リンク</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c, i) => (
                  <tr
                    key={`${c.ticket_id ?? c.csr_id ?? i}-${i}`}
                    className="text-gray-700"
                    data-testid="defect-case-row"
                  >
                    <td className="whitespace-nowrap py-1 pr-4 tabular-nums">
                      {c.occurred_date || '-'}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-4 tabular-nums">
                      {basis === 'ordered' && !c.order_date ? (
                        <span title="注文日不明のため発生日で代用">-</span>
                      ) : (
                        (c.order_date ?? '-')
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-4">{caseRouteLabel(c)}</td>
                    <td className="py-1 pr-4">
                      {c.causes.length > 0 ? c.causes.map((x) => x.label).join('、') : '-'}
                      {c.count > 1 && (
                        <span className="ml-1 text-[11px] text-gray-400">×{c.count}</span>
                      )}
                    </td>
                    <td className="py-1 pr-4 tabular-nums">
                      {c.order_numbers.length > 0 ? c.order_numbers.join(' / ') : '-'}
                    </td>
                    <td className="whitespace-nowrap py-1">
                      {c.ticket_id && (
                        <Link
                          href={`/tickets/${encodeURIComponent(c.ticket_id)}`}
                          className="mr-2 text-brand-700 hover:underline"
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
      </td>
    </tr>
  );
}
