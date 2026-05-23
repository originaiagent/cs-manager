/**
 * 楽天 R-MessE — 営業時間外一次返信の単発送信 (first_response 専用)
 *
 * codex CONCERN #3: 既存 `sendApprovedDrafts` は status='approved' を全件 sweep するため
 *   一次返信の自動送信には使わない。本関数は **draftId 指定の単発送信**で、送信直前に
 *   以下を必ず再確認する (fail-closed):
 *     1. rag_config.rakuten_auto_send_enabled = true
 *     2. draft.source = 'first_response' かつ未送信 (status != 'sent', external_message_id 無)
 *     3. has_business_hours_defined(channel_id) = true (営業時間未定義での 24h auto-send 防止)
 *     4. is_within_business_hours(channel_id, now) = false (codex R3 #4):
 *        送信 POST の直前に再判定し、営業時間内なら送信を中止する。遅延実行や draft 再利用で
 *        営業時間内に滑り込むのを防ぐ。判定が true → 'within_business_hours' で blocked、
 *        RPC error/null → fail-closed で送信しない ('no_business_hours')。
 *
 * 冪等性: ticket_drafts.status / external_message_id で二重送信を防止 (DB の partial UNIQUE
 *   index と併せて二重生成も防止)。POST 成功直後に status='sent' を確定してから ID 解決する
 *   既存 outbound.ts の方式を踏襲。
 *
 * 送信経路: origin-core 経由ではなく cs-manager 直送 (既存踏襲)。R-MessE cred は
 *   getCredential('rakuten_rmesse', shopId) で Core から read のみ (origin-core DB 非書込)。
 *
 * エラー sanitize (codex R3 #5): last_error / 返り値 error には R-MessE/HTTP の raw body
 *   (顧客データを含み得る) を保存しない。エラークラス名 + HTTP ステータスコードのみを残す。
 */

import { getCredential } from '@/lib/credentials';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { formatChannelMessageId } from '../_lib/ids';
import type { RakutenCredentials } from './auth';
import { RakutenApiError, RakutenInquiryClient } from './client';

export interface FirstResponseSendResult {
  /** 実際に送信したか。false の場合 reason を見る */
  sent: boolean;
  /** 'auto_send_disabled' | 'no_business_hours' | 'within_business_hours' | 'already_sent'
   *  | 'not_first_response' | 'channel_not_rakuten' | 'sent' | 'error' */
  reason: string;
  externalMessageId?: string | null;
  /** サニタイズ済みエラー文字列 (クラス名 + HTTP ステータスのみ、raw body は含めない) */
  error?: string;
}

/**
 * 例外を PII-safe な文字列に変換する (codex R3 #5)。
 * R-MessE/HTTP のレスポンス本文 (顧客データ含み得る) は捨て、クラス名と HTTP ステータスのみ残す。
 */
function sanitizeError(err: unknown): string {
  if (err instanceof RakutenApiError) {
    return `RakutenApiError:status=${err.status}`;
  }
  if (err instanceof Error) {
    // message には外部本文が混入し得るため出さない。クラス名のみ。
    return err.name || 'Error';
  }
  return 'UnknownError';
}

interface DraftRow {
  id: string;
  body: string;
  source: string;
  status: string;
  external_message_id: string | null;
  ticket_id: string;
  ticket: { id: string; external_id: string; channel_id: string };
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function parseRegDateToIso(regDate: string): string {
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(regDate);
  const normalized = hasTz ? regDate : `${regDate}+09:00`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * first_response draft を 1 件、楽天 R-MessE に送信する。
 * 送信前に flag / source / business_hours 定義を再確認 (fail-closed)。
 */
export async function sendFirstResponseDraft(
  draftId: string,
): Promise<FirstResponseSendResult> {
  const sb = await getSupabaseAdmin();

  // (0) flag 再確認 (送信直前の最終ガード)
  const { data: cfg } = await sb
    .from('rag_config')
    .select('config_value')
    .eq('config_key', 'rakuten_auto_send_enabled')
    .maybeSingle();
  const autoSend =
    cfg?.config_value === true ||
    (typeof cfg?.config_value === 'string' && cfg.config_value.toLowerCase() === 'true');
  if (!autoSend) {
    return { sent: false, reason: 'auto_send_disabled' };
  }

  // (1) draft + ticket 取得
  const { data: raw, error: draftErr } = await sb
    .from('ticket_drafts')
    .select(
      'id, body, source, status, external_message_id, ticket_id, ticket:tickets!inner(id, external_id, channel_id)',
    )
    .eq('id', draftId)
    .maybeSingle();
  if (draftErr) return { sent: false, reason: 'error', error: draftErr.message };
  if (!raw) return { sent: false, reason: 'error', error: 'draft not found' };

  const ticketRel = Array.isArray((raw as any).ticket)
    ? (raw as any).ticket[0]
    : (raw as any).ticket;
  const draft: DraftRow = {
    id: (raw as any).id,
    body: (raw as any).body,
    source: (raw as any).source,
    status: (raw as any).status,
    external_message_id: (raw as any).external_message_id ?? null,
    ticket_id: (raw as any).ticket_id,
    ticket: {
      id: ticketRel?.id,
      external_id: ticketRel?.external_id,
      channel_id: ticketRel?.channel_id,
    },
  };

  // (2) source / 冪等性 再確認
  if (draft.source !== 'first_response') {
    return { sent: false, reason: 'not_first_response' };
  }
  if (draft.status === 'sent' || draft.external_message_id) {
    return {
      sent: false,
      reason: 'already_sent',
      externalMessageId: draft.external_message_id,
    };
  }

  // (3) channel 解決 + rakuten 限定 + 営業時間定義の存在 (auto-send 追加ガード)
  const { data: channel } = await sb
    .from('channels')
    .select('id, code, config')
    .eq('id', draft.ticket.channel_id)
    .maybeSingle();
  if (!channel || channel.code !== 'rakuten') {
    return { sent: false, reason: 'channel_not_rakuten' };
  }

  const { data: bhDefined } = await sb.rpc('has_business_hours_defined', {
    channel_id_param: draft.ticket.channel_id,
  });
  if (bhDefined !== true) {
    return { sent: false, reason: 'no_business_hours' };
  }

  // (3') 送信直前の営業時間 再チェック (codex R3 #4, fail-closed)
  //   営業時間内 (true) → 送信中止 (within_business_hours)。一次返信は営業時間外専用のため。
  //   RPC error/null → 安全側に倒して送信しない (no_business_hours)。
  const { data: withinNow, error: withinErr } = await sb.rpc('is_within_business_hours', {
    channel_id_param: draft.ticket.channel_id,
    check_time: new Date().toISOString(),
  });
  if (withinErr || withinNow == null) {
    return { sent: false, reason: 'no_business_hours' };
  }
  if (withinNow === true) {
    return { sent: false, reason: 'within_business_hours' };
  }

  // (4) 送信
  const cfgObj = (channel.config ?? {}) as Record<string, unknown>;
  // api_base はハードコード fallback を持たず channels.config.api_base 必須 (codex R3 #6、
  // first_response 経路限定。adapter.ts / outbound.ts の既存運用は変更しない)。
  const apiBase = asStr(cfgObj.api_base, '');
  if (!apiBase) {
    return {
      sent: false,
      reason: 'error',
      error: `channels.config.api_base is required (channel_id=${channel.id})`,
    };
  }
  const shopId = asStr(cfgObj.shop_id, '');
  if (!shopId) {
    return {
      sent: false,
      reason: 'error',
      error: `channels.config.shop_id is required (channel_id=${channel.id})`,
    };
  }

  try {
    const credResp = await getCredential<RakutenCredentials>('rakuten_rmesse', shopId);
    const client = new RakutenInquiryClient({
      apiBase,
      credentials: credResp.credentials,
    });

    const replyRes = await client.sendReply({
      inquiryNumber: draft.ticket.external_id,
      shopId,
      message: draft.body,
    });
    const regDate = replyRes.result.regDate;
    const sentAt = parseRegDateToIso(regDate);

    // POST 成功 → 即 status=sent + 暫定 external_message_id (二重送信防止: ID 取得前にコミット)
    const provisionalExternalId = `regdate:${regDate}`;
    await sb
      .from('ticket_drafts')
      .update({
        status: 'sent',
        sent_at: sentAt,
        external_message_id: provisionalExternalId,
        last_error: null,
      })
      .eq('id', draft.id);

    // outbound message を upsert (会話履歴に残す)
    await sb.from('messages').upsert(
      {
        ticket_id: draft.ticket_id,
        channel_message_id: formatChannelMessageId('reply-pending', draft.id),
        direction: 'outbound',
        body: draft.body,
        sender_name: null,
        sent_at: sentAt,
        attachments: [],
      },
      { onConflict: 'ticket_id,channel_message_id' },
    );

    // 本物 reply.id 解決 (失敗しても暫定値が残る)
    let realId: string | null = null;
    try {
      const inq = await client.getInquiry(draft.ticket.external_id);
      const replies = inq.result.replies ?? [];
      const match = [...replies]
        .reverse()
        .find(
          (r) =>
            (r.message ?? '') === draft.body &&
            typeof r.regDate === 'string' &&
            r.regDate.startsWith(regDate.slice(0, 19)),
        );
      if (match && match.id !== undefined) {
        realId = String(match.id);
        await sb
          .from('ticket_drafts')
          .update({ external_message_id: realId })
          .eq('id', draft.id);
      }
    } catch {
      // ID 解決失敗は致命でない (暫定値維持)
    }

    return {
      sent: true,
      reason: 'sent',
      externalMessageId: realId ?? provisionalExternalId,
    };
  } catch (err) {
    // raw body (顧客データ含み得る) は保存せず、クラス名 + HTTP ステータスのみ (codex R3 #5)
    const sanitized = sanitizeError(err);
    await sb
      .from('ticket_drafts')
      .update({ last_error: sanitized })
      .eq('id', draft.id);
    return { sent: false, reason: 'error', error: sanitized };
  }
}
