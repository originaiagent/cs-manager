/**
 * FBA 返品理由マッピング (src/lib/quality/return-reasons.ts) の単体テスト。
 * - 不良系コード → major_category + 日本語ラベル
 * - 顧客都合コード → 除外 (未分類に数えない)
 * - 未知コード → 未分類 (「未分類返品 n 件」の可視化対象)
 */
import { describe, it, expect } from 'vitest';
import {
  mapReturnReason,
  isKnownNonDefectReason,
  splitReturnsByReason,
  fbaReturnKey,
} from '@/lib/quality/return-reasons';

describe('mapReturnReason', () => {
  it('不良系の代表コードをマップする (fbaReason に理由コード原文を保持: C3a-1)', () => {
    expect(mapReturnReason('DEFECTIVE')).toEqual({
      majorCategory: 'function_defect',
      causeLabel: '不良・故障',
      fbaReason: 'DEFECTIVE',
    });
    expect(mapReturnReason('MISSING_PARTS')).toEqual({
      majorCategory: 'missing_part',
      causeLabel: '部品欠品',
      fbaReason: 'MISSING_PARTS',
    });
    expect(mapReturnReason('NOT_AS_DESCRIBED')).toEqual({
      majorCategory: 'description_mismatch',
      causeLabel: '説明と相違',
      fbaReason: 'NOT_AS_DESCRIBED',
    });
    expect(mapReturnReason('ITEM_DEFECTIVE')?.majorCategory).toBe('function_defect');
    expect(mapReturnReason('QUALITY_UNACCEPTABLE')?.causeLabel).toBe('品質不良');
  });

  it('大小文字・前後空白を正規化して照合する (fbaReason は正規化済み大文字)', () => {
    expect(mapReturnReason('defective')?.majorCategory).toBe('function_defect');
    expect(mapReturnReason('  DEFECTIVE  ')?.majorCategory).toBe('function_defect');
    expect(mapReturnReason('defective')?.fbaReason).toBe('DEFECTIVE');
  });

  it('顧客都合コードは undefined (不良集計から除外)', () => {
    expect(mapReturnReason('UNWANTED_ITEM')).toBeUndefined();
    expect(mapReturnReason('NO_REASON_GIVEN')).toBeUndefined();
    expect(mapReturnReason('APPAREL_STYLE')).toBeUndefined(); // 契約で明示的に含めない
    expect(mapReturnReason('ORDERED_WRONG_ITEM')).toBeUndefined();
  });

  it('配送中破損・倉庫内破損は製品不良ではないため undefined (不良集計から除外)', () => {
    // この画面は工場への製品改善要求のエビデンスであり、配送・倉庫由来の破損は
    // 製品不良ではない (定義パネル「配送中の破損・顧客都合の返品は不良に数えない」)。
    expect(mapReturnReason('DAMAGED_BY_FC')).toBeUndefined();
    expect(mapReturnReason('DAMAGED_BY_CARRIER')).toBeUndefined();
    expect(isKnownNonDefectReason('DAMAGED_BY_FC')).toBe(true);
    expect(isKnownNonDefectReason('DAMAGED_BY_CARRIER')).toBe(true);
  });

  it('未知コード・null・空文字は undefined', () => {
    expect(mapReturnReason('SOME_FUTURE_CODE')).toBeUndefined();
    expect(mapReturnReason(null)).toBeUndefined();
    expect(mapReturnReason(undefined)).toBeUndefined();
    expect(mapReturnReason('')).toBeUndefined();
  });
});

describe('isKnownNonDefectReason', () => {
  it('既知の顧客都合コードのみ true (未知コードとの区別)', () => {
    expect(isKnownNonDefectReason('UNWANTED_ITEM')).toBe(true);
    expect(isKnownNonDefectReason('unwanted_item')).toBe(true);
    expect(isKnownNonDefectReason('SOME_FUTURE_CODE')).toBe(false);
    expect(isKnownNonDefectReason('DEFECTIVE')).toBe(false);
    expect(isKnownNonDefectReason(null)).toBe(false);
  });
});

describe('splitReturnsByReason', () => {
  it('不良系 / 顧客都合(除外) / 未分類 の 3 バケットに振り分ける', () => {
    const rows = [
      { reason: 'DEFECTIVE', orderId: 'o1' },
      { reason: 'UNWANTED_ITEM', orderId: 'o2' },
      { reason: 'MYSTERY_CODE', orderId: 'o3' },
      { reason: null, orderId: 'o4' },
      { reason: 'MISSING_PARTS', orderId: 'o5' },
    ];
    const result = splitReturnsByReason(rows);

    expect(result.defects.map((d) => d.row.orderId)).toEqual(['o1', 'o5']);
    expect(result.defects[0].mapping.majorCategory).toBe('function_defect');
    expect(result.defects[1].mapping.causeLabel).toBe('部品欠品');

    expect(result.excluded.map((r) => r.orderId)).toEqual(['o2']);
    // 未知コードと理由なしは「未分類返品」として可視化対象
    expect(result.unclassified.map((r) => r.orderId)).toEqual(['o3', 'o4']);
  });

  it('空配列は全バケット空', () => {
    const result = splitReturnsByReason([]);
    expect(result.defects).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.unclassified).toEqual([]);
  });
});

describe('fbaReturnKey', () => {
  it('orderId|sku|returnDate を決定的に連結する', () => {
    expect(
      fbaReturnKey({ orderId: 'ORDER1', sku: 'SKU1', returnDate: '2026-07-01' }),
    ).toBe('ORDER1|SKU1|2026-07-01');
  });

  it('同一入力は常に同一キーを返す (cron とページローダの整合)', () => {
    const row = { orderId: 'ORDER2', sku: 'SKU2', returnDate: '2026-07-10' };
    expect(fbaReturnKey({ ...row })).toBe(fbaReturnKey({ ...row }));
  });

  it('各要素を trim してから連結する', () => {
    expect(
      fbaReturnKey({ orderId: '  ORDER3 ', sku: ' SKU3', returnDate: '2026-07-11 ' }),
    ).toBe('ORDER3|SKU3|2026-07-11');
  });

  it('null は空文字として扱う (区切り文字は保持)', () => {
    expect(fbaReturnKey({ orderId: 'ORDER4', sku: null, returnDate: null })).toBe('ORDER4||');
    expect(fbaReturnKey({ orderId: null, sku: null, returnDate: null })).toBe('||');
  });

  it('異なる入力は異なるキーを返す', () => {
    const a = fbaReturnKey({ orderId: 'ORDER5', sku: 'SKU5', returnDate: '2026-07-12' });
    const b = fbaReturnKey({ orderId: 'ORDER5', sku: 'SKU6', returnDate: '2026-07-12' });
    expect(a).not.toBe(b);
  });
});
