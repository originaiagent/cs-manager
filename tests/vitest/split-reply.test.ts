/**
 * split-reply パーサ 単体テスト (純関数、唯一の安全境界)
 *
 * 構造保証の中核: 社内テキスト (根拠ナレッジ + 担当者メモ) が customerReply に
 * 絶対に入らないこと、fail-closed (parseOk=false → customerReply='') を pin する。
 */
import { describe, it, expect } from 'vitest';
import {
  splitReply,
  isCustomerSafeBody,
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

  it('ナレーションが START トークンと同一行先頭に連結 → parseOk=true, customerReply は本文のみ (codex APPROVE: トークンアンカー)', () => {
    // 本番 agent の実出力 (~2/3): START センチネルと同じ行頭に narration を連結
    const raw = [
      `まず社内ナレッジを検索します。${CUSTOMER_REPLY_START}`,
      '{{customer_name}} 様',
      'お問い合わせありがとうございます。返品を承ります。',
      CUSTOMER_REPLY_END,
      '<<<ORIGIN_CS_INTERNAL_GROUNDING_V1>>>',
      '社内根拠: 返品ポリシー記事#12',
      '<<<END_ORIGIN_CS_INTERNAL_GROUNDING_V1>>>',
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe(
      '{{customer_name}} 様\nお問い合わせありがとうございます。返品を承ります。',
    );
    // narration は customerReply に入らない
    expect(r.customerReply).not.toContain('社内ナレッジを検索');
    // internalPreview に narration + 内部ブロックが残る
    expect(r.internalPreview).toContain('まず社内ナレッジを検索します。');
    expect(r.internalPreview).toContain('社内根拠: 返品ポリシー記事#12');
  });

  it('END トークン後ろの後続テキスト → parseOk=true, 本文は影響なし, 後続は internalPreview へ', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      'ご返信いたします。',
      `${CUSTOMER_REPLY_END}続いて担当者向けの社内メモを記載します。`,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('ご返信いたします。');
    expect(r.customerReply).not.toContain('担当者向け');
    expect(r.internalPreview).toContain('担当者向けの社内メモ');
  });

  it('END トークン直前が空白のみ (行頭インデント) → parseOk=true', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      'ご返信します。',
      `   ${CUSTOMER_REPLY_END}`,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('ご返信します。');
  });

  it('CRLF 行末でもトークンアンカーが成立する', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      'CRLF本文',
      CUSTOMER_REPLY_END,
    ].join('\r\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('CRLF本文');
  });

  it('CR のみ (lone \\r) 行末でもトークンアンカーが成立する (codex CODE review P3)', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      'CR本文',
      CUSTOMER_REPLY_END,
    ].join('\r');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    expect(r.customerReply).toBe('CR本文');
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

  it('START トークン直後 (同一行 suffix) に narration 連結 → parseOk=false (codex CODE review P1)', () => {
    // 緩和は START の「前」の narration のみ。START の「後ろ」に narration が連結された
    // 形は narration が customerBody に滑り込むため fail-closed にする。
    const raw = [
      `${CUSTOMER_REPLY_START}まず社内情報を確認します。`,
      '本文です。',
      CUSTOMER_REPLY_END,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
    expect(r.internalPreview).toBe(raw);
  });

  it('END トークン直前 (同一行 prefix) に narration 連結 → parseOk=false (codex CODE review P1)', () => {
    // END 直前へ narration が連結された形は narration が customerBody に滑り込むため
    // fail-closed (START 側と対称、旧 END 行全体一致の fail-closed 性を復元)。
    const raw = [
      CUSTOMER_REPLY_START,
      '顧客本文です。',
      `次に処理状況を確認します${CUSTOMER_REPLY_END}`,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
    expect(r.internalPreview).toBe(raw);
  });

  it('END トークン欠落 (inline START のみ) → parseOk=false', () => {
    // トークンアンカーでも END 不在は fail-closed (緩和は START/END の locating のみ)
    const raw = [`前置き ${CUSTOMER_REPLY_START}`, '本文だけで END なし'].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
    expect(r.internalPreview).toBe(raw);
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

describe('isCustomerSafeBody (サーバ側 /drafts POST 用ゲート, parser 迂回防止)', () => {
  it('純粋な顧客向け本文 → true', () => {
    expect(isCustomerSafeBody('お問い合わせありがとうございます。承りました。')).toBe(true);
  });

  it('空 / 空白のみ → false', () => {
    expect(isCustomerSafeBody('')).toBe(false);
    expect(isCustomerSafeBody('   ')).toBe(false);
    expect(isCustomerSafeBody(null)).toBe(false);
    expect(isCustomerSafeBody(undefined)).toBe(false);
  });

  it('本物のリーク信号 (INTERNAL_/センチネル/社内向けラベル/📋/⚠️) を含む → false', () => {
    for (const bad of [
      '回答。INTERNAL_NOTE',
      '回答 <<<ORIGIN_CS_CUSTOMER_REPLY_V1>>>',
      '回答 <<<END_ORIGIN_CS_INTERNAL_GROUNDING_V1>>>',
      '顧客向け本文\n\n社内用: 管理画面で確認',
      '回答。社内向け補足あり',
      '回答。内部メモ: 在庫薄',
      '回答。担当者メモ: 在庫確認',
      '回答。担当者向け補足',
      '回答。オペレーター向け注記',
      '回答。オペレータ向け注記',
      '回答。📋 チェック',
      '回答。⚠️ 注意',
    ]) {
      expect(isCustomerSafeBody(bad), bad).toBe(false);
    }
  });

  // Bug1 根治 (2026-07-01 / codex APPROVE + code review 反映): 現 gemma 経路 (embed cs-reply:draft)
  //   では reply_draft が顧客向け専用フィールドで、社内内容は sources/escalation_reason の別フィールド。
  //   内容記述語 (根拠/ナレッジ/検索結果) は正当な顧客返信に現れ得る (例:「ご請求の根拠となる…」) ため
  //   もう false-positive で弾かない。明示的な社内向けラベル/構造マーカーは引き続き遮断する (上のテスト)。
  //   汎用語込みリスト (FORBIDDEN_IN_CUSTOMER_BODY) は旧センチネル方式 splitReply 専用に温存。
  it('内容記述語 (根拠/ナレッジ/検索結果) のみでは弾かない → true', () => {
    for (const ok of [
      'ご請求の根拠となる明細をお送りいたします。',
      'ナレッジベースの情報をご案内します。',
      '検索結果は以下のとおりです。',
    ]) {
      expect(isCustomerSafeBody(ok), ok).toBe(true);
    }
  });
});

describe('splitReply: 追加フィールド internalGroundingText / internalNotesText', () => {
  it('GROUNDING/NOTES ブロックの中身が marker 除去 + trim で取り出される', () => {
    const raw = wrap({
      customer: 'ご返信します。',
      grounding: '返品ポリシー記事を参照しました。',
      notes: '・在庫を確認\n・配送状況を確認',
    });
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    // marker (<<<...>>>) は含まれない
    expect(r.internalGroundingText).toBe('返品ポリシー記事を参照しました。');
    expect(r.internalGroundingText).not.toContain('<<<');
    expect(r.internalNotesText).toBe('・在庫を確認\n・配送状況を確認');
    expect(r.internalNotesText).not.toContain('<<<');
  });

  it('ブロックが無ければ空文字列', () => {
    const r = splitReply(wrap({ customer: '本文のみ' }));
    expect(r.parseOk).toBe(true);
    expect(r.internalGroundingText).toBe('');
    expect(r.internalNotesText).toBe('');
  });

  it('GROUNDING のみ存在 → grounding 取得 / notes は空', () => {
    const r = splitReply(
      wrap({ customer: '本文', grounding: '根拠prose' }),
    );
    expect(r.internalGroundingText).toBe('根拠prose');
    expect(r.internalNotesText).toBe('');
  });

  it('parseOk=false でも GROUNDING/NOTES が抽出できれば取り出される (read-only 表示用)', () => {
    // CUSTOMER ブロックを壊して parseOk=false にしつつ、内部ブロックは正常配置
    const raw = [
      `${CUSTOMER_REPLY_START}本文後置きで fail`,
      '<<<ORIGIN_CS_INTERNAL_NOTES_V1>>>',
      '担当者向けメモ本体',
      '<<<END_ORIGIN_CS_INTERNAL_NOTES_V1>>>',
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
    // fail-closed でも社内ブロックは additive に抽出される
    expect(r.internalNotesText).toBe('担当者向けメモ本体');
  });

  it('内部ブロックの START/END が不正形 (重複) → 空文字列 (fail-safe)', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      '本文',
      CUSTOMER_REPLY_END,
      '<<<ORIGIN_CS_INTERNAL_NOTES_V1>>>',
      'メモ1',
      '<<<ORIGIN_CS_INTERNAL_NOTES_V1>>>',
      'メモ2',
      '<<<END_ORIGIN_CS_INTERNAL_NOTES_V1>>>',
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(true);
    // NOTES START が 2 回 → 抽出せず空 (fail-safe)
    expect(r.internalNotesText).toBe('');
  });
});

describe('splitReply: 社内ラベル混入も fail-closed (codex review P1)', () => {
  it('CUSTOMER block 内に「社内用:」混入 → parseOk=false, customerReply=', () => {
    const raw = [
      CUSTOMER_REPLY_START,
      '承りました。\n社内用: 管理画面で確認',
      CUSTOMER_REPLY_END,
    ].join('\n');
    const r = splitReply(raw);
    expect(r.parseOk).toBe(false);
    expect(r.customerReply).toBe('');
  });
});
