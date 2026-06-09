/**
 * canonical golden vectors — origin-ai との payload_hash parity 検証
 *
 * 正本: minpaku-tool/src/mcp/__contract__/canonical.test.ts。
 * 期待値 (sha256) は minpaku / origin 基盤 (Phase3 追補 v4) と **ビット一致** で固定。
 * ここが一致しなければ tool が計算する payload_hash を origin が照合できず
 * write_id 束縛 (intent/validate/audit) が成立しない。
 */

import { describe, it, expect } from 'vitest';
import { canonicalize, payloadHash } from '../canonical';

describe('canonical golden vectors (origin parity)', () => {
  it('vector 1: フラットなスカラ集合 (キーソート + null 保持)', () => {
    const v = { name: '渋谷マンション', rent: 120000, has_elevator: true, note: null };
    expect(canonicalize(v)).toBe(
      '{"has_elevator":true,"name":"渋谷マンション","note":null,"rent":120000}',
    );
    expect(payloadHash(v)).toBe(
      '2ca618dfc354c194010f45ec719a9b17fdb30955fa1f055fb3e233d789b7215a',
    );
  });

  it('vector 2: ネストした object / array の再帰 canonicalize', () => {
    const v = { b: 2, a: { d: 4, c: [3, { z: null, y: 'x' }] } };
    expect(canonicalize(v)).toBe('{"a":{"c":[3,{"y":"x","z":null}],"d":4},"b":2}');
    expect(payloadHash(v)).toBe(
      'bc7455e8aeaf3d7c948a29715137931485b644917c8beb9136136064e06a3cef',
    );
  });

  it('vector 3: 数値様文字列キーはコードポイント順 ("10" < "2")', () => {
    const v = { '2': 'two', '10': 'ten', a: ['b', 'a'] };
    expect(canonicalize(v)).toBe('{"10":"ten","2":"two","a":["b","a"]}');
    expect(payloadHash(v)).toBe(
      'a851dcd704439fe759934d224a91ea36f41d2c7d45d9138387a481e521a8b0ea',
    );
  });

  it('スカラ単体 / 配列の順序保持', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(true)).toBe('true');
    // 配列は順序保持 (ソートしない)
    expect(canonicalize(['b', 'a'])).toBe('["b","a"]');
  });

  it('customer_record / memo の payload_hash は memo 値のみに依存する (順序非依存)', () => {
    // reversible write の payloadObj は {memo: value}。同一 memo 値なら hash 一致 (undo parity)。
    const a = payloadHash({ memo: '返品対応 完了' });
    const b = payloadHash({ memo: '返品対応 完了' });
    expect(a).toBe(b);
    const c = payloadHash({ memo: null });
    expect(c).not.toBe(a);
  });
});
