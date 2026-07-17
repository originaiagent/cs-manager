/**
 * 不良分類の抽出関数 (src/lib/quality/defect-classify.ts extractClassification) の単体テスト。
 * - structured_output 優先 / 本文 JSON フォールバック
 * - category 正規化 (許可値以外は null = 分類失敗)
 * - causes の検証 (defect のみ、最大 3 件、重複除去、major 正規化)
 */
import { describe, it, expect } from 'vitest';
import { extractClassification } from '@/lib/quality/defect-classify';

describe('extractClassification: structured_output 優先', () => {
  it('structured から category + causes を抽出する', () => {
    const result = extractClassification(
      {
        category: 'defect',
        causes: [{ label: '水が出ない', major_category: 'function_defect' }],
      },
      '',
    );
    expect(result.category).toBe('defect');
    expect(result.causes).toEqual([
      { label: '水が出ない', major_category: 'function_defect' },
    ]);
  });

  it('category は大小文字・空白を正規化する', () => {
    const result = extractClassification({ category: ' Defect ' , causes: [] }, '');
    expect(result.category).toBe('defect');
  });

  it('defect 以外は causes を返さない (与えられても無視)', () => {
    const result = extractClassification(
      { category: 'shipping', causes: [{ label: 'x', major_category: 'other' }] },
      '',
    );
    expect(result.category).toBe('shipping');
    expect(result.causes).toEqual([]);
  });

  it('structured の category が不正なら本文フォールバックへ落ちる', () => {
    const result = extractClassification(
      { category: 'unknown_category' },
      '{"category":"usage"}',
    );
    expect(result.category).toBe('usage');
  });
});

describe('extractClassification: 本文フォールバック', () => {
  it('本文が素の JSON なら抽出する', () => {
    const result = extractClassification(null, '{"category":"other"}');
    expect(result.category).toBe('other');
  });

  it('コードフェンス等の前後テキストがあっても {} 区間から抽出する', () => {
    const message = [
      '分類結果は以下です。',
      '```json',
      '{"category":"defect","causes":[{"label":"電源が入らない","major_category":"function_defect"}]}',
      '```',
    ].join('\n');
    const result = extractClassification(undefined, message);
    expect(result.category).toBe('defect');
    expect(result.causes[0]).toEqual({
      label: '電源が入らない',
      major_category: 'function_defect',
    });
  });

  it('抽出不能なら category=null (分類失敗扱い)', () => {
    expect(extractClassification(null, 'すみません、わかりません').category).toBeNull();
    expect(extractClassification(null, '').category).toBeNull();
    expect(extractClassification(undefined, '{"category":"invalid"}').category).toBeNull();
  });
});

describe('extractClassification: causes の検証', () => {
  it('最大 3 件にクランプし、重複ラベルは除去する', () => {
    const result = extractClassification(
      {
        category: 'defect',
        causes: [
          { label: '水が出ない', major_category: 'function_defect' },
          { label: '水が出ない', major_category: 'other' }, // 重複 → 除去
          { label: '部品が足りない', major_category: 'missing_part' },
          { label: '蓋が割れていた', major_category: 'damaged' },
          { label: '色が違う', major_category: 'color_mismatch' }, // 4 件目 → 切り捨て
        ],
      },
      '',
    );
    expect(result.causes).toHaveLength(3);
    expect(result.causes.map((c) => c.label)).toEqual([
      '水が出ない',
      '部品が足りない',
      '蓋が割れていた',
    ]);
  });

  it('不正な major_category は other に正規化、空ラベルはスキップ', () => {
    const result = extractClassification(
      {
        category: 'defect',
        causes: [
          { label: '異音がする', major_category: 'not_a_category' },
          { label: '   ', major_category: 'damaged' }, // 空ラベル → スキップ
          { major_category: 'damaged' }, // ラベル無し → スキップ
        ],
      },
      '',
    );
    expect(result.causes).toEqual([{ label: '異音がする', major_category: 'other' }]);
  });

  it('causes が無い defect は空配列 (分類自体は成功)', () => {
    const result = extractClassification({ category: 'defect' }, '');
    expect(result.category).toBe('defect');
    expect(result.causes).toEqual([]);
  });

  it('長すぎるラベルは防御的にクランプする', () => {
    const longLabel = 'あ'.repeat(100);
    const result = extractClassification(
      { category: 'defect', causes: [{ label: longLabel, major_category: 'other' }] },
      '',
    );
    expect(result.causes[0].label.length).toBeLessThanOrEqual(30);
  });
});
