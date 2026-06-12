/**
 * LINE Messaging API webhook 署名検証 (純関数)
 *
 * LINE は webhook POST のヘッダ `x-line-signature` に
 *   Base64( HMAC-SHA256( raw request body, channelSecret ) )
 * を載せてくる。受信側は **raw body を一切加工せず** 同じ計算を行い、
 * timing-safe に比較する。一致して初めて JSON.parse してよい。
 *
 * 公式: https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
 *
 * 設計レビュー: codex CONCERN (2026-06-12)。指摘反映:
 *  - timingSafeEqual は長さ不一致 / base64 不正でも throw しない (false を返す)。
 *  - 鍵・署名値はログに出さない (本関数は I/O を持たない純関数)。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * LINE webhook 署名を検証する。
 *
 * @param rawBody  検証対象の生リクエストボディ (UTF-8 文字列、未加工)
 * @param signature `x-line-signature` ヘッダ値 (Base64)。null/空なら不一致扱い
 * @param channelSecret LINE channel secret
 * @returns 署名一致なら true。不一致・欠損・不正フォーマットは false (throw しない)
 */
export function verifyLineSignature(
  rawBody: string,
  signature: string | null | undefined,
  channelSecret: string,
): boolean {
  if (!signature || !channelSecret) return false;

  // 期待署名を計算 (raw body をそのまま HMAC に通す)
  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest();

  // 受信署名を Base64 デコード。不正フォーマットでも throw させず false を返す。
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  // 長さが異なると timingSafeEqual が throw するため、先に長さで弾く。
  // (長さ差自体は秘匿対象ではない。HMAC-SHA256 は常に 32 byte 固定長。)
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}
