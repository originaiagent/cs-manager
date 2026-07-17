/**
 * 既存ラベル合成 (src/lib/quality/defect-classify.ts mergeExistingLabels) の単体テスト。
 *
 * 目的 (欠陥2 の回帰防止): 実データの 92% のチケットは product_id を持たず、
 * product スコープのラベルがゼロになる。その場合でもグローバル頻出ラベルが
 * 必ず提示されること (提示ゼロ = 毎回新規ラベル生成 = 集計不能) を担保する。
 * - product スコープ優先 + グローバル補完
 * - trim / 重複除去
 * - 上限クランプ (プロンプト肥大防止)
 */
import { describe, it, expect } from 'vitest';
import { mergeExistingLabels } from '@/lib/quality/defect-classify';

describe('mergeExistingLabels: product スコープ優先 + グローバル補完', () => {
  it('product スコープを先頭に、グローバルで残り枠を埋める', () => {
    const result = mergeExistingLabels(['水が出ない'], ['傷あり', '部品欠品'], 10);
    expect(result).toEqual(['水が出ない', '傷あり', '部品欠品']);
  });

  it('product スコープが空でもグローバルラベルを必ず提示する (欠陥2 の根治点)', () => {
    const result = mergeExistingLabels([], ['傷あり', '部品欠品'], 10);
    expect(result).toEqual(['傷あり', '部品欠品']);
  });

  it('両方空なら空配列 (ラベル提示なしで分類続行)', () => {
    expect(mergeExistingLabels([], [], 10)).toEqual([]);
  });

  it('グローバルが空でも product スコープは提示する', () => {
    expect(mergeExistingLabels(['水が出ない'], [], 10)).toEqual(['水が出ない']);
  });
});

describe('mergeExistingLabels: 正規化と重複除去', () => {
  it('前後空白を trim する', () => {
    expect(mergeExistingLabels(['  水が出ない  '], ['\t傷あり\n'], 10)).toEqual([
      '水が出ない',
      '傷あり',
    ]);
  });

  it('product とグローバルで重複するラベルは 1 回だけ (product 側を採用)', () => {
    const result = mergeExistingLabels(['傷あり'], ['傷あり', '部品欠品'], 10);
    expect(result).toEqual(['傷あり', '部品欠品']);
  });

  it('trim 後に同一になるラベルも重複除去する', () => {
    const result = mergeExistingLabels(['傷あり'], [' 傷あり '], 10);
    expect(result).toEqual(['傷あり']);
  });

  it('同一グループ内の重複も除去する', () => {
    const result = mergeExistingLabels(['傷あり', '傷あり'], [], 10);
    expect(result).toEqual(['傷あり']);
  });

  it('空文字・空白のみのラベルは除外する', () => {
    const result = mergeExistingLabels(['', '   '], ['傷あり', ''], 10);
    expect(result).toEqual(['傷あり']);
  });

  it('文字列以外が混入しても落ちずに除外する (RPC 応答の防御)', () => {
    const dirty = [null, 123, undefined, '傷あり'] as unknown as string[];
    expect(mergeExistingLabels(dirty, [], 10)).toEqual(['傷あり']);
  });

  it('表現違い (傷がある / 傷あり) は別ラベルとして両方残す (寄せるのは AI 側の責務)', () => {
    const result = mergeExistingLabels([], ['傷がある', '傷あり'], 10);
    expect(result).toEqual(['傷がある', '傷あり']);
  });
});

describe('mergeExistingLabels: 上限クランプ', () => {
  it('合計が limit を超えないよう詰める', () => {
    const result = mergeExistingLabels(['a', 'b'], ['c', 'd', 'e'], 4);
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('product スコープだけで limit に達したらグローバルは足さない', () => {
    const result = mergeExistingLabels(['a', 'b', 'c'], ['d'], 3);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('product スコープが limit を超える場合も limit でクランプする', () => {
    const result = mergeExistingLabels(['a', 'b', 'c', 'd'], [], 2);
    expect(result).toEqual(['a', 'b']);
  });

  it('limit=0 / 負値 / NaN は空配列 (プロンプトに何も出さない)', () => {
    expect(mergeExistingLabels(['a'], ['b'], 0)).toEqual([]);
    expect(mergeExistingLabels(['a'], ['b'], -1)).toEqual([]);
    expect(mergeExistingLabels(['a'], ['b'], NaN)).toEqual([]);
  });

  it('重複除去は limit カウント前に効く (重複で枠を消費しない)', () => {
    const result = mergeExistingLabels(['a', 'a'], ['b', 'c'], 3);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('既定 limit (MAX_EXISTING_LABELS=30) でクランプする', () => {
    const globals = Array.from({ length: 50 }, (_, i) => `label${i}`);
    expect(mergeExistingLabels([], globals)).toHaveLength(30);
  });
});
