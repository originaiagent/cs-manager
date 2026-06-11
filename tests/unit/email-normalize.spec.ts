/**
 * メール inbound 正規化のユニットテスト (純関数、DB 非依存)
 */
import { test, expect } from '@playwright/test';
import {
  normalizeAddress,
  normalizeEmailInbound,
  MAX_EMAIL_TEXT_LENGTH,
} from '../../src/lib/email/normalize';

const NOW = '2026-06-11T00:00:00.000Z';

test('normalizeAddress: 大小文字・前後空白・表示名付きを addr-spec に正規化', () => {
  expect(normalizeAddress('  Foo@Example.COM ')).toBe('foo@example.com');
  expect(normalizeAddress('"CS 太郎" <CS@Origin-Tree.com>')).toBe('cs@origin-tree.com');
});

test('normalizeEmailInbound: 正常系で値を正規化して返す', () => {
  const r = normalizeEmailInbound(
    {
      to: 'Support@Example.com',
      from: 'cust@example.jp',
      from_name: '山田 太郎',
      subject: 'サイズ違い',
      text: '届いた商品のサイズが違います',
      message_id: '<abc@mail>',
      received_at: '2026-06-10T10:00:00+09:00',
      in_reply_to: '<prev@mail>',
    },
    NOW,
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.toNormalized).toBe('support@example.com');
  expect(r.value.messageId).toBe('<abc@mail>');
  expect(r.value.fromName).toBe('山田 太郎');
  expect(r.value.threadMeta.in_reply_to).toBe('<prev@mail>');
  // received_at は ISO 化される
  expect(r.value.receivedAt).toBe('2026-06-10T01:00:00.000Z');
});

test('normalizeEmailInbound: received_at 省略時はサーバ now を採用', () => {
  const r = normalizeEmailInbound(
    { to: 'a@b.com', text: 'hi', message_id: 'm1' },
    NOW,
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.receivedAt).toBe(NOW);
});

test('normalizeEmailInbound: 必須欠落でフィールド名のみ返す (PII 非露出)', () => {
  const r = normalizeEmailInbound({ subject: 'x' }, NOW);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  const fields = r.errors.map((e) => e.field).sort();
  expect(fields).toEqual(['message_id', 'text', 'to']);
});

test('normalizeEmailInbound: 本文超過は拒否', () => {
  const r = normalizeEmailInbound(
    { to: 'a@b.com', text: 'x'.repeat(MAX_EMAIL_TEXT_LENGTH + 1), message_id: 'm1' },
    NOW,
  );
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.errors.some((e) => e.field === 'text')).toBe(true);
});

test('normalizeEmailInbound: received_at 不正は拒否', () => {
  const r = normalizeEmailInbound(
    { to: 'a@b.com', text: 'hi', message_id: 'm1', received_at: 'not-a-date' },
    NOW,
  );
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.errors.some((e) => e.field === 'received_at')).toBe(true);
});
