import { NextRequest, NextResponse } from 'next/server';
import { sendApprovedLineDrafts, type LineChannelRow } from '@/channels/line/outbound';
import type { AdapterLogger } from '@/channels/_lib/adapter';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * LINE Messaging API 専用 cron (5 分間隔) — **送信専用**
 *
 * 設計レビュー: codex APPROVE (2026-06-25) — docs/design/line-reply-wiring.md
 *
 * LINE は push webhook 受信 (`/api/channels/line/inbound`) のため、受信を cron で pull しない。
 * 本 cron は承認済みドラフトの送信のみを担う:
 *   1. code='line' AND status='active' な channels を loop
 *   2. 各 channel について sendApprovedLineDrafts (approved→sending claim→push→sent/failed/approved)
 *
 * 認可: `Authorization: Bearer ${CRON_SECRET}` または `X-Diag-Token: ${DIAG_TOKEN}` (楽天 cron と同パターン)。
 */

function makeLogger(prefix: string): AdapterLogger {
  const fmt = (extra?: Record<string, unknown>) => (extra ? ` ${JSON.stringify(extra)}` : '');
  return {
    info: (msg, extra) => console.log(`[${prefix}] ${msg}${fmt(extra)}`),
    warn: (msg, extra) => console.warn(`[${prefix}] ${msg}${fmt(extra)}`),
    error: (msg, extra) => console.error(`[${prefix}] ${msg}${fmt(extra)}`),
  };
}

async function loadActiveLineChannels(): Promise<LineChannelRow[]> {
  const supa = await getSupabaseAdmin();
  const { data, error } = await supa
    .from('channels')
    .select('id, code, config')
    .eq('status', 'active')
    .eq('code', 'line');
  if (error) throw new Error(`loadActiveLineChannels failed: ${error.message}`);
  return (data ?? []) as LineChannelRow[];
}

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'cron' });
  if (authError) return authError;

  const startedAt = new Date();
  try {
    const channels = await loadActiveLineChannels();
    const results: Array<{
      channelId: string;
      channelCode: string;
      outbound: { attempted: number; succeeded: number; failed: number };
      error?: string;
    }> = [];

    for (const ch of channels) {
      let outbound = { attempted: 0, succeeded: 0, failed: 0 };
      let channelError: string | undefined;
      try {
        const out = await sendApprovedLineDrafts(ch, makeLogger(`line-sync:outbound:${ch.code}`));
        outbound = { attempted: out.attempted, succeeded: out.succeeded, failed: out.failed };
      } catch (err) {
        channelError = err instanceof Error ? err.message : String(err);
      }
      results.push({ channelId: ch.id, channelCode: ch.code, outbound, error: channelError });
    }

    const hasError = results.some((r) => r.error);
    return NextResponse.json(
      {
        ok: !hasError,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        channels: results,
      },
      { status: hasError ? 207 : 200 },
    );
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
}

export const POST = GET;
