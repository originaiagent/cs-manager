import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { getCredential, CredentialFetchError } from '@/lib/credentials';
import { ingestInboundWithDraft } from '@/lib/sync/ingest-inbound';
import { verifyLineSignature } from '@/channels/line/verify';
import {
  isTextMessageEvent,
  normalizeLineTextEvent,
  type LineWebhookBody,
  type LineWebhookEvent,
} from '@/channels/line/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * LINE Messaging API 受信 webhook (push 型チャネルの 3 例目)
 *
 * 流れ: raw body 読取 → 単一 active line channel 解決 → channel secret を Core から取得 →
 *       x-line-signature を raw body に対し HMAC-SHA256/Base64 で timing-safe 検証 →
 *       (検証後に初めて JSON.parse) → text message event のみ共通 ingest に委譲。
 * 共通 ingest が「ticket+message 冪等 upsert → 新規なら origin-ai RAG ドラフト生成 →
 * ticket_drafts(source='rag', status='pending') 保存」を行う。本ハンドラは RAG を直接呼ばない。
 *
 * 認可: LINE 独自署名 (x-line-signature) のみ。api-auth ヘルパは使わない。
 *
 * 安全性 (設計レビュー: codex CONCERN 2026-06-12 反映):
 *  - 署名検証前に body を加工・parse しない。timing-safe 比較 (verifyLineSignature)。
 *  - 鍵をハードコードしない (Core /api/credentials/line_messaging 経由)。
 *  - PII (本文/userId) を error 応答・ログに出さない (種別コードのみ)。
 *  - CredentialFetchError は status を問わず PII なしで捕捉し 503 に丸める。
 *  - 署名 OK 後の内部エラーは握って 200 を返す (LINE は非200で再送するため無限再送防止)。
 *    未設定 (503) / 署名不一致 (401) は受信前段なので非200で返す。
 *  - エラー応答は api-contract に従い `{ error: string }` 形式 (+ ok フラグ)。
 */

// LINE webhook の実用上限は十分小さい。過大 body を弾く防御 (1MB)。
const MAX_BODY_BYTES = 1_048_576;

/** config.service_code 未宣言時の既定。 */
const DEFAULT_LINE_CRED_SERVICE_CODE = 'line_messaging';
/**
 * line channel が指定してよい service_code の allowlist (orchestrator 側 pull allowlist と同趣旨の多層防御)。
 * config 改竄で他サービスの Vault 鍵を引かせない。LINE 系の追加時のみここへ足す。
 */
const ALLOWED_LINE_SERVICE_CODES = new Set<string>([DEFAULT_LINE_CRED_SERVICE_CODE]);

interface LineCredential {
  channel_secret?: string;
  channelSecret?: string;
}

export async function POST(req: NextRequest) {
  // body サイズガード (Content-Length は信頼しきれないため読み取り後にも再確認)
  const declaredLen = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  // 1. raw body を文字列で読む (加工・parse しない)
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  const sb = await getSupabaseAdmin();

  // 2. 単一 active line channel を解決 (MVP=単一LINE運用前提)
  // TODO: 複数 LINE 運用は destination で channel を引く拡張に変える。
  const { data: channel, error: chErr } = await sb
    .from('channels')
    .select('id, config')
    .eq('code', 'line')
    .eq('status', 'active')
    .maybeSingle();
  if (chErr) {
    console.error('[line-inbound] channel lookup failed', { code: chErr.code ?? null });
    return NextResponse.json({ ok: false, error: 'channel lookup failed' }, { status: 503 });
  }
  if (!channel) {
    // active な line channel 未設定 (配線前)。
    return NextResponse.json({ ok: false, error: 'line channel not configured' }, { status: 503 });
  }

  const channelId = channel.id as string;
  const config = (channel.config ?? {}) as Record<string, unknown>;
  const scopeKey = typeof config.scope_key === 'string' ? config.scope_key : undefined;
  // service_code は config 駆動 (ハードコード禁止)。allowlist 外は misconfig として 503。
  const serviceCode =
    typeof config.service_code === 'string' && config.service_code.trim()
      ? config.service_code.trim()
      : DEFAULT_LINE_CRED_SERVICE_CODE;
  if (!ALLOWED_LINE_SERVICE_CODES.has(serviceCode)) {
    console.error('[line-inbound] service_code not in allowlist');
    return NextResponse.json({ ok: false, error: 'line channel misconfigured' }, { status: 503 });
  }

  // 3/4. channel secret を Core から取得 (env 非依存)。未投入は 503 (endpoint は存在するが受信不可)。
  let channelSecret: string;
  try {
    const cred = await getCredential<LineCredential>(serviceCode, scopeKey ?? null);
    const secret = cred.credentials?.channel_secret ?? cred.credentials?.channelSecret ?? '';
    if (!secret) {
      console.error('[line-inbound] channel_secret missing in credential');
      return NextResponse.json({ ok: false, error: 'line credential not provisioned' }, { status: 503 });
    }
    channelSecret = secret.replace(/\s+$/, '');
  } catch (err) {
    // CredentialFetchError(404=未投入) も含め全 status を PII なしで 503 に丸める。
    const status = err instanceof CredentialFetchError ? (err.status ?? null) : null;
    console.error('[line-inbound] credential fetch failed', { status });
    return NextResponse.json({ ok: false, error: 'line credential unavailable' }, { status: 503 });
  }

  // 5. 署名検証 (raw body に対し HMAC-SHA256 → Base64、timing-safe 比較)
  const signature = req.headers.get('x-line-signature');
  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
  }

  // 6. 検証成功後に初めて JSON.parse
  let body: LineWebhookBody;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: 'json object required' }, { status: 400 });
    }
    body = parsed as LineWebhookBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const events: LineWebhookEvent[] = Array.isArray(body.events) ? body.events : [];

  // 7/8. text message event のみ順次取り込み。1 件失敗しても他を継続。
  // 署名 OK 後は常に 200 を返す (LINE の非200再送で無限ループさせない)。
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const ev of events) {
    if (!isTextMessageEvent(ev)) {
      skipped += 1;
      continue;
    }
    try {
      const { ticket, inboundMessage, ragInput } = normalizeLineTextEvent(ev, channelId);
      await ingestInboundWithDraft(sb, { channelId, ticket, inboundMessage, ragInput });
      processed += 1;
    } catch (err) {
      // PII を含めない種別ログのみ (本文/userId は出さない)。
      failed += 1;
      console.error('[line-inbound] event ingest failed', {
        name: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  return NextResponse.json({ ok: true, processed, skipped, failed });
}
