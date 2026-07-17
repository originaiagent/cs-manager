/**
 * defect-view.ts (表示切替純関数) の単体テスト — 工場エビデンス化 C3b-2
 *
 * view=factory の案件フィルタ / 不良数・率・原因内訳の再計算 / 除外内訳 /
 * 経路ラベル / 基準日、および defect-aggregate の channel_code additive 追加を検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  filterCasesByView,
  applyViewToRow,
  excludedByResponsibility,
  topCauses,
  caseRouteLabel,
  caseBasisDate,
} from '@/lib/quality/defect-view';
import {
  aggregateDefectCases,
  type DefectAggRow,
  type DefectCaseDetail,
} from '@/lib/quality/defect-aggregate';

// --- テストヘルパ (最小の明細/行生成) ---

function caseDetail(overrides: Partial<DefectCaseDetail> = {}): DefectCaseDetail {
  return {
    occurred_date: '2026-07-01',
    order_date: null,
    sources: ['ticket'],
    causes: [{ label: '水が出ない', major: 'function_defect', responsibility: 'factory' }],
    responsibility: 'factory',
    order_numbers: [],
    count: 1,
    ...overrides,
  };
}

function aggRow(overrides: Partial<DefectAggRow> = {}): DefectAggRow {
  const cases = overrides.cases ?? [caseDetail()];
  return {
    group_id: 'g1',
    variation_child_id: null,
    variation_text: null,
    total_cases: cases.reduce((a, c) => a + c.count, 0),
    cause_breakdown: {},
    cause_majors: {},
    sources: { tickets: 0, csr: 0, fba: 0 },
    sales_units: 100,
    rate: null,
    factory_cases: 0,
    responsibility_breakdown: { factory: 0, logistics: 0, listing: 0, unverified: 0 },
    cases,
    ...overrides,
  };
}

describe('filterCasesByView', () => {
  it('all は全案件をそのまま返す', () => {
    const cases = [
      caseDetail({ responsibility: 'factory' }),
      caseDetail({ responsibility: 'logistics' }),
    ];
    expect(filterCasesByView(cases, 'all')).toHaveLength(2);
  });

  it('factory は案件代表の責任区分 = factory のみ返す', () => {
    const cases = [
      caseDetail({ responsibility: 'factory' }),
      caseDetail({ responsibility: 'logistics' }),
      caseDetail({ responsibility: 'unverified' }),
    ];
    const filtered = filterCasesByView(cases, 'factory');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].responsibility).toBe('factory');
  });
});

describe('applyViewToRow', () => {
  const row = aggRow({
    sales_units: 200,
    cases: [
      caseDetail({
        responsibility: 'factory',
        count: 2,
        causes: [
          { label: '水が出ない', major: 'function_defect', responsibility: 'factory' },
          { label: '傷', major: 'damaged', responsibility: 'factory' },
        ],
      }),
      caseDetail({
        responsibility: 'logistics',
        count: 1,
        causes: [
          {
            label: '配送中破損',
            major: 'damaged',
            responsibility: 'logistics',
            fbaReason: 'DAMAGED_BY_CARRIER',
          },
        ],
      }),
    ],
  });

  it('all: 不良数 = 全案件 count 合計、原因内訳は案件 count を各ラベルへ加算', () => {
    const adjusted = applyViewToRow(row, 'all');
    expect(adjusted.total_cases).toBe(3);
    expect(adjusted.rate).toBeCloseTo(3 / 200);
    expect(adjusted.cause_breakdown).toEqual({ 水が出ない: 2, 傷: 2, 配送中破損: 1 });
  });

  it('factory: factory 案件のみで不良数・率・原因内訳を再計算する', () => {
    const adjusted = applyViewToRow(row, 'factory');
    expect(adjusted.total_cases).toBe(2);
    expect(adjusted.rate).toBeCloseTo(2 / 200);
    expect(adjusted.cause_breakdown).toEqual({ 水が出ない: 2, 傷: 2 });
    expect(adjusted.cases).toHaveLength(1);
  });

  it('sales_units が null/0 のとき rate は null', () => {
    expect(applyViewToRow(aggRow({ sales_units: null }), 'all').rate).toBeNull();
    expect(applyViewToRow(aggRow({ sales_units: 0 }), 'all').rate).toBeNull();
  });
});

describe('excludedByResponsibility', () => {
  it('行集合の factory 以外の責任区分別案件数を合算する', () => {
    const rows = [
      aggRow({
        responsibility_breakdown: { factory: 3, logistics: 2, listing: 1, unverified: 0 },
      }),
      aggRow({
        responsibility_breakdown: { factory: 1, logistics: 1, listing: 0, unverified: 4 },
      }),
    ];
    expect(excludedByResponsibility(rows)).toEqual({ logistics: 3, listing: 1, unverified: 4 });
  });
});

describe('topCauses', () => {
  it('件数降順 → ラベル昇順で上位 n 件を返す', () => {
    const top = topCauses({ 傷: 5, 水が出ない: 10, 部品欠品: 5 }, 2);
    expect(top).toEqual([
      { label: '水が出ない', count: 10 },
      { label: '傷', count: 5 },
    ]);
  });

  it('空の内訳は空配列', () => {
    expect(topCauses({}, 2)).toEqual([]);
  });
});

describe('caseRouteLabel', () => {
  it('ticket 由来はチャネルコードを日本語化して表示する', () => {
    expect(caseRouteLabel(caseDetail({ sources: ['ticket'], channel_code: 'rakuten' }))).toBe(
      '楽天',
    );
    expect(caseRouteLabel(caseDetail({ sources: ['ticket'], channel_code: 'email' }))).toBe(
      'メール',
    );
  });

  it('チャネル不明の ticket は「チケット」、未知コードは原文表示', () => {
    expect(caseRouteLabel(caseDetail({ sources: ['ticket'] }))).toBe('チケット');
    expect(caseRouteLabel(caseDetail({ sources: ['ticket'], channel_code: 'qoo10' }))).toBe(
      'qoo10',
    );
  });

  it('複数ソース統合案件は + で連結する', () => {
    expect(
      caseRouteLabel(
        caseDetail({ sources: ['ticket', 'csr', 'fba'], channel_code: 'rakuten' }),
      ),
    ).toBe('楽天+対応記録+FBA返品');
  });

  it('fba 単独は FBA返品', () => {
    expect(caseRouteLabel(caseDetail({ sources: ['fba'] }))).toBe('FBA返品');
  });
});

describe('caseBasisDate', () => {
  it('occurred は発生日、ordered は注文日 (不明時は発生日で代用)', () => {
    const withOrder = caseDetail({ occurred_date: '2026-07-01', order_date: '2026-06-20' });
    expect(caseBasisDate(withOrder, 'occurred')).toBe('2026-07-01');
    expect(caseBasisDate(withOrder, 'ordered')).toBe('2026-06-20');
    const noOrder = caseDetail({ occurred_date: '2026-07-01', order_date: null });
    expect(caseBasisDate(noOrder, 'ordered')).toBe('2026-07-01');
  });
});

describe('aggregateDefectCases channel_code (C3b additive)', () => {
  const emptySales = {
    available: false,
    groupUnits: new Map<string, number>(),
    variationUnits: new Map<string, number>(),
    unmappedUnits: 0,
  };
  const emptyResolution = {
    asinToChild: new Map<string, string>(),
    childToGroup: new Map<string, string>(),
  };

  it('ticket の channel_code が案件明細に載る', () => {
    const res = aggregateDefectCases({
      tickets: [
        {
          id: 't1',
          product_id: 'p1',
          defect_type: null,
          causes: [{ label: '水が出ない', major: 'function_defect' }],
          order_number: null,
          channel_code: 'rakuten',
          created_at: '2026-07-01T00:00:00Z',
        },
      ],
      csrs: [],
      fbaReturns: [],
      resolution: emptyResolution,
      sales: emptySales,
    });
    expect(res.parentRows[0].cases[0].channel_code).toBe('rakuten');
  });

  it('ticket チャネルが無い CSR 単独案件は order_channel で補完する', () => {
    const res = aggregateDefectCases({
      tickets: [],
      csrs: [
        {
          id: 'c1',
          ticket_id: null,
          product_id: 'g1',
          variation_id: null,
          variation_text: null,
          defect_type: '傷',
          order_number: null,
          order_channel: 'amazon',
          record_date: '2026-07-01',
        },
      ],
      fbaReturns: [],
      resolution: emptyResolution,
      sales: emptySales,
    });
    expect(res.parentRows[0].cases[0].channel_code).toBe('amazon');
  });
});
