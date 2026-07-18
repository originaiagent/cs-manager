/**
 * 分類2cron embed 経路の fail-closed 形状検証 (src/lib/quality/classify-embed.ts +
 * defect-classify.ts / return-comment-classify.ts の embed 専用バリデータ) の単体テスト。
 *
 * codex 設計レビュー APPROVE の追加条件を回帰させる:
 *   - trim / toLowerCase / normalizeMajorCategory による正規化・救済をしない (enum 完全一致のみ)
 *   - causes/symptoms は配列必須・0〜3件 (欠落・非配列・4件以上は invalid)
 *   - 不正要素 (label 空・major_category 非enum) は黙って除外せず結果全体を invalid にする
 *   - 重複 label も invalid 扱い
 */
import { describe, it, expect } from 'vitest';
import { validateEmbedCauseArray } from '@/lib/quality/classify-embed';
import { validateEmbedDefectResult } from '@/lib/quality/defect-classify';
import { validateEmbedReturnSymptomsResult } from '@/lib/quality/return-comment-classify';

describe('validateEmbedCauseArray (共通形状検証)', () => {
  it('正常な 0〜3件は通す', () => {
    expect(validateEmbedCauseArray([])).toEqual([]);
    expect(
      validateEmbedCauseArray([{ label: '水が出ない', major_category: 'function_defect' }]),
    ).toEqual([{ label: '水が出ない', major_category: 'function_defect' }]);
  });

  it('欠落・非配列は invalid', () => {
    expect(validateEmbedCauseArray(undefined)).toBeNull();
    expect(validateEmbedCauseArray(null)).toBeNull();
    expect(validateEmbedCauseArray('not-an-array')).toBeNull();
    expect(validateEmbedCauseArray({ label: 'x' })).toBeNull();
  });

  it('4件以上は invalid (黙って先頭3件に切り詰めない)', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      label: `症状${i}`,
      major_category: 'other',
    }));
    expect(validateEmbedCauseArray(four)).toBeNull();
  });

  it('不正な major_category (enum 非完全一致) は要素1件でも結果全体を invalid にする', () => {
    expect(
      validateEmbedCauseArray([
        { label: '水が出ない', major_category: 'function_defect' },
        { label: '謎の不具合', major_category: 'not_a_category' },
      ]),
    ).toBeNull();
  });

  it('major_category の大文字・空白は正規化せず invalid (toLowerCase/trim 不使用)', () => {
    expect(
      validateEmbedCauseArray([{ label: '水が出ない', major_category: ' Function_Defect ' }]),
    ).toBeNull();
  });

  it('label 空文字は invalid', () => {
    expect(validateEmbedCauseArray([{ label: '', major_category: 'other' }])).toBeNull();
  });

  it('label が空白のみ ("   " 等) は invalid (trim せず非空文字列として救済しない・codex CONCERN回帰)', () => {
    expect(validateEmbedCauseArray([{ label: '   ', major_category: 'other' }])).toBeNull();
    expect(validateEmbedCauseArray([{ label: '　', major_category: 'other' }])).toBeNull(); // 全角スペース
    expect(validateEmbedCauseArray([{ label: '\t\n', major_category: 'other' }])).toBeNull();
  });

  it('label は判定にのみ trim を使い、保存値は原文のまま (前後空白ありの有効文字列は trim せず通す)', () => {
    // 判定 (trim().length===0 か) と保存値 (label そのまま) を混同しないことの確認。
    // 前後に空白があっても非空白文字を含む label は invalid にしない (救済的な trim 保存もしない)。
    const got = validateEmbedCauseArray([{ label: ' 水が出ない ', major_category: 'function_defect' }]);
    expect(got).toEqual([{ label: ' 水が出ない ', major_category: 'function_defect' }]);
  });

  it('label / major_category 欠落要素は invalid', () => {
    expect(validateEmbedCauseArray([{ major_category: 'other' }])).toBeNull();
    expect(validateEmbedCauseArray([{ label: '割れ' }])).toBeNull();
  });

  it('重複 label は黙って畳まず invalid にする (旧経路の seen.has skip とは別物)', () => {
    expect(
      validateEmbedCauseArray([
        { label: '水が出ない', major_category: 'function_defect' },
        { label: '水が出ない', major_category: 'other' },
      ]),
    ).toBeNull();
  });

  it('要素が object でない (配列/プリミティブ) は invalid', () => {
    expect(validateEmbedCauseArray(['x', 'y'])).toBeNull();
    expect(validateEmbedCauseArray([['nested'], {}])).toBeNull();
  });
});

describe('validateEmbedDefectResult (defect-classify.ts)', () => {
  it('正常: defect + causes 1件', () => {
    const got = validateEmbedDefectResult({
      category: 'defect',
      causes: [{ label: '水が出ない', major_category: 'function_defect' }],
    });
    expect(got).toEqual({
      category: 'defect',
      causes: [{ label: '水が出ない', major_category: 'function_defect' }],
    });
  });

  it('category が許可 enum に完全一致しない (大文字/空白含む) は invalid', () => {
    expect(validateEmbedDefectResult({ category: 'Defect', causes: [] })).toBeNull();
    expect(validateEmbedDefectResult({ category: ' defect ', causes: [] })).toBeNull();
    expect(validateEmbedDefectResult({ category: 'unknown_category', causes: [] })).toBeNull();
  });

  it('causes 欠落 (配列必須) は invalid', () => {
    expect(validateEmbedDefectResult({ category: 'other' })).toBeNull();
  });

  it('causes が4件以上は invalid', () => {
    const causes = Array.from({ length: 4 }, (_, i) => ({
      label: `症状${i}`,
      major_category: 'other',
    }));
    expect(validateEmbedDefectResult({ category: 'defect', causes })).toBeNull();
  });

  it('defect 以外の category は causes を持たせない (形状検証は通した上で意味論的に空にする)', () => {
    const got = validateEmbedDefectResult({ category: 'shipping', causes: [] });
    expect(got).toEqual({ category: 'shipping', causes: [] });
  });

  it('result 自体が object でない/配列は invalid', () => {
    expect(validateEmbedDefectResult(null)).toBeNull();
    expect(validateEmbedDefectResult('defect')).toBeNull();
    expect(validateEmbedDefectResult([])).toBeNull();
  });
});

describe('validateEmbedReturnSymptomsResult (return-comment-classify.ts)', () => {
  it('正常: symptoms 1件', () => {
    const got = validateEmbedReturnSymptomsResult({
      symptoms: [{ label: '水が出ない', major_category: 'function_defect' }],
    });
    expect(got).toEqual([{ label: '水が出ない', major_category: 'function_defect' }]);
  });

  it('symptoms:[] (症状なし) は正常成功として通す', () => {
    expect(validateEmbedReturnSymptomsResult({ symptoms: [] })).toEqual([]);
  });

  it('symptoms 欠落 (配列必須) は invalid', () => {
    expect(validateEmbedReturnSymptomsResult({})).toBeNull();
  });

  it('4件以上は invalid', () => {
    const symptoms = Array.from({ length: 4 }, (_, i) => ({
      label: `症状${i}あ`,
      major_category: 'other',
    }));
    expect(validateEmbedReturnSymptomsResult({ symptoms })).toBeNull();
  });

  it('major_category の enum 不一致は invalid', () => {
    expect(
      validateEmbedReturnSymptomsResult({
        symptoms: [{ label: '謎の不具合', major_category: 'not_a_category' }],
      }),
    ).toBeNull();
  });

  it('isUsableSymptomLabel を適用: 日本語を含まない label は invalid (黙って除外しない)', () => {
    expect(
      validateEmbedReturnSymptomsResult({
        symptoms: [{ label: 'BROKEN', major_category: 'damaged' }],
      }),
    ).toBeNull();
  });

  it('isUsableSymptomLabel を適用: major_category の enum 値そのままの label は invalid', () => {
    expect(
      validateEmbedReturnSymptomsResult({
        symptoms: [{ label: 'description_mismatch', major_category: 'description_mismatch' }],
      }),
    ).toBeNull();
  });
});
