/**
 * AI 能力マニフェスト (/api/ai/*) 専用の内部鍵ガード。
 *
 * 全ツール共有の内部鍵 (origin-core が送る X-Internal-API-Key) を timing-safe に検証する。
 * backlog 20a408eb「全ツールAI能力カタログ」Stage2 ファンアウト。参照: ec-manager / skillquest。
 *
 * 接続鍵 Core 集約 Done-1 (2026-06-26 codex APPROVE):
 *   期待値は **Core service_code='core_internal_shared' (field api_key・全ツール共通値) のみ**。
 *   `getInboundVerifyKeys()` が Core 取得値 (stale-while-error 付き) を返す。
 *   移行期 env (INTERNAL_API_KEY / INTERNAL_API_KEY_NEW) 候補は除去した。
 *   比較は sha256 固定長 digest 同士の timingSafeEqual (長さ漏洩を避ける)。
 *
 * fail-closed:
 *   - ヘッダ非 string / 空 → Core 取得前に即 401 (未認証 probe で Core を叩かない)。
 *   - 候補キーが一つも無い (Core 未到達かつ stale 失効) → 500 (env 変数名は本文に出さない)。
 *   - 不一致 → 401 (ヒント文言なし)。候補キーは短絡せず全件評価する。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getInboundVerifyKeys } from '@/lib/credentials';

const HEADER_NAME = 'x-internal-api-key';

/** 末尾空白を除去。null/undefined → undefined。 */
function trimRight(v: string | undefined | null): string | undefined {
  if (v == null) return undefined;
  return v.replace(/\s+$/, '');
}

/** 固定長 (32 byte) sha256 digest を返す。 */
function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

/**
 * /api/ai/* ルートの先頭で呼ぶ。
 * @returns 認証失敗時は NextResponse (401/500)、成功時は null。
 *
 * 可用性 (codex 必須#1): ヘッダ非 string/空は Core 取得前に即 401 (DoS 耐性: 未認証 probe で
 * Core を叩かない)。それ以外のみ Core 共有鍵を取得して定数時間照合する。
 * async (Core 取得を含むため)。呼出側は await すること。
 */
export async function authorizeAiManifestRequest(
  req: NextRequest,
): Promise<NextResponse | null> {
  const provided = trimRight(req.headers.get(HEADER_NAME));

  // (0) ヘッダ非 string / 空 → Core 呼出前に即 401。
  if (!provided) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // (1) Core 共有鍵 (core_internal_shared) を取得 (Core 未到達かつ stale 失効は空配列)。
  const keys = await getInboundVerifyKeys();
  if (keys.length === 0) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // (2) 短絡なしで全候補を sha256 固定長 timing-safe 比較。
  const providedDigest = sha256(provided);
  let matched = false;
  for (const expected of keys) {
    if (typeof expected !== 'string' || expected.length === 0) continue;
    if (timingSafeEqual(providedDigest, sha256(expected))) matched = true;
  }
  if (matched) return null;

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
