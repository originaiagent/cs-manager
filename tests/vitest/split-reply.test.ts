/**
 * split-reply パーサ 単体テスト (純関数、唯一の安全境界)
 *
 * 構造保証の中核: 社内テキスト (根拠ナレッジ + 担当者メモ) が customerReply に
 * 絶対に入らないこと、fail-closed (parseOk=false → customerReply='') を pin する。
 */
import { describe, it, expect } from 'vitest';
import {
  splitReply,
  CUSTOMER_REPLY_START,
  CUSTOMER_REPLY_END,
} from '@/lib/rag/split-reply';

/** センチネルで包んだ標準的な agent 出力を組み立てる。 */
function wrap(opts: {
  customer: string;
  grounding?: string;
  notes?: string;
  narration?: string;
}): string {
  const parts: string[] = [];
  if (opts.narration) parts.push(opts.narration);
  parts.push(CUSTOMER_REPLY_START, opts.customer, CUSTOMER_REPLY_END);
  if (opts.grounding) {
    parts.push(
      '<<<ORIGIN_CS_INTERNAL_GROUNDING_V1>>>',
      opts.grounding,
      '<<<END_ORIGIN_CS_INTERNAL_GROUNDING_V1>>>',
    );
  }
  if (opts.notes) {
    parts.push(
      '<<<ORIGIN_CS_INTERNAL_NOTES_V1>>>',
      opts.notes,
      '<<<END_ORIGIN_CS_INTERNAL_NOTES_V1>>>',
    );
  }
  return parts.join('\n');
}

describe('splitReply: 正常系', () => {
  it('完全な出力 → parseOk=true, customerReply は顧客本文のみ', () => {
    const raw = wrap({
      customer: 'お問い合わせありがとうございます。\n返品を承ります。',
      grounding: '社内根拠: 返品ポリシー記事#12',
      notes: '担当者向け: 在庫確認が必要',
    });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe(
      'お問い合わせありがとうございます。\n返品を承ります。',
    );
    // 社内テキストは customerReply に絶対入らない
    expect(r.customerReply).not.toContain('社内根拠');
    expect(r.customerReply).not.toContain('担当者向け');
    // internalPreview には根拠/メモが残る
    expect(r.internalPreview).toContain('社内根拠');
    expect(r.internalPreview).toContain('担当者向け');
  });

  it('grounding/notes 無し (顧客本文のみ) → parseOk=true', () => {
    const raw = wrap({ customer: 'ご返信します。' });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('ご返信します。');
  });

  it('narration (センチネル外の前置き) は internalPreview に入り customerReply に入らない', () => {
    const raw = wrap({
      customer: '承知しました。',
      narration: 'まず knowledge_search を実行しました。',
    });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('承知しました。');
    expect(r.internalPreview).toContain('knowledge_search');
  });

  it('CRLF 行末でも行全体一致が成立する', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      'CRLF本文',
      CUSTOMER_REPLY_END,
    ].join('\r\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('CRLF本文');
  });
});

describe('splitReply: fail-closed (parseOk=false → customerReply 必ず空)', () => {
  it('END センチネル欠落 → parseOk=false, customerReply=, internalPreview=raw', () => {
    const raw = `${CUSTOMER_REPLY_START}\n本文だけ`;
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
    expect(r.internalPreview).toBe(raw);
  });

  it('START センチネル重複 → parseOk=false', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      '本文1',
      CUSTOMER_REPLY_START,
      '本文2',
      CUSTOMER_REPLY_END,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('END センチネル重複 → parseOk=false', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      '本文',
      CUSTOMER_REPLY_END,
      CUSTOMER_REPLY_END,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('本文が空 (trim 後) → parseOk=false', () => {
    const raw = [CUSTOMER_REPLY_START, '   ', CUSTOMER_REPLY_END].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('START が END より後 (順序逆) → parseOk=false', () => {
    const raw = [CUSTOMER_REPLY_END, '本文', CUSTOMER_REPLY_START].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('マーカーが行頭以外 (行全体一致しない) → parseOk=false', () => {
    const raw = [
      `前置き ${CUSTOMER_REPLY_START}`,
      '本文',
      CUSTOMER_REPLY_END,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
  });

  it('顧客本文に 📋 が混入 → parseOk=false, customerReply=', () => {
    const raw = wrap({ customer: '回答します。📋 社内チェック項目' });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('顧客本文に「根拠」が混入 → parseOk=false', () => {
    const raw = wrap({ customer: '回答します。根拠: 記事#3' });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('顧客本文に INTERNAL_ が混入 → parseOk=false', () => {
    const raw = wrap({ customer: '回答します。INTERNAL_NOTE here' });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('顧客本文に ⚠️ が混入 → parseOk=false', () => {
    const raw = wrap({ customer: '回答します。⚠️ 注意' });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
  });

  it('顧客本文に「ナレッジ」「検索結果」「担当者メモ」が混入 → parseOk=false', () => {
    for (const bad of ['ナレッジ参照', '検索結果より', '担当者メモ: x']) {
      const r = splitReply(wrap({ customer: `回答。${bad}` }));
      expect(r.parseOk).toBe(false);
      expect(r.customerReply).toBe('');
    }
  });

  it('顧客本文に内部センチネル (END_ 系含む) が残存 → parseOk=false (codex CONCERN#2)', () => {
    // CUSTOMER ブロック内に END_GROUNDING センチネルが文字列として残るケース
    const raw = [
      CUSTOMER_REPLY_START,
      '回答です。<<<END_ORIGIN_CS_INTERNAL_GROUNDING_V1>>>',
      CUSTOMER_REPLY_END,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });

  it('マーカー皆無 (素のテキスト) → parseOk=false, internalPreview=raw, customerReply=', () => {
    const raw = '見出しのない素の返信テキストです。';
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
    expect(r.internalPreview).toBe(raw);
  });

  it('空文字列 / null / undefined → parseOk=false, customerReply=', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = splitReply(v as string);
      expect(r.parseOk).toBe(false);
      expect(r.customerReply).toBe('');
    }
  });
});
