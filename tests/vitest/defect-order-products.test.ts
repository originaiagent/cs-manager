/**
 * order-products.ts (注文番号→製品の解決) の純関数単体テスト — 症状ハンドオフ
 *
 * decideOrderProducts: 注文番号毎の { 合計行数, 解決済み子 product_id 群 } → 製品特定の
 * 可否を判定する。ネットワーク I/O (ec-manager / Core) はモックせず、純粋なグルーピング
 * 判定のみを検証する。
 *
 * ルール (部分解決による誤帰属防止): 注文の全行が解決でき、かつ全行が同一 group に
 * 解決される場合のみ「一意に特定できた」扱い。1 部の行だけ解決できた注文は
 * ambiguous 扱いとし紐付けない。
 */
import { describe, it, expect } from 'vitest';
import { decideOrderProducts } from '@/lib/quality/order-products';

describe('decideOrderProducts', () => {
  it('単一商品の注文は製品を一意に特定できる (childId も確定)', () => {
    const rowsByOrder = new Map([
      ['408672-20260701-0001', { total: 1, resolvedChildIds: ['child-a'] }],
    ]);
    const childToGroup = new Map([['child-a', 'group-1']]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.get('408672-20260701-0001')).toEqual({
      childId: 'child-a',
      groupId: 'group-1',
    });
    expect(ambiguousOrders).toBe(0);
  });

  it('同一注文内の複数行 (全行解決済み) が同一 group に解決される場合も特定できる (childId は null = 一意でない)', () => {
    const rowsByOrder = new Map([
      ['408672-20260701-0002', { total: 2, resolvedChildIds: ['child-a', 'child-b'] }],
    ]);
    const childToGroup = new Map([
      ['child-a', 'group-1'],
      ['child-b', 'group-1'],
    ]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.get('408672-20260701-0002')).toEqual({
      childId: null,
      groupId: 'group-1',
    });
    expect(ambiguousOrders).toBe(0);
  });

  it('複数商品で group が割れる注文 (全行解決済み) は特定できず ambiguousOrders に計上する', () => {
    const rowsByOrder = new Map([
      ['408672-20260701-0003', { total: 2, resolvedChildIds: ['child-a', 'child-c'] }],
    ]);
    const childToGroup = new Map([
      ['child-a', 'group-1'],
      ['child-c', 'group-2'],
    ]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.has('408672-20260701-0003')).toBe(false);
    expect(ambiguousOrders).toBe(1);
  });

  it('解決済み子 product が無い注文 (未解決) は特定できず ambiguous にも計上しない', () => {
    const rowsByOrder = new Map([['408672-20260701-0004', { total: 0, resolvedChildIds: [] }]]);
    const childToGroup = new Map<string, string>();
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.size).toBe(0);
    expect(ambiguousOrders).toBe(0);
  });

  it('親未解決の子は子 id を group 扱いにフォールバックする (sales-resolver と同一規則)', () => {
    const rowsByOrder = new Map([
      ['408672-20260701-0005', { total: 1, resolvedChildIds: ['child-x'] }],
    ]);
    const childToGroup = new Map<string, string>(); // 親未解決
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.get('408672-20260701-0005')).toEqual({
      childId: 'child-x',
      groupId: 'child-x',
    });
    expect(ambiguousOrders).toBe(0);
  });

  it('複数注文をまとめて処理し、各注文の判定が独立している', () => {
    const rowsByOrder = new Map([
      ['order-1', { total: 1, resolvedChildIds: ['child-a'] }],
      ['order-2', { total: 2, resolvedChildIds: ['child-a', 'child-c'] }],
      ['order-3', { total: 1, resolvedChildIds: ['child-b'] }],
    ]);
    const childToGroup = new Map([
      ['child-a', 'group-1'],
      ['child-b', 'group-1'],
      ['child-c', 'group-2'],
    ]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.get('order-1')).toEqual({ childId: 'child-a', groupId: 'group-1' });
    expect(orderProducts.has('order-2')).toBe(false);
    expect(orderProducts.get('order-3')).toEqual({ childId: 'child-b', groupId: 'group-1' });
    expect(ambiguousOrders).toBe(1);
  });

  it('部分解決 (3 行中 1 行だけ解決) は誤帰属を避けるため ambiguous 扱いとし紐付けない', () => {
    const rowsByOrder = new Map([
      ['408672-20260701-0006', { total: 3, resolvedChildIds: ['child-a'] }],
    ]);
    const childToGroup = new Map([['child-a', 'group-1']]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.has('408672-20260701-0006')).toBe(false);
    expect(ambiguousOrders).toBe(1);
  });

  it('全行解決かつ全行同一 group なら特定できる (3 行すべて同一商品)', () => {
    const rowsByOrder = new Map([
      [
        '408672-20260701-0007',
        { total: 3, resolvedChildIds: ['child-a', 'child-a', 'child-a'] },
      ],
    ]);
    const childToGroup = new Map([['child-a', 'group-1']]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.get('408672-20260701-0007')).toEqual({
      childId: 'child-a',
      groupId: 'group-1',
    });
    expect(ambiguousOrders).toBe(0);
  });

  it('全行解決だが 2 つの異なる group にまたがる場合は ambiguous', () => {
    const rowsByOrder = new Map([
      [
        '408672-20260701-0008',
        { total: 3, resolvedChildIds: ['child-a', 'child-c', 'child-a'] },
      ],
    ]);
    const childToGroup = new Map([
      ['child-a', 'group-1'],
      ['child-c', 'group-2'],
    ]);
    const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);
    expect(orderProducts.has('408672-20260701-0008')).toBe(false);
    expect(ambiguousOrders).toBe(1);
  });
});
