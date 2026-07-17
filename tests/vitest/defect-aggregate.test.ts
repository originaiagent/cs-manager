/**
 * defect-aggregate.ts (不良発生率 集計純関数) の単体テスト
 *
 * 契約 C2-4: 統合ルール 1〜4 を網羅する
 * (重複統合 / 複数原因 / quantity>1 / order 不一致 / legacy defect_type / sales 紐付け)。
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateDefectCases,
  extractOrderNumberFromChannelMeta,
  type DefectTicketInput,
  type DefectCsrInput,
  type FbaDefectReturnInput,
  type SalesUnitsInput,
} from '@/lib/quality/defect-aggregate';

// --- テストヘルパ (最小の入力生成) ---

function ticket(overrides: Partial<DefectTicketInput> = {}): DefectTicketInput {
  return {
    id: 't1',
    product_id: null,
    defect_type: null,
    causes: [],
    order_number: null,
    channel_code: null,
    ...overrides,
  };
}

function csr(overrides: Partial<DefectCsrInput> = {}): DefectCsrInput {
  return {
    id: 'c1',
    ticket_id: null,
    product_id: null,
    variation_id: null,
    variation_text: null,
    defect_type: null,
    order_number: null,
    order_channel: null,
    ...overrides,
  };
}

function fba(overrides: Partial<FbaDefectReturnInput> = {}): FbaDefectReturnInput {
  return {
    orderId: null,
    asin: null,
    quantity: 1,
    causeLabel: '不良・故障',
    majorCategory: 'function_defect',
    ...overrides,
  };
}

const NO_SALES: SalesUnitsInput = {
  available: false,
  groupUnits: new Map(),
  variationUnits: new Map(),
  unmappedUnits: 0,
};

function salesOf(args: {
  groups?: Array<[string, number]>;
  variations?: Array<[string, number]>;
  unmapped?: number;
}): SalesUnitsInput {
  return {
    available: true,
    groupUnits: new Map(args.groups ?? []),
    variationUnits: new Map(args.variations ?? []),
    unmappedUnits: args.unmapped ?? 0,
  };
}

function run(input: {
  tickets?: DefectTicketInput[];
  csrs?: DefectCsrInput[];
  fbaReturns?: FbaDefectReturnInput[];
  asinToChild?: Array<[string, string]>;
  childToGroup?: Array<[string, string]>;
  sales?: SalesUnitsInput;
}) {
  return aggregateDefectCases({
    tickets: input.tickets ?? [],
    csrs: input.csrs ?? [],
    fbaReturns: input.fbaReturns ?? [],
    resolution: {
      asinToChild: new Map(input.asinToChild ?? []),
      childToGroup: new Map(input.childToGroup ?? []),
    },
    sales: input.sales ?? NO_SALES,
  });
}

describe('aggregateDefectCases: ルール3 (単独案件)', () => {
  it('ticket 単独は 1 案件、子 product は childToGroup で親 group に集約される', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          causes: [{ label: '水が出ない', major: 'function_defect' }],
        }),
      ],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows).toHaveLength(1);
    expect(r.parentRows[0].group_id).toBe('group-A');
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.parentRows[0].cause_breakdown).toEqual({ 水が出ない: 1 });
    expect(r.parentRows[0].sources).toEqual({ tickets: 1, csr: 0, fba: 0 });
    // バリエーション行は子 product 単位
    expect(r.variationRows).toHaveLength(1);
    expect(r.variationRows[0].variation_child_id).toBe('child-1');
  });

  it('親 group 未解決の子 product は子 id をそのまま group 扱いにフォールバックする', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-x' })],
    });
    expect(r.parentRows[0].group_id).toBe('child-x');
  });

  it('CSR 単独は 1 案件 (product_id = 親 group 直指定)', () => {
    const r = run({
      csrs: [
        csr({ id: 'c1', product_id: 'group-A', variation_text: '赤', defect_type: '蓋が閉まらない' }),
      ],
    });
    expect(r.parentRows).toHaveLength(1);
    expect(r.parentRows[0].group_id).toBe('group-A');
    expect(r.parentRows[0].cause_breakdown).toEqual({ 蓋が閉まらない: 1 });
    expect(r.parentRows[0].sources).toEqual({ tickets: 0, csr: 1, fba: 0 });
    expect(r.variationRows[0].variation_text).toBe('赤');
  });

  it('製品未特定のまま残った案件は行にせず unmapped.defectCases に計上する', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: null })],
      csrs: [csr({ id: 'c1', product_id: null, defect_type: '不良' })],
    });
    expect(r.parentRows).toHaveLength(0);
    expect(r.unmapped.defectCases).toBe(2);
  });
});

describe('aggregateDefectCases: legacy defect_type フォールバック', () => {
  it('AI causes が無い ticket は旧 enum を DEFECT_TYPE_LABELS で日本語化して cause 扱いする', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-1', defect_type: 'damaged' })],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows[0].cause_breakdown).toEqual({ 破損: 1 });
    expect(r.parentRows[0].cause_majors['破損']).toBe('damaged');
  });

  it('AI causes がある ticket は defect_type を無視して causes を使う', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          defect_type: 'damaged',
          causes: [{ label: '水が出ない', major: 'function_defect' }],
        }),
      ],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows[0].cause_breakdown).toEqual({ 水が出ない: 1 });
  });
});

describe('aggregateDefectCases: ルール1 (CSR.ticket_id 統合)', () => {
  it('CSR.ticket_id 一致で同一案件へ統合 (原因和集合、製品情報は CSR 優先)', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          causes: [{ label: '水が出ない', major: 'function_defect' }],
        }),
      ],
      csrs: [
        csr({
          id: 'c1',
          ticket_id: 't1',
          product_id: 'group-B', // ticket 由来の group-A を CSR が上書き
          variation_id: 'child-2',
          variation_text: '青',
          defect_type: 'モーター異音',
        }),
      ],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows).toHaveLength(1);
    const row = r.parentRows[0];
    expect(row.group_id).toBe('group-B'); // CSR 優先
    expect(row.total_cases).toBe(1); // 統合されて 1 案件
    expect(row.cause_breakdown).toEqual({ 水が出ない: 1, モーター異音: 1 }); // 和集合
    expect(row.sources).toEqual({ tickets: 1, csr: 1, fba: 0 }); // 両ソースに計上
    expect(r.variationRows[0].variation_child_id).toBe('child-2');
    expect(r.variationRows[0].variation_text).toBe('青');
  });

  it('ticket_id が defect ticket に一致しない CSR は独立案件になる', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-1' })],
      csrs: [csr({ id: 'c1', ticket_id: 't-unknown', product_id: 'group-B', defect_type: '不良' })],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows).toHaveLength(2);
    const total = r.parentRows.reduce((s, row) => s + row.total_cases, 0);
    expect(total).toBe(2);
  });

  it('同一 ticket を参照する複数 CSR は 1 案件に折りたたまれる', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-1' })],
      csrs: [
        csr({ id: 'c1', ticket_id: 't1', product_id: 'group-A', defect_type: '異音' }),
        csr({ id: 'c2', ticket_id: 't1', product_id: 'group-A', defect_type: '発熱' }),
      ],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows).toHaveLength(1);
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.parentRows[0].cause_breakdown).toEqual({ 異音: 1, 発熱: 1 });
  });
});

describe('aggregateDefectCases: ルール4 (CSR 自由文字列と AI major の優先)', () => {
  it('CSR defect_type は major=other 扱い', () => {
    const r = run({
      csrs: [csr({ id: 'c1', product_id: 'group-A', defect_type: '蓋が閉まらない' })],
    });
    expect(r.parentRows[0].cause_majors['蓋が閉まらない']).toBe('other');
  });

  it('ticket AI cause と同一ラベルなら AI 側の major を優先する (CSR が後着でも)', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          causes: [{ label: '水が出ない', major: 'function_defect' }],
        }),
      ],
      csrs: [csr({ id: 'c1', ticket_id: 't1', product_id: 'group-A', defect_type: '水が出ない' })],
      childToGroup: [['child-1', 'group-A']],
    });
    const row = r.parentRows[0];
    expect(row.cause_breakdown).toEqual({ 水が出ない: 1 }); // 同一ラベルは 1 案件で 1
    expect(row.cause_majors['水が出ない']).toBe('function_defect'); // AI 優先
  });
});

describe('aggregateDefectCases: ルール2 (FBA 返品の order 統合)', () => {
  it('order_id が既存案件の注文番号に一致 → 同一案件へ統合 (案件数は増えない)', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          order_number: '249-1111111-1111111',
          causes: [{ label: '水が出ない', major: 'function_defect' }],
        }),
      ],
      fbaReturns: [
        fba({ orderId: '249-1111111-1111111', asin: 'B0TEST', quantity: 2, causeLabel: '不良・故障' }),
      ],
      asinToChild: [['B0TEST', 'child-9']],
      childToGroup: [
        ['child-1', 'group-A'],
        ['child-9', 'group-Z'],
      ],
    });
    expect(r.parentRows).toHaveLength(1);
    const row = r.parentRows[0];
    expect(row.group_id).toBe('group-A'); // 統合先 (ticket) の製品を維持
    expect(row.total_cases).toBe(1); // quantity は加算しない
    expect(row.cause_breakdown).toEqual({ 水が出ない: 1, '不良・故障': 1 });
    expect(row.sources).toEqual({ tickets: 1, csr: 0, fba: 1 });
  });

  it('CSR の order_number とも一致統合できる', () => {
    const r = run({
      csrs: [
        csr({
          id: 'c1',
          product_id: 'group-A',
          order_number: '249-2222222-2222222',
          defect_type: '破損',
        }),
      ],
      fbaReturns: [fba({ orderId: '249-2222222-2222222', asin: 'B0TEST' })],
      asinToChild: [['B0TEST', 'child-9']],
    });
    expect(r.parentRows).toHaveLength(1);
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.parentRows[0].sources.fba).toBe(1);
  });

  it('order 不一致 → 独立案件 (件数 = quantity、最低 1)', () => {
    const r = run({
      fbaReturns: [
        fba({ orderId: '503-3333333-3333333', asin: 'B0TEST', quantity: 3 }),
        fba({ orderId: '503-4444444-4444444', asin: 'B0TEST', quantity: 0 }), // 0 → 最低 1
      ],
      asinToChild: [['B0TEST', 'child-9']],
      childToGroup: [['child-9', 'group-Z']],
    });
    expect(r.parentRows).toHaveLength(1);
    const row = r.parentRows[0];
    expect(row.group_id).toBe('group-Z');
    expect(row.total_cases).toBe(4); // 3 + 1
    expect(row.cause_breakdown).toEqual({ '不良・故障': 4 });
    expect(row.sources).toEqual({ tickets: 0, csr: 0, fba: 4 });
  });

  it('同一 order の複数返品行は 1 案件に統合される (原因は和集合)', () => {
    const r = run({
      fbaReturns: [
        fba({ orderId: '503-5555555-5555555', asin: 'B0TEST', quantity: 1, causeLabel: '不良・故障' }),
        fba({
          orderId: '503-5555555-5555555',
          asin: 'B0TEST',
          quantity: 1,
          causeLabel: '部品欠品',
          majorCategory: 'missing_part',
        }),
      ],
      asinToChild: [['B0TEST', 'child-9']],
      childToGroup: [['child-9', 'group-Z']],
    });
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.parentRows[0].cause_breakdown).toEqual({ '不良・故障': 1, 部品欠品: 1 });
  });

  it('ASIN 解決不可の独立返品は行にせず unmapped.fbaReturns に quantity 換算で計上する', () => {
    const r = run({
      fbaReturns: [fba({ orderId: '503-6666666-6666666', asin: 'B0UNKNOWN', quantity: 2 })],
    });
    expect(r.parentRows).toHaveLength(0);
    expect(r.unmapped.fbaReturns).toBe(2);
  });

  it('製品未特定の CSR 案件は同一 order の FBA 返品 ASIN 解決で製品を補完する (案件数は増えない)', () => {
    const r = run({
      csrs: [
        csr({
          id: 'c1',
          product_id: null,
          order_number: '249-7777777-7777777',
          defect_type: '不良',
        }),
      ],
      fbaReturns: [
        fba({ orderId: '249-7777777-7777777', asin: 'B0TEST', causeLabel: '不良・故障' }),
      ],
      asinToChild: [['B0TEST', 'child-9']],
      childToGroup: [['child-9', 'group-Z']],
    });
    expect(r.parentRows).toHaveLength(1); // 案件数は増えず 1 件のまま
    const row = r.parentRows[0];
    expect(row.group_id).toBe('group-Z'); // FBA 由来の親 group 行に計上
    expect(row.total_cases).toBe(1);
    expect(row.cause_breakdown).toEqual({ 不良: 1, '不良・故障': 1 }); // CSR/FBA の和集合
    expect(row.sources).toEqual({ tickets: 0, csr: 1, fba: 1 }); // src.fba がカウントされる
    expect(r.unmapped.defectCases).toBe(0);
  });

  it('FBA 返品の ASIN が resolution.asinToChild に無い場合は製品未特定のまま残る (案件数は増えない)', () => {
    const r = run({
      csrs: [
        csr({
          id: 'c1',
          product_id: null,
          order_number: '249-8888888-8888888',
          defect_type: '不良',
        }),
      ],
      fbaReturns: [
        fba({ orderId: '249-8888888-8888888', asin: 'B0UNKNOWN', causeLabel: '不良・故障' }),
      ],
      // asinToChild に 'B0UNKNOWN' の解決先なし
      childToGroup: [['child-9', 'group-Z']],
    });
    expect(r.parentRows).toHaveLength(0); // 製品未特定のまま
    expect(r.unmapped.defectCases).toBe(1); // 案件数は増えない (1 案件のまま unmapped)
    expect(r.unmapped.fbaReturns).toBe(0); // order 統合済みのため未紐付け返品にはカウントしない
  });
});

describe('aggregateDefectCases: 販売数と不良率', () => {
  it('sales_units を紐付けて rate = total_cases / sales_units を計算する', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-1' })],
      childToGroup: [['child-1', 'group-A']],
      sales: salesOf({ groups: [['group-A', 200]], variations: [['child-1', 200]] }),
    });
    expect(r.parentRows[0].sales_units).toBe(200);
    expect(r.parentRows[0].rate).toBeCloseTo(1 / 200);
    expect(r.variationRows[0].sales_units).toBe(200);
  });

  it('不良ゼロの sales-only 行を補完する (親・バリエーション両方)', () => {
    const r = run({
      sales: salesOf({
        groups: [['group-B', 50]],
        variations: [['child-5', 50]],
      }),
      childToGroup: [['child-5', 'group-B']],
    });
    expect(r.parentRows).toHaveLength(1);
    expect(r.parentRows[0].total_cases).toBe(0);
    expect(r.parentRows[0].sales_units).toBe(50);
    expect(r.parentRows[0].rate).toBe(0);
    expect(r.variationRows).toHaveLength(1);
    expect(r.variationRows[0].variation_child_id).toBe('child-5');
  });

  it('販売数取得不可 (available=false) は sales_units / rate とも null', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-1' })],
      childToGroup: [['child-1', 'group-A']],
      sales: NO_SALES,
    });
    expect(r.parentRows[0].sales_units).toBeNull();
    expect(r.parentRows[0].rate).toBeNull();
    expect(r.unmapped.salesUnits).toBe(0);
  });

  it('unmappedUnits は pass-through で返す', () => {
    const r = run({ sales: salesOf({ unmapped: 42 }) });
    expect(r.unmapped.salesUnits).toBe(42);
  });

  it('rate 降順でソートされる (rate null は最後)', () => {
    const r = run({
      tickets: [
        ticket({ id: 't1', product_id: 'child-1' }),
        ticket({ id: 't2', product_id: 'child-2' }),
      ],
      childToGroup: [
        ['child-1', 'group-A'],
        ['child-2', 'group-B'],
      ],
      sales: salesOf({
        groups: [
          ['group-A', 1000], // rate 0.001
          ['group-B', 10], // rate 0.1
          ['group-C', 5], // 不良ゼロ rate 0
        ],
      }),
    });
    expect(r.parentRows.map((row) => row.group_id)).toEqual(['group-B', 'group-A', 'group-C']);
  });
});

describe('aggregateDefectCases: バリエーション行', () => {
  it('同一 group の別バリエーションは別行、variation 不明は (unknown) に集約', () => {
    const r = run({
      csrs: [
        csr({ id: 'c1', product_id: 'group-A', variation_id: 'child-1', defect_type: '異音' }),
        csr({ id: 'c2', product_id: 'group-A', variation_id: 'child-2', defect_type: '異音' }),
        csr({ id: 'c3', product_id: 'group-A', defect_type: '異音' }), // variation 不明
        csr({ id: 'c4', product_id: 'group-A', defect_type: '発熱' }), // variation 不明 (同一行へ)
      ],
    });
    expect(r.parentRows).toHaveLength(1);
    expect(r.parentRows[0].total_cases).toBe(4);
    expect(r.variationRows).toHaveLength(3);
    const unknownRow = r.variationRows.find((v) => v.variation_child_id == null);
    expect(unknownRow?.total_cases).toBe(2);
  });
});

describe('extractOrderNumberFromChannelMeta', () => {
  it('orderNumber / order_number / orderId の命名揺れを吸収する', () => {
    expect(extractOrderNumberFromChannelMeta({ orderNumber: '249-1' })).toBe('249-1');
    expect(extractOrderNumberFromChannelMeta({ order_number: '249-2' })).toBe('249-2');
    expect(extractOrderNumberFromChannelMeta({ orderId: '249-3' })).toBe('249-3');
    expect(extractOrderNumberFromChannelMeta({ order_no: 12345 })).toBe('12345');
  });

  it('注文番号キーが無い / 非 object は null', () => {
    expect(extractOrderNumberFromChannelMeta({ inquiryNumber: 'x' })).toBeNull();
    expect(extractOrderNumberFromChannelMeta(null)).toBeNull();
    expect(extractOrderNumberFromChannelMeta('str')).toBeNull();
    expect(extractOrderNumberFromChannelMeta({ orderNumber: '   ' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 工場エビデンス化 (C3a-2/C3a-4): 責任区分・案件明細・集計基準
// ---------------------------------------------------------------------------

describe('aggregateDefectCases: 責任区分 (C3a-2)', () => {
  it('案件代表の責任区分を count 換算で集計する (factory_cases / responsibility_breakdown)', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          causes: [{ label: '水が出ない', major: 'function_defect' }], // factory
        }),
      ],
      csrs: [
        csr({ id: 'c1', product_id: 'group-A', defect_type: '自由記述の不良' }), // other→unverified
      ],
      fbaReturns: [
        fba({
          orderId: '503-1111111-1111111',
          asin: 'B0TEST',
          quantity: 2,
          causeLabel: '配送中破損',
          majorCategory: 'damaged',
          fbaReason: 'DAMAGED_BY_CARRIER', // logistics (fbaReason 優先)
        }),
      ],
      asinToChild: [['B0TEST', 'child-1']],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows).toHaveLength(1);
    const row = r.parentRows[0];
    expect(row.total_cases).toBe(4); // 1 + 1 + 2
    expect(row.factory_cases).toBe(1);
    expect(row.responsibility_breakdown).toEqual({
      factory: 1,
      logistics: 2, // quantity=2 の FBA 独立案件
      listing: 0,
      unverified: 1,
    });
    // 合計 = total_cases
    const sum = Object.values(row.responsibility_breakdown).reduce((s, n) => s + n, 0);
    expect(sum).toBe(row.total_cases);
  });

  it('1 案件に factory 原因が 1 つでもあれば案件代表は factory', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          order_number: '503-2222222-2222222',
          causes: [{ label: 'サイズが違う', major: 'size_mismatch' }], // listing
        }),
      ],
      fbaReturns: [
        fba({
          orderId: '503-2222222-2222222',
          asin: 'B0TEST',
          causeLabel: '不良・故障',
          majorCategory: 'function_defect',
          fbaReason: 'DEFECTIVE', // factory
        }),
      ],
      asinToChild: [['B0TEST', 'child-1']],
      childToGroup: [['child-1', 'group-A']],
    });
    const row = r.parentRows[0];
    expect(row.total_cases).toBe(1);
    expect(row.factory_cases).toBe(1);
    expect(row.cases[0].responsibility).toBe('factory');
    expect(row.cases[0].causes.map((c) => c.responsibility).sort()).toEqual([
      'factory',
      'listing',
    ]);
  });

  it('同一ラベルが AI 側優先で残っても FBA 理由コードは保持され責任区分に効く', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          order_number: '503-3333333-3333333',
          causes: [{ label: '配送中破損', major: 'damaged' }], // AI 由来 (structured)
        }),
      ],
      fbaReturns: [
        fba({
          orderId: '503-3333333-3333333',
          asin: 'B0TEST',
          causeLabel: '配送中破損', // 同一ラベル
          majorCategory: 'damaged',
          fbaReason: 'DAMAGED_BY_CARRIER',
        }),
      ],
      asinToChild: [['B0TEST', 'child-1']],
      childToGroup: [['child-1', 'group-A']],
    });
    const detail = r.parentRows[0].cases[0];
    expect(detail.causes).toHaveLength(1);
    expect(detail.causes[0].fbaReason).toBe('DAMAGED_BY_CARRIER');
    expect(detail.causes[0].responsibility).toBe('logistics'); // fbaReason 優先
  });
});

describe('aggregateDefectCases: 案件明細 cases (C3a-2)', () => {
  it('明細に発生日 (最早値)・ソース・注文番号・リンク id が入る', () => {
    const r = run({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          order_number: '503-4444444-4444444',
          created_at: '2026-07-10T03:00:00Z', // JST 2026-07-10
          causes: [{ label: '水が出ない', major: 'function_defect' }],
        }),
      ],
      csrs: [
        csr({ id: 'c1', ticket_id: 't1', product_id: 'group-A', defect_type: '異音', record_date: '2026-07-08' }),
      ],
      fbaReturns: [
        fba({ orderId: '503-4444444-4444444', asin: 'B0TEST', returnDate: '2026-07-12', fbaReason: 'DEFECTIVE' }),
      ],
      asinToChild: [['B0TEST', 'child-1']],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows[0].cases).toHaveLength(1);
    const d = r.parentRows[0].cases[0];
    expect(d.occurred_date).toBe('2026-07-08'); // 統合元の最早値 (CSR)
    expect(d.order_date).toBeNull(); // orderDates 未指定
    expect(d.sources).toEqual(['ticket', 'csr', 'fba']);
    expect(d.order_numbers).toEqual(['503-4444444-4444444']);
    expect(d.count).toBe(1);
    expect(d.ticket_id).toBe('t1');
    expect(d.csr_id).toBe('c1');
    // バリエーション行にも同じ明細が入る
    expect(r.variationRows[0].cases).toHaveLength(1);
  });

  it('created_at (UTC) は JST 日付へ変換される (日跨ぎ)', () => {
    const r = run({
      tickets: [
        ticket({ id: 't1', product_id: 'child-1', created_at: '2026-07-09T16:00:00Z' }), // JST 7/10 1:00
      ],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows[0].cases[0].occurred_date).toBe('2026-07-10');
  });

  it('orderDates を渡すと明細の order_date に解決結果 (最早値) が入る', () => {
    const r = aggregateDefectCases({
      tickets: [
        ticket({
          id: 't1',
          product_id: 'child-1',
          order_number: '249-1111111-1111111',
          created_at: '2026-07-10T00:00:00Z',
        }),
      ],
      csrs: [],
      fbaReturns: [],
      resolution: { asinToChild: new Map(), childToGroup: new Map([['child-1', 'group-A']]) },
      sales: NO_SALES,
      orderDates: new Map([['249-1111111-1111111', '2026-06-20']]),
    });
    expect(r.parentRows[0].cases[0].order_date).toBe('2026-06-20');
  });

  it('明細は発生日降順に並ぶ', () => {
    const r = run({
      csrs: [
        csr({ id: 'c1', product_id: 'group-A', defect_type: '不良', record_date: '2026-07-01' }),
        csr({ id: 'c2', product_id: 'group-A', defect_type: '不良', record_date: '2026-07-05' }),
        csr({ id: 'c3', product_id: 'group-A', defect_type: '不良', record_date: '2026-07-03' }),
      ],
    });
    expect(r.parentRows[0].cases.map((c) => c.occurred_date)).toEqual([
      '2026-07-05',
      '2026-07-03',
      '2026-07-01',
    ]);
  });

  it('日付なしの legacy 入力は occurred_date が空文字 (後方互換・案件は落とさない)', () => {
    const r = run({
      tickets: [ticket({ id: 't1', product_id: 'child-1' })],
      childToGroup: [['child-1', 'group-A']],
    });
    expect(r.parentRows[0].cases[0].occurred_date).toBe('');
    expect(r.parentRows[0].total_cases).toBe(1);
  });

  it('sales-only 行は明細が空で責任区分は全ゼロ', () => {
    const r = run({ sales: salesOf({ groups: [['group-B', 50]] }) });
    expect(r.parentRows[0].cases).toEqual([]);
    expect(r.parentRows[0].factory_cases).toBe(0);
  });
});

describe('aggregateDefectCases: 集計基準 basis (C3a-4)', () => {
  const rangeJul = { start: '2026-07-01', end: '2026-07-31' };

  it('range 未指定は現行どおり全件 (後方互換)', () => {
    const r = run({
      csrs: [csr({ id: 'c1', product_id: 'group-A', defect_type: '不良', record_date: '2026-05-01' })],
    });
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.orderedFallbackCases).toBe(0);
  });

  it("basis='occurred': 発生日が期間外の案件を数えない", () => {
    const r = aggregateDefectCases({
      tickets: [],
      csrs: [
        csr({ id: 'c1', product_id: 'group-A', defect_type: '不良', record_date: '2026-07-10' }),
        csr({ id: 'c2', product_id: 'group-A', defect_type: '不良', record_date: '2026-08-05' }), // 期間外
      ],
      fbaReturns: [],
      resolution: { asinToChild: new Map(), childToGroup: new Map() },
      sales: NO_SALES,
      basis: 'occurred',
      range: rangeJul,
    });
    expect(r.parentRows[0].total_cases).toBe(1);
  });

  it("basis='ordered': 注文日が期間内の案件を数える (発生日が期間外でも)", () => {
    const r = aggregateDefectCases({
      tickets: [],
      csrs: [
        // 発生 8月 / 注文 7月 → ordered では数える
        csr({
          id: 'c1',
          product_id: 'group-A',
          defect_type: '不良',
          record_date: '2026-08-05',
          order_number: '408672-20260715-0123456789',
        }),
        // 発生 7月 / 注文 6月 → ordered では数えない
        csr({
          id: 'c2',
          product_id: 'group-A',
          defect_type: '不良',
          record_date: '2026-07-10',
          order_number: '408672-20260615-0123456789',
        }),
      ],
      fbaReturns: [],
      resolution: { asinToChild: new Map(), childToGroup: new Map() },
      sales: NO_SALES,
      basis: 'ordered',
      range: rangeJul,
      orderDates: new Map([
        ['408672-20260715-0123456789', '2026-07-15'],
        ['408672-20260615-0123456789', '2026-06-15'],
      ]),
    });
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.parentRows[0].cases[0].order_date).toBe('2026-07-15');
    expect(r.orderedFallbackCases).toBe(0);
  });

  it("basis='ordered': 注文日不明は発生日でフォールバックし件数を返す", () => {
    const r = aggregateDefectCases({
      tickets: [],
      csrs: [
        csr({ id: 'c1', product_id: 'group-A', defect_type: '不良', record_date: '2026-07-10' }), // 注文番号なし
        csr({ id: 'c2', product_id: 'group-A', defect_type: '不良', record_date: '2026-06-10' }), // 期間外→除外
      ],
      fbaReturns: [],
      resolution: { asinToChild: new Map(), childToGroup: new Map() },
      sales: NO_SALES,
      basis: 'ordered',
      range: rangeJul,
      orderDates: new Map(),
    });
    expect(r.parentRows[0].total_cases).toBe(1);
    expect(r.orderedFallbackCases).toBe(1); // c1 のみ (c2 はフォールバック日も期間外)
  });

  it('日付が全く取れない案件は fail-open で数える (黙って落とさない)', () => {
    const r = aggregateDefectCases({
      tickets: [ticket({ id: 't1', product_id: 'child-1' })], // created_at なし
      csrs: [],
      fbaReturns: [],
      resolution: { asinToChild: new Map(), childToGroup: new Map([['child-1', 'group-A']]) },
      sales: NO_SALES,
      basis: 'occurred',
      range: rangeJul,
    });
    expect(r.parentRows[0].total_cases).toBe(1);
  });

  it('未紐付け FBA 返品 (unmapped.fbaReturns) も基準日で絞られる', () => {
    const r = aggregateDefectCases({
      tickets: [],
      csrs: [],
      fbaReturns: [
        fba({ orderId: '503-1111111-1111111', asin: 'B0UNKNOWN', quantity: 2, returnDate: '2026-07-10' }),
        fba({ orderId: '503-2222222-2222222', asin: 'B0UNKNOWN', quantity: 3, returnDate: '2026-08-10' }), // 期間外
      ],
      resolution: { asinToChild: new Map(), childToGroup: new Map() },
      sales: NO_SALES,
      basis: 'occurred',
      range: rangeJul,
    });
    expect(r.unmapped.fbaReturns).toBe(2);
  });
});
