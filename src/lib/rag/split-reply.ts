/**
 * 返信ドラフト分離パーサ (cs-manager サーバ側、唯一の安全境界)
 *
 * 目的: 社内テキスト (根拠ナレッジ + 担当者メモ + narration) が顧客送信欄に
 *   絶対に入らないことを構造的に保証する。origin-ai の managed agent
 *   `customer-reply-writer` は出力 (`text`) を行単位センチネルで構造化する。
 *   本モジュールはそれを **サーバ側で** パースし (single source of truth)、
 *   顧客向け本文のみを `customerReply` として取り出す。
 *
 * 契約 (origin-ai と完全一致させること):
 *   <<<ORIGIN_CS_CUSTOMER_REPLY_V1>>>
 *   顧客向け本文のみ
 *   <<<END_ORIGIN_CS_CUSTOMER_REPLY_V1>>>
 *   <<<ORIGIN_CS_INTERNAL_GROUNDING_V1>>> ... <<<END_ORIGIN_CS_INTERNAL_GROUNDING_V1>>>
 *   <<<ORIGIN_CS_INTERNAL_NOTES_V1>>> ... <<<END_ORIGIN_CS_INTERNAL_NOTES_V1>>>
 *
 * fail-closed: パース要件を 1 つでも満たさない場合 parseOk=false とし、
 *   customerReply='' (送信欄は空) / internalPreview=raw 全文 (オペレータが
 *   手動で顧客向け部分を切り出せるよう全文表示) を返す。生テキストや社内
 *   テキストを customerReply に絶対に入れない。
 *
 * 純関数。決定的。外部依存・副作用なし。
 */

/** CUSTOMER_REPLY ブロックの開始/終了センチネル (行全体一致が要件)。 */
export const CUSTOMER_REPLY_START = '<<<ORIGIN_CS_CUSTOMER_REPLY_V1>>>';
export const CUSTOMER_REPLY_END = '<<<END_ORIGIN_CS_CUSTOMER_REPLY_V1>>>';

/**
 * 顧客向け本文に含まれていたら parseOk=false にする既知の内部マーカー/見出し。
 * agent が誤って社内テキストを CUSTOMER_REPLY ブロック内に混入させた場合の
 * 二重防壁 (defense-in-depth)。
 */
export const FORBIDDEN_IN_CUSTOMER_BODY = [
  '<<<ORIGIN_CS_INTERNAL',
  'INTERNAL_',
  '担当者メモ',
  '担当者向け',
  '根拠',
  '検索結果',
  'ナレッジ',
  '⚠️',
  '📋',
  // 代表的な社内ラベル (codex review P1: agent が CUSTOMER block 内に混ぜた場合や
  //   /drafts へ直接送られた場合の漏洩を塞ぐ)。UI パネル label「社内用・送信されません」
  //   と同じ語も含め、これらが本文にあれば顧客向けとして安全とは見なさない。
  '社内用',
  '社内向け',
  '内部メモ',
  'オペレーター向け',
  'オペレータ向け',
] as const;

/**
 * 「この本文は顧客向けとして安全か」をサーバ側で独立検証する (parser 迂回防止)。
 *
 * 用途: 汎用 /drafts POST 等、splitReply を通さない経路で is_separated=true を
 *   受け付ける前のサーバ側ゲート。クライアントの is_separated 主張を鵜呑みにせず、
 *   body 自体に内部マーカー/センチネルが無いことを証明する (codex review P1)。
 *
 * 安全条件 (全充足): trim 後非空 / 既知内部マーカー (FORBIDDEN_IN_CUSTOMER_BODY) を
 *   含まない / ORIGIN_CS センチネル系を含まない。1 つでも違反 → false。
 */
export function isCustomerSafeBody(body: string | null | undefined): boolean {
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) return false;
  for (const marker of FORBIDDEN_IN_CUSTOMER_BODY) {
    if (text.includes(marker)) return false;
  }
  if (/<<<\s*(END_)?ORIGIN_CS_/i.test(text)) return false;
  return true;
}

export interface SplitReplyResult {
  /** 顧客向け返信本文 (送信/編集対象)。parseOk=false 時は ''。 */
  customerReply: string;
  /**
   * 社内用プレビュー (読み取り専用)。
   * - parseOk=true: raw から CUSTOMER_REPLY ブロックを除いた残り全部
   *   (根拠/メモ/narration 含む)。
   * - parseOk=false: raw 全文。
   */
  internalPreview: string;
  /** 構造分離に成功したか。false の場合は fail-closed (送信欄空)。 */
  parseOk: boolean;
}

/**
 * 改行コードを正規化せずに行配列へ分割する。
 * \r\n / \r / \n いずれの行末でも「行全体一致」を成立させるため、
 * 行末の \r を除去した比較用配列も併せて持つ。
 */
function splitLines(raw: string): string[] {
  // \r\n と \r を \n に正規化してから split (行全体一致の判定を安定させる)
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** 行が指定センチネルと (前後空白を許して) 行全体一致するか。 */
function isSentinelLine(line: string, sentinel: string): boolean {
  return line.trim() === sentinel;
}

/**
 * agent 出力 (PII 復元済み) を顧客向け / 社内用に分離する。
 *
 * parseOk=true の全要件:
 *  1. CUSTOMER_REPLY 開始センチネルが「行全体一致」でちょうど 1 回
 *  2. CUSTOMER_REPLY 終了センチネルが「行全体一致」でちょうど 1 回
 *  3. 開始行 < 終了行 (開始が終了に先行)
 *  4. 開始〜終了の間の本文が trim 後に非空
 *  5. 顧客本文に既知内部マーカー (FORBIDDEN_IN_CUSTOMER_BODY) を一切含まない
 * いずれか 1 つでも失敗 → parseOk=false (fail-closed)。
 */
export function splitReply(rawInput: string | null | undefined): SplitReplyResult {
  const raw = typeof rawInput === 'string' ? rawInput : '';

  // fail-closed の既定形 (どの早期 return もこれを基準にする)
  const failClosed: SplitReplyResult = {
    customerReply: '',
    internalPreview: raw,
    parseOk: false,
  };

  if (!raw.trim()) {
    // 空入力: 顧客本文も社内プレビューも無い。fail-closed (送信欄空)。
    return { customerReply: '', internalPreview: raw, parseOk: false };
  }

  const lines = splitLines(raw);

  // (1)(2) 開始/終了センチネルの行全体一致をそれぞれ列挙
  const startIdxs: number[] = [];
  const endIdxs: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isSentinelLine(lines[i], CUSTOMER_REPLY_START)) startIdxs.push(i);
    if (isSentinelLine(lines[i], CUSTOMER_REPLY_END)) endIdxs.push(i);
  }

  // 各々ちょうど 1 回でなければ fail-closed
  if (startIdxs.length !== 1 || endIdxs.length !== 1) {
    return failClosed;
  }

  const startIdx = startIdxs[0];
  const endIdx = endIdxs[0];

  // (3) 開始が終了に先行 (隣接で本文 0 行も後段 (4) で弾く)
  if (!(startIdx < endIdx)) {
    return failClosed;
  }

  // (4) 開始〜終了の間の本文 (センチネル行は含めない) が trim 後に非空
  const bodyLines = lines.slice(startIdx + 1, endIdx);
  const customerBody = bodyLines.join('\n').trim();
  if (!customerBody) {
    return failClosed;
  }

  // (5a) 顧客本文に既知内部マーカーが混入していたら fail-closed
  for (const marker of FORBIDDEN_IN_CUSTOMER_BODY) {
    if (customerBody.includes(marker)) {
      return failClosed;
    }
  }

  // (5b) 顧客本文に ORIGIN_CS センチネル系 (開始/終了/INTERNAL/CUSTOMER いずれも) が
  //   残存していたら fail-closed (codex CONCERN#2: マーカーなし混入の最低限の防壁。
  //   FORBIDDEN_IN_CUSTOMER_BODY の `<<<ORIGIN_CS_INTERNAL` では END_ 系や入れ子の
  //   CUSTOMER センチネルを取りこぼすため、センチネル接頭辞を網羅的に拒否する)。
  if (/<<<\s*(END_)?ORIGIN_CS_/i.test(customerBody)) {
    return failClosed;
  }

  // internalPreview = raw から CUSTOMER_REPLY ブロック (センチネル行含む) を除いた残り。
  // 根拠/メモ/narration をオペレータ表示用にそのまま残す。
  const internalLines = [
    ...lines.slice(0, startIdx),
    ...lines.slice(endIdx + 1),
  ];
  const internalPreview = internalLines.join('\n').trim();

  return {
    customerReply: customerBody,
    internalPreview,
    parseOk: true,
  };
}
