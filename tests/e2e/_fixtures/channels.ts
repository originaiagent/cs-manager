/**
 * E2E test fixtures: DB から channels と sample ticket を動的取得する。
 *
 * チャネル一覧をテストにハードコードしないため、ここで Supabase service role 経由で取得し、
 * 全 spec で共有する(test.beforeAll で一度だけ呼ぶ)。
 */
import { createClient } from '@supabase/supabase-js';

export interface ChannelRow {
  code: string;
  display_name: string;
  status: string;
}

export interface E2EFixtures {
  channels: ChannelRow[];
  sampleTicketId: string | null;
}

let cached: E2EFixtures | null = null;

export async function loadE2EFixtures(): Promise<E2EFixtures> {
  if (cached) return cached;

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\s+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').replace(/\s+$/, '');
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL が未設定です (.env.local 確認)');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY が未設定です (.env.local 確認)');

  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: channels, error: chErr } = await sb
    .from('channels')
    .select('code, display_name, status')
    .order('code');
  if (chErr || !channels) throw new Error(`channels fetch failed: ${chErr?.message}`);
  if (channels.length === 0) throw new Error('channels テーブルが空です');

  const { data: tickets } = await sb
    .from('tickets')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1);
  const sampleTicketId = (tickets && tickets.length > 0) ? (tickets[0] as { id: string }).id : null;

  cached = {
    channels: channels as ChannelRow[],
    sampleTicketId,
  };
  return cached;
}
