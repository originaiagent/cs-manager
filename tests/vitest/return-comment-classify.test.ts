/**
 * FBA 返品コメント分類の純関数テスト (extractSymptoms)。
 *
 * origin-ai 応答から症状ラベルを取り出す部分だけを対象にする
 * (マスク・AI 呼び出し・DB 書込みは副作用のため対象外)。
 */
import { describe, it, expect } from 'vitest';
import { extractSymptoms } from '@/lib/quality/return-comment-classify';

describe('extractSymptoms', () => {
  it('structured_output から症状を取り出す', () => {
    const got = extractSymptoms(
      { symptoms: [{ label: '水が出ない', major_category: 'function_defect' }] },
      '',
    );
    expect(got).toEqual([{ label: '水が出ない', major_category: 'function_defect' }]);
  });

  it('structured が無ければ本文の JSON を読む', () => {
    const got = extractSymptoms(null, '{"symptoms":[{"label":"割れ","major_category":"damaged"}]}');
    expect(got).toEqual([{ label: '割れ', major_category: 'damaged' }]);
  });

  it('本文が前後に文章を含んでも中の JSON を拾う', () => {
    const got = extractSymptoms(null, 'はい。{"symptoms":[{"label":"歪み","major_category":"damaged"}]} 以上です');
    expect(got).toEqual([{ label: '歪み', major_category: 'damaged' }]);
  });

  it('症状なしは空配列', () => {
    expect(extractSymptoms({ symptoms: [] }, '')).toEqual([]);
  });

  it('JSON として読めない応答は空配列 (握り潰さず空を返す)', () => {
    expect(extractSymptoms(null, '症状は特にありません')).toEqual([]);
  });

  it('未知の major_category は other に正規化する', () => {
    const got = extractSymptoms({ symptoms: [{ label: '謎の不具合', major_category: 'unknown_cat' }] }, '');
    expect(got).toEqual([{ label: '謎の不具合', major_category: 'other' }]);
  });

  // 本番実測の逸脱 (76件中4件): AI が major_category の enum 値を label に入れてきた
  it('major_category の enum 値がラベルに来たら捨てる (画面に生の英語を出さない)', () => {
    const got = extractSymptoms(
      {
        symptoms: [
          { label: 'description_mismatch', major_category: 'description_mismatch' },
          { label: 'size_mismatch', major_category: 'size_mismatch' },
          { label: '説明と異なる', major_category: 'description_mismatch' },
        ],
      },
      '',
    );
    expect(got).toEqual([{ label: '説明と異なる', major_category: 'description_mismatch' }]);
  });

  it('日本語を含まないラベルは症状として使わない', () => {
    expect(extractSymptoms({ symptoms: [{ label: 'BROKEN', major_category: 'damaged' }] }, '')).toEqual([]);
  });

  it('ラベル重複は畳み、最大3件まで', () => {
    const got = extractSymptoms(
      {
        symptoms: [
          { label: '割れ', major_category: 'damaged' },
          { label: '割れ', major_category: 'damaged' },
          { label: '歪み', major_category: 'damaged' },
          { label: '汚れ', major_category: 'damaged' },
          { label: '傷がある', major_category: 'damaged' },
        ],
      },
      '',
    );
    expect(got.map((s) => s.label)).toEqual(['割れ', '歪み', '汚れ']);
  });
});
