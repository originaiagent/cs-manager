/**
 * sales-resolver rowLookupSpec (sales 行 → Core lookup-bulk 検索キー×slot 決定) の単体テスト。
 *
 * slot 契約 (origin-core mall_code_definitions 実データで裏取り):
 * - amazon: sales 行は item/sku とも子ASIN → identifier_2 で引く
 *   (identifier_1=親ASIN のため、親≠子の多バリエーション品は identifier_1 だと全 miss)
 * - rakuten: SKU管理番号 (skuManagementNumber) を identifier_2 で引く。
 *   identifier_1=商品管理番号は複数子SKUで共有され曖昧なので SKU 不在行のフォールバック限定
 * - その他モール: item_management_number × identifier_1 (従来通り)
 */
import { describe, it, expect } from 'vitest';
import { rowLookupSpec } from '@/lib/quality/sales-resolver';

describe('rowLookupSpec', () => {
  it('amazon: sku (子ASIN) を identifier_2 で引く', () => {
    expect(
      rowLookupSpec({
        marketplace: 'amazon',
        itemManagementNumber: 'B0CHILD001',
        skuManagementNumber: 'B0CHILD001',
      }),
    ).toEqual({ mall: 'amazon', slot: 'identifier_2', value: 'B0CHILD001' });
  });

  it('amazon: sku 不在なら item (こちらも子ASIN) を identifier_2 で引く', () => {
    expect(
      rowLookupSpec({
        marketplace: 'amazon',
        itemManagementNumber: 'B0CHILD002',
        skuManagementNumber: null,
      }),
    ).toEqual({ mall: 'amazon', slot: 'identifier_2', value: 'B0CHILD002' });
  });

  it('amazon: item/sku 両方不在は null (未解決扱い)', () => {
    expect(
      rowLookupSpec({
        marketplace: 'amazon',
        itemManagementNumber: '  ',
        skuManagementNumber: null,
      }),
    ).toBeNull();
  });

  it('rakuten: SKU管理番号を identifier_2 で引く (子 product 一意)', () => {
    expect(
      rowLookupSpec({
        marketplace: 'rakuten',
        itemManagementNumber: '1-b0c3ywqxv2',
        skuManagementNumber: 'sku-red-m',
      }),
    ).toEqual({ mall: 'rakuten', slot: 'identifier_2', value: 'sku-red-m' });
  });

  it('rakuten: SKU 不在行のみ商品管理番号 identifier_1 へフォールバック', () => {
    expect(
      rowLookupSpec({
        marketplace: 'rakuten',
        itemManagementNumber: '1-b0c3ywqxv2',
        skuManagementNumber: '',
      }),
    ).toEqual({ mall: 'rakuten', slot: 'identifier_1', value: '1-b0c3ywqxv2' });
  });

  it('その他モール (yahoo 等): item_management_number × identifier_1 (従来通り)', () => {
    expect(
      rowLookupSpec({
        marketplace: 'yahoo',
        itemManagementNumber: 'yh-item-01',
        skuManagementNumber: 'yh-sku-01',
      }),
    ).toEqual({ mall: 'yahoo', slot: 'identifier_1', value: 'yh-item-01' });
  });

  it('marketplace は trim + 小文字化して照合する', () => {
    expect(
      rowLookupSpec({
        marketplace: ' Amazon ',
        itemManagementNumber: null,
        skuManagementNumber: 'B0CHILD003',
      }),
    ).toEqual({ mall: 'amazon', slot: 'identifier_2', value: 'B0CHILD003' });
  });

  it('未対応モールは null (units は unmapped 扱い)', () => {
    expect(
      rowLookupSpec({
        marketplace: 'mercari',
        itemManagementNumber: 'item-1',
        skuManagementNumber: 'sku-1',
      }),
    ).toBeNull();
    expect(
      rowLookupSpec({ marketplace: null, itemManagementNumber: 'x', skuManagementNumber: 'y' }),
    ).toBeNull();
  });
});
