/**
 * defect-evidence-csv.ts (不良エビデンス CSV 生成純関数) の単体テスト — C3b-3
 *
 * 1 行 = 1 案件 × 1 原因 / 原因なし案件も 1 行 /
 * basis による基準日 / RFC4180 エスケープ / CRLF を検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  buildDefectEvidenceCsv,
  escapeCsvField,
  DEFECT_EVIDENCE_CSV_HEADER,
  type DefectEvidenceCsvRow,
} from '@/lib/quality/defect-evidence-csv';
import type { DefectAggRow, DefectCaseDetail } from '@/lib/quality/defect-aggregate';

// --- テストヘルパ ---

function caseDetail(overrides: Partial<DefectCaseDetail> = {}): DefectCaseDetail {
  return {
    occurred_date: '2026-07-01',
    order_date: '2026-06-20',
    sources: ['ticket'],
    causes: [{ label: '水が出ない', major: 'function_defect' }],
    order_numbers: ['408672-20260620-0001'],
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
    cases,
    ...overrides,
  };
}

function csvRow(overrides: Partial<DefectEvidenceCsvRow> = {}): DefectEvidenceCsvRow {
  return {
    row: aggRow(),
    productName: 'シャワーヘッド A',
    variationLabel: '',
    ...overrides,
  };
}

function lines(csv: string): string[] {
  return csv.split('\r\n').filter((l) => l !== '');
}

describe('escapeCsvField', () => {
  it('カンマ・引用符・改行を含む場合のみ引用しエスケープする', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('Excel 数式インジェクション対策: 先頭が = + - @ タブ CR の場合は単一引用符を前置する', () => {
    expect(escapeCsvField('=HYPERLINK("http://evil.com","click")')).toBe(
      "\"'=HYPERLINK(\"\"http://evil.com\"\",\"\"click\"\")\"",
    );
    expect(escapeCsvField('+1234')).toBe("'+1234");
    expect(escapeCsvField('-1234')).toBe("'-1234");
    expect(escapeCsvField('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
    expect(escapeCsvField('\tfoo')).toBe("'\tfoo");
    expect(escapeCsvField('\rfoo')).toBe("\"'\rfoo\"");
  });

  it('通常の日本語ラベル・負数でない通常値は変わらない', () => {
    expect(escapeCsvField('水が出ない')).toBe('水が出ない');
    expect(escapeCsvField('3')).toBe('3');
    expect(escapeCsvField('シャワーヘッド A')).toBe('シャワーヘッド A');
  });
});

describe('buildDefectEvidenceCsv', () => {
  it('ヘッダは契約の列順、明細は 1 案件 × 1 原因 = 1 行 (CRLF 区切り)', () => {
    const csv = buildDefectEvidenceCsv({
      rows: [
        csvRow({
          row: aggRow({
            cases: [
              caseDetail({
                causes: [
                  { label: '水が出ない', major: 'function_defect' },
                  {
                    label: '配送中破損',
                    major: 'damaged',
                    fbaReason: 'DAMAGED_BY_CARRIER',
                  },
                ],
              }),
            ],
          }),
        }),
      ],
      basis: 'occurred',
    });
    const ls = lines(csv);
    expect(ls[0]).toBe(DEFECT_EVIDENCE_CSV_HEADER.join(','));
    expect(ls).toHaveLength(3); // ヘッダ + 原因 2 行
    // 発生日 / 注文日 / 基準日(occurred=発生日) / 経路 / 原因 / 大分類 / FBA理由コード
    expect(ls[1]).toBe(
      'シャワーヘッド A,g1,,2026-07-01,2026-06-20,2026-07-01,チケット,水が出ない,機能不良,,408672-20260620-0001,1',
    );
    expect(ls[2]).toContain('配送中破損,破損・傷,DAMAGED_BY_CARRIER');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('basis=ordered の基準日は注文日 (不明案件は発生日で代用)', () => {
    const csv = buildDefectEvidenceCsv({
      rows: [
        csvRow({
          row: aggRow({
            cases: [
              caseDetail({ occurred_date: '2026-07-01', order_date: '2026-06-20' }),
              caseDetail({ occurred_date: '2026-07-05', order_date: null, order_numbers: [] }),
            ],
          }),
        }),
      ],
      basis: 'ordered',
    });
    const ls = lines(csv);
    expect(ls[1]).toContain(',2026-07-01,2026-06-20,2026-06-20,'); // 発生日,注文日,基準日=注文日
    expect(ls[2]).toContain(',2026-07-05,,2026-07-05,'); // 注文日不明 → 基準日=発生日
  });

  it('原因が 1 件も無い案件も 1 行出す (原因列は空)', () => {
    const csv = buildDefectEvidenceCsv({
      rows: [
        csvRow({
          row: aggRow({
            cases: [caseDetail({ causes: [], sources: ['csr'] })],
          }),
        }),
      ],
      basis: 'occurred',
    });
    const ls = lines(csv);
    expect(ls).toHaveLength(2);
    expect(ls[1]).toBe(
      'シャワーヘッド A,g1,,2026-07-01,2026-06-20,2026-07-01,対応記録,,,,408672-20260620-0001,1',
    );
  });

  it('カンマ・引用符を含むフィールドをエスケープする (製品名/原因ラベル)', () => {
    const csv = buildDefectEvidenceCsv({
      rows: [
        csvRow({
          productName: 'A, B "特売"',
          row: aggRow({
            cases: [
              caseDetail({
                causes: [{ label: '傷, 汚れ', major: 'damaged' }],
              }),
            ],
          }),
        }),
      ],
      basis: 'occurred',
    });
    const ls = lines(csv);
    expect(ls[1].startsWith('"A, B ""特売""",g1,')).toBe(true);
    expect(ls[1]).toContain('"傷, 汚れ"');
  });

  it('複数注文番号は | 連結、数量は count をそのまま出す', () => {
    const csv = buildDefectEvidenceCsv({
      rows: [
        csvRow({
          row: aggRow({
            cases: [
              caseDetail({
                count: 3,
                order_numbers: ['503-1234567-7654321', '408672-20260620-0001'],
              }),
            ],
          }),
        }),
      ],
      basis: 'occurred',
    });
    expect(lines(csv)[1]).toContain(',503-1234567-7654321|408672-20260620-0001,3');
  });

  it('バリエーション列は variationLabel をそのまま載せる (variation 粒度)', () => {
    const csv = buildDefectEvidenceCsv({
      rows: [csvRow({ variationLabel: 'ホワイト' })],
      basis: 'occurred',
    });
    expect(lines(csv)[1]).toContain('シャワーヘッド A,g1,ホワイト,');
  });
});
