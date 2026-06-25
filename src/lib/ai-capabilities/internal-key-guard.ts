/**
 * AI 能力マニフェスト (/api/ai/*) 専用の内部鍵ガード。
 *
 * 全ツール共有の内部鍵 (origin-core が送る X-Internal-API-Key) を timing-safe に検証する。
 * backlog 20a408eb「全ツールAI能力カタログ」Stage2 ファンアウト。参照: ec-manager。
 *
 * 既存の `authorizeApiRoute({ tier: 'internal' })` と **wire 互換**:
 *   - 同じ `X-Internal-API-Key` ヘッダを読む (origin-core 送出値・ヘッダ名は不変)。
 *   - 同じ `INTERNAL_API_KEY` env を期待値に含む。
 * 差分は additive かつ受理範囲のスーパーセット (旧ガードが通す鍵は必ず通る):
 *   (a) `INTERNAL_API_KEY_NEW` も期待値に含める (鍵ローテーション対応)。
 *   (b) 接続鍵 Core 集約 (origin-core #332): Core service_code='core_internal_shared'
 *       (field api_key・全ツール共通値) 取得値も期待値候補に含める。getInboundVerifyKeys()
 *       が [Core 値, env INTERNAL_API_KEY, env INTERNAL_API_KEY_NEW] を返す。Core 未到達時も
 *       env fallback のみで継続 (fail-open しない: 候補が空なら 401)。
 *   (c) 比較は sha256 固定長 digest 同士の timingSafeEqual (長さ漏洩を避ける)。
 *       accept/reject の挙動は raw 比較と同一で、固定長化のみ。
 *
 * 設計レビュー: codex APPROVE (2026-06-18, A 解消版 / 2026-06-25, Core 集約版)。
 * 既存 `authorizeApiRoute` / 既存ルートは一切変更しない (この 2 ルートのみで使用)。
 *
 * fail-closed:
 *   - 候補キーが一つも無い (Core 未到達 かつ env 両方未設定) → 500 (env 変数名は本文に出さない)。
 *   - ヘッダ非 string / 空 / 不一致 → 401 (ヒント文言なし)。
 *   - 候補キーは短絡せず全件評価する。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getInboundVerifyKeys } from '@/lib/credentials';

const HEADER_NAME = 'x-internal-api-key';

/** 旧ガード (api-auth.ts) と同じ正規化: 末尾空白を除去。null/undefined → undefined。 */
function trimRight(v: string | undefined | null): string | undefined {
  if (v == null) return undefined;
  return v.replace(/\s+$/, '');
}

/** 固定長 (32 byte) sha256 digest を返す。 */
function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

/**
 * provided と expected を sha256 digest 同士の timingSafeEqual で比較する。
 * 両者とも非空文字列の場合のみ true になり得る。短絡や長さ分岐は持たない。
 */
function digestEquals(provided: string, expected: string): boolean {
  // sha256 は常に 32 byte 固定長。timingSafeEqual の長さ分岐は発生しない。
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * /api/ai/* ルートの先頭で呼ぶ。
 * @returns 認証失敗時は NextResponse (401/500)、成功時は null。
 *
 * Core 集約: 期待値候補に Core service_code='core_internal_shared' 取得値 + 移行期 env を含める。
 * async (Core 取得を含むため)。呼出側は await すること。
 */
export async function authorizeAiManifestRequest(
  req: NextRequest,
): Promise<NextResponse | null> {
  // [Core 値, env INTERNAL_API_KEY, env INTERNAL_API_KEY_NEW]。trim・空除外・重複除外済み。
  const candidates = await getInboundVerifyKeys();

  // 期待値が一つも無い = サーバ設定不備 (fail-closed)。Core 未到達 かつ env 両方未設定の場合のみ。
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const provided = trimRight(req.headers.get(HEADER_NAME));
  if (typeof provided !== 'string' || provided.length === 0) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 候補キーを短絡せず全件評価し、論理 OR を取る (タイミング差を最小化)。
  let matched = false;
  for (const expected of candidates) {
    if (digestEquals(provided, expected)) matched = true;
  }

  return matched ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
