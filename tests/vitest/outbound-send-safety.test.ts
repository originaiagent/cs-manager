/**
 * 楽天 outbound 一般 sweep の送信安全フィルタ (SEND_SAFE_OR_FILTER) 契約テスト。
 *
 * 構造保証の出口の 1 つ: 一般 sweep (sendApprovedDrafts) に載せてよいのは
 *   source='manual' OR (source IN (ai_draft,rag) AND is_separated=true) のみ。
 *   - 旧 ai_draft/rag (is_separated=false) は送信しない (混在の可能性)。
 *   - first_response は (たとえ is_separated=true でも) 一般 sweep に載せない
 *     (営業時間ガード付き専用経路でのみ送る、codex review P1)。
 *
 * PostgREST 式そのものは DB 側評価のため、ここでは「式と等価な述語」を 1 箇所に置き、
 *   (a) 式文字列が想定形であること、(b) 述語が各ケースで期待どおりであること を pin する。
 *   式と述語の乖離を防ぐため、式の構造 (source.eq.manual / and(source.in.(ai_draft,rag),is_separated.eq.true))
 *   を文字列としても assert する。
 */
import { describe, it, expect } from 'vitest';
import { SEND_SAFE_OR_FILTER } from '@/channels/rakuten/outbound';

/** SEND_SAFE_OR_FILTER と等価な述語 (DB 側 .or() 評価のローカル等価実装)。 */
function isSweepSendable(row: { source: string; is_separated: boolean }): boolean {
  return (
    row.source === 'manual' ||
    (['ai_draft', 'rag'].includes(row.source) && row.is_separated === true)
  );
}

describe('SEND_SAFE_OR_FILTER (楽天一般 sweep 送信安全)', () => {
  it('式文字列が想定構造 (manual OR (ai_draft/rag AND is_separated))', () => {
    expect(SEND_SAFE_OR_FILTER).toBe(
      'source.eq.manual,and(source.in.(ai_draft,rag),is_separated.eq.true)',
    );
  });

  it('manual は is_separated に関係なく送信可', () => {
    expect(isSweepSendable({ source: 'manual', is_separated: false })).toBe(true);
    expect(isSweepSendable({ source: 'manual', is_separated: true })).toBe(true);
  });

  it('ai_draft/rag は is_separated=true のみ送信可、false は不可', () => {
    expect(isSweepSendable({ source: 'ai_draft', is_separated: true })).toBe(true);
    expect(isSweepSendable({ source: 'rag', is_separated: true })).toBe(true);
    expect(isSweepSendable({ source: 'ai_draft', is_separated: false })).toBe(false);
    expect(isSweepSendable({ source: 'rag', is_separated: false })).toBe(false);
  });

  it('first_response は is_separated に関係なく一般 sweep では送信不可 (専用経路のみ)', () => {
    expect(isSweepSendable({ source: 'first_response', is_separated: false })).toBe(false);
    // 万一 is_separated=true でも一般 sweep には載せない (営業時間ガード迂回防止)
    expect(isSweepSendable({ source: 'first_response', is_separated: true })).toBe(false);
  });
});
