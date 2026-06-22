/**
 * 返信ドラフト分離パーサ (cs-manager サーバ側、唯一の安全境界)
 *
 * 目的: 社内テキスト (根拠ナレッジ + 担当者メモ + narration) が顧客送信欄に
 *   絶対に入らないことを構造的に保証する。origin-ai の managed agent
 *   `customer-reply-writer` は出力 (`text`) をセンチネルトークンで構造化する。
 *   本モジュールはそれを **サーバ側で** パースし (single source of truth)、
 *   START/END トークンの「厳密に間」を顧客向け本文 `customerReply` として取り出す。
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

/**
 * CUSTOMER_REPLY ブロックの開始/終了センチネル (トークンアンカー)。
 *
 * 検出は「raw 全文中のユニークなリテラルトークン」として行う (行全体一致ではない)。
 * これにより agent が START と同一行先頭にツール実行ナレーションを連結した出力
 * (例: "まず社内ナレッジを検索します。<<<ORIGIN_CS_CUSTOMER_REPLY_V1>>>") も許容する。
 * このユニークトークンは本物の顧客テキストには出現しないため、トークンアンカーは
 * 安全であり、欠落/重複/不正形に対しては従来どおり fail-closed のまま。
 */
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

/** raw 全文中に sentinel トークンが現れる回数を数える (リテラル部分文字列一致)。 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * agent 出力 (PII 復元済み) を顧客向け / 社内用に分離する。
 *
 * 検出は「トークンアンカー」: START/END センチネルを raw 全文中の **ユニークな
 * リテラルトークン** として位置特定する (行全体一致ではない)。これにより START と
 * 同一行先頭に連結されたツール実行ナレーションや前後の空白を自然に許容する一方、
 * 安全特性 (社内テキストが customerReply に絶対入らない / 不正形は fail-closed) は不変。
 *
 * parseOk=true の全要件:
 *  1. START トークンが raw 全文でちょうど 1 回出現
 *  2. END トークンが raw 全文でちょうど 1 回出現
 *  3. START の位置が END の位置に先行 (START index < END index)
 *  4. START トークン直後 (同一行 suffix) に非空白が無い
 *     (緩和は「START 前の同一行 narration」のみ。START 後ろの連結は不可)
 *  4b. END トークン直前 (同一行 prefix) に非空白が無い (END は実質行頭)
 *  5. START 終端〜END 始端の「厳密に間」の本文が trim 後に非空
 *  6. その本文に既知内部マーカー (FORBIDDEN_IN_CUSTOMER_BODY) を一切含まない
 *  7. その本文に ORIGIN_CS センチネル系 (開始/終了/INTERNAL/CUSTOMER) を一切含まない
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
    return failClosed;
  }

  // 行末を正規化 (\r\n / 単独 \r → \n) してから以降の index 計算・slice を行う。
  //   旧 splitLines が \r\n と単独 \r を共に \n 扱いしていたのと同じ前提を維持し、
  //   START/END 行の境界探索 (indexOf/lastIndexOf '\n') が CR-only 出力でも成立する
  //   ようにする (codex CODE review P3: CR-only envelope の取りこぼし回避)。
  //   センチネルトークンは \r/\n を含まないため index 整合性は保たれる。
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // (1)(2) START/END トークンが各々ちょうど 1 回出現することを要件にする。
  //   START トークンは END トークンの部分文字列ではない (`<<<ORIGIN_CS_...` vs
  //   `<<<END_ORIGIN_CS_...`) ため、両者の出現数は独立に数えてよい。
  if (
    countOccurrences(text, CUSTOMER_REPLY_START) !== 1 ||
    countOccurrences(text, CUSTOMER_REPLY_END) !== 1
  ) {
    return failClosed;
  }

  const startIdx = text.indexOf(CUSTOMER_REPLY_START);
  const endIdx = text.indexOf(CUSTOMER_REPLY_END);
  const bodyStart = startIdx + CUSTOMER_REPLY_START.length;

  // (3) START が END に先行 (本文 0 文字も後段 (5) で弾く)
  if (!(startIdx < endIdx)) {
    return failClosed;
  }

  // (4) START トークン「直後」(同一行 suffix) に非空白があれば fail-closed。
  //   緩和対象は「START の前(同一行先頭)に連結された narration」のみ。START の
  //   後ろに narration が連結された形 (<<<START>>>確認します。\n本文) は、その
  //   narration が customerBody に滑り込むため許容しない (codex CODE review P1)。
  //   旧「行全体一致」が START 後方に持っていた fail-closed 性を復元する。
  //   CRLF の \r は空白扱いなので `<<<START>>>\r\n本文` は通る。
  const startLineEnd = text.indexOf('\n', bodyStart);
  const startLineRest = text.slice(
    bodyStart,
    startLineEnd === -1 ? text.length : startLineEnd,
  );
  if (startLineRest.trim() !== '') {
    return failClosed;
  }

  // (4b) END トークン「直前」(同一行 prefix) に非空白があれば fail-closed (START 側と対称)。
  //   <<<START>>>\n本文\n次に確認します<<<END>>> のように END 直前へ narration が
  //   連結されると customerBody に滑り込むため許容しない (codex CODE review P1)。
  //   END 始端直前の最後の改行から END 始端までが空白のみなら OK (= END が実質行頭)。
  //   CRLF の \r は空白扱いなので `本文\r\n<<<END>>>` は通る。
  const endLineStart = text.lastIndexOf('\n', endIdx - 1);
  const endLinePrefix = text.slice(
    endLineStart === -1 ? 0 : endLineStart + 1,
    endIdx,
  );
  if (endLinePrefix.trim() !== '') {
    return failClosed;
  }

  // (5) START 終端〜END 始端の「厳密に間」の本文が trim 後に非空。
  //   START と同一行の前置きナレーション・前後空白はこの slice の外なので
  //   customerBody には入らない。END より後ろの全文も入らない。
  const customerBody = text.slice(bodyStart, endIdx).trim();
  if (!customerBody) {
    return failClosed;
  }

  // (6) 顧客本文に既知内部マーカーが混入していたら fail-closed
  for (const marker of FORBIDDEN_IN_CUSTOMER_BODY) {
    if (customerBody.includes(marker)) {
      return failClosed;
    }
  }

  // (7) 顧客本文に ORIGIN_CS センチネル系 (開始/終了/INTERNAL/CUSTOMER いずれも) が
  //   残存していたら fail-closed (codex CONCERN#2: マーカーなし混入の最低限の防壁。
  //   FORBIDDEN_IN_CUSTOMER_BODY の `<<<ORIGIN_CS_INTERNAL` では END_ 系や入れ子の
  //   CUSTOMER センチネルを取りこぼすため、センチネル接頭辞を網羅的に拒否する)。
  if (/<<<\s*(END_)?ORIGIN_CS_/i.test(customerBody)) {
    return failClosed;
  }

  // internalPreview = raw から CUSTOMER_REPLY ブロック (START..END トークン含む) を
  //   除いた残り。START 前のナレーション・END 後の根拠/メモをオペレータ表示用に
  //   そのまま残す。customerBody 由来の再構成は混ぜない (生 raw からの slice のみ)。
  const internalPreview = (
    text.slice(0, startIdx) + text.slice(endIdx + CUSTOMER_REPLY_END.length)
  ).trim();

  return {
    customerReply: customerBody,
    internalPreview,
    parseOk: true,
  };
}
