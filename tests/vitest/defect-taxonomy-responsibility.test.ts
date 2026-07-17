/**
 * 責任区分 (src/lib/quality/defect-taxonomy.ts C3a-1) の単体テスト。
 * - 原因単位: fbaReason 優先 → major_category マッピング
 * - 案件代表値: factory 優先 → logistics > listing > unverified
 */
import { describe, it, expect } from 'vitest';
import {
  resolveResponsibility,
  resolveCaseResponsibility,
  RESPONSIBILITY_LABELS,
  RESPONSIBILITIES,
  type Responsibility,
} from '@/lib/quality/defect-taxonomy';

describe('resolveResponsibility (原因単位)', () => {
  it('fbaReason があれば major より優先する', () => {
    // DAMAGED_BY_CARRIER は major=damaged (→factory) だが配送起因
    expect(
      resolveResponsibility({ majorCategory: 'damaged', fbaReason: 'DAMAGED_BY_CARRIER' }),
    ).toBe('logistics');
    expect(resolveResponsibility({ majorCategory: 'damaged', fbaReason: 'DAMAGED_BY_FC' })).toBe(
      'logistics',
    );
    expect(
      resolveResponsibility({ majorCategory: 'function_defect', fbaReason: 'DEFECTIVE' }),
    ).toBe('factory');
    expect(
      resolveResponsibility({ majorCategory: 'function_defect', fbaReason: 'ITEM_DEFECTIVE' }),
    ).toBe('factory');
    // QUALITY_UNACCEPTABLE は major=other (→unverified) だが工場起因
    expect(
      resolveResponsibility({ majorCategory: 'other', fbaReason: 'QUALITY_UNACCEPTABLE' }),
    ).toBe('factory');
    expect(
      resolveResponsibility({ majorCategory: 'missing_part', fbaReason: 'MISSING_PARTS' }),
    ).toBe('factory');
    expect(
      resolveResponsibility({
        majorCategory: 'description_mismatch',
        fbaReason: 'NOT_AS_DESCRIBED',
      }),
    ).toBe('listing');
  });

  it('fbaReason は大小文字・前後空白を正規化して照合する', () => {
    expect(
      resolveResponsibility({ majorCategory: 'damaged', fbaReason: ' damaged_by_carrier ' }),
    ).toBe('logistics');
  });

  it('未知の fbaReason は major マッピングにフォールバックする', () => {
    expect(
      resolveResponsibility({ majorCategory: 'function_defect', fbaReason: 'SOME_FUTURE_CODE' }),
    ).toBe('factory');
    expect(resolveResponsibility({ majorCategory: 'other', fbaReason: 'SOME_FUTURE_CODE' })).toBe(
      'unverified',
    );
  });

  it('fbaReason なし (AI/CSR 由来) は major で判定する', () => {
    expect(resolveResponsibility({ majorCategory: 'function_defect' })).toBe('factory');
    expect(resolveResponsibility({ majorCategory: 'missing_part' })).toBe('factory');
    // damaged→factory は v1 の割り切り (配送破損は FBA 理由コードでしか判別できない)
    expect(resolveResponsibility({ majorCategory: 'damaged' })).toBe('factory');
    expect(resolveResponsibility({ majorCategory: 'color_mismatch' })).toBe('factory');
    expect(resolveResponsibility({ majorCategory: 'size_mismatch' })).toBe('listing');
    expect(resolveResponsibility({ majorCategory: 'description_mismatch' })).toBe('listing');
    expect(resolveResponsibility({ majorCategory: 'other', fbaReason: null })).toBe('unverified');
  });
});

describe('resolveCaseResponsibility (案件代表値)', () => {
  it('1 つでも factory があれば factory', () => {
    expect(resolveCaseResponsibility(['unverified', 'logistics', 'factory'])).toBe('factory');
    expect(resolveCaseResponsibility(['factory'])).toBe('factory');
  });

  it('factory が無ければ logistics > listing > unverified の優先順', () => {
    expect(resolveCaseResponsibility(['unverified', 'listing', 'logistics'])).toBe('logistics');
    expect(resolveCaseResponsibility(['unverified', 'listing'])).toBe('listing');
    expect(resolveCaseResponsibility(['unverified'])).toBe('unverified');
  });

  it('原因が 1 つも無い案件は unverified (要精査)', () => {
    expect(resolveCaseResponsibility([])).toBe('unverified');
  });
});

describe('RESPONSIBILITY_LABELS', () => {
  it('全区分に日本語ラベルが定義されている', () => {
    for (const r of RESPONSIBILITIES) {
      expect(RESPONSIBILITY_LABELS[r as Responsibility]).toBeTruthy();
    }
    expect(RESPONSIBILITY_LABELS.factory).toBe('工場起因');
  });
});
