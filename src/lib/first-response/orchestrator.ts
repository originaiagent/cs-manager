/**
 * 営業時間外 一次返信フロー オーケストレータ (cs-manager)
 *
 * 設計: cs-manager-stage2-phase0-design.md §10 / codex (手元) CONCERN 5 指摘を全反映。
 *
 * フロー:
 *   gate1: rag_config.first_response_enabled = true (フロー全体)
 *   gate2: is_within_business_hours(channel_id) — 時間内 → draft 限定 (本フローは何もしない)
 *   時間外:
 *     (a) AI 分類 (masked テキストのみ origin-ai へ。CONCERN #1)
 *     (b) first_response_templates から category + channel 一致で 1 件選択
 *         (channel 一致優先 → 共通(channel_id IS NULL) → is_active → version desc)
 *     (c) placeholder 軽整形: {{customer_name}} は raw 顧客名、{{product_name}} は
 *         Core /api/v1/master/products から取得した name で **ローカル復元**
 *     (d) 末尾に「※翌営業日に…」(rag_config 駆動の定型文) を付与
 *     (e) ticket_drafts に source='first_response' で保存 (DB partial UNIQUE で冪等。CONCERN #2)
 *     (f) rakuten_auto_send_enabled=true の時のみ R-MessE 単発送信 (CONCERN #3/#4)。
 *         既定 false → dry-run (送信せず draft + send_audit result='dry_run')
 *
 * PII boundary: 外部 (origin-ai) へ送るのは masked のみ。raw 顧客名/商品名は **送信本文
 *   生成のためのローカル復元** にのみ使い、log / send_audit には masked 値しか残さない。
 *
 * 戻り値はフロー結果サマリ (raw PII を含めない)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchProductById } from '@/lib/core-client';
import { classifyInquiry } from './classify';
import { loadFirstResponseConfig } from './config';
import { resolveRagInternalKey } from './mask';
import { recordSendAudit, type SendAuditResult } from './audit';
import { sendFirstResponseDraft } from '@/channels/rakuten/send-first-response';

const MAX_THREAD_MESSAGES = 10;

export interface FirstResponseOutcome {
  /** 'disabled' | 'within_hours' | 'no_business_hours_info' | 'no_template'
   *  | 'already_handled' | 'dry_run' | 'sent' | 'send_failed' | 'blocked' | 'error' */
  status: string;
  category?: string;
  draftId?: string | null;
  sendResult?: SendAuditResult;
  externalMessageId?: string | null;
  error?: string;
}

interface TicketRow {
  id: string;
  channel_id: string | null;
  customer_name: string | null;
  subject: string | null;
  product_id: string | null;
}

interface TemplateRow {
  id: string;
  category: string;
  channel_id: string | null;
  body_template: string;
  version: number;
}

/** 翌営業日連絡の定型文を本文末尾に付与 (重複付与は避ける)。 */
function appendNote(body: string, note: string): string {
  const n = note.trim();
  if (!n) return body;
  if (body.includes(n)) return body;
  return `${body.trimEnd()}\n\n${n}`;
}

/** template 内の {{placeholder}} をローカル値で復元。未知 placeholder は空にせず残す。 */
function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) => {
    const v = values[key];
    return v !== undefined ? v : m;
  });
}

/**
 * 営業時間外一次返信フローを実行する。
 * @param sb cs-manager service_role クライアント
 * @param ticketId 対象 ticket
 */
export async function runFirstResponseFlow(
  sb: SupabaseClient,
  ticketId: string,
): Promise<FirstResponseOutcome> {
  const config = await loadFirstResponseConfig(sb);

  // gate1: フロー全体の有効化 (既定 false → 何もしない)
  if (!config.enabled) {
    return { status: 'disabled' };
  }

  // ticket 取得 (raw PII 含む。外部には送らない)
  const { data: t, error: tErr } = await sb
    .from('tickets')
    .select('id, channel_id, customer_name, subject, product_id')
    .eq('id', ticketId)
    .maybeSingle();
  if (tErr) return { status: 'error', error: tErr.message };
  if (!t) return { status: 'error', error: 'ticket not found' };
  const ticket = t as TicketRow;

  // 冪等性 (アプリ側 fast-path。最終的な race 防止は DB partial UNIQUE index)
  const { data: existing } = await sb
    .from('ticket_drafts')
    .select('id, status')
    .eq('ticket_id', ticket.id)
    .eq('source', 'first_response')
    .maybeSingle();
  if (existing) {
    return { status: 'already_handled', draftId: (existing as { id: string }).id };
  }

  // gate2: 営業時間判定 (channel_id 無し → 判定不可、安全のため何もしない)
  if (!ticket.channel_id) {
    return { status: 'no_business_hours_info' };
  }
  const { data: within, error: bhErr } = await sb.rpc('is_within_business_hours', {
    channel_id_param: ticket.channel_id,
    check_time: new Date().toISOString(),
  });
  if (bhErr) return { status: 'error', error: bhErr.message };
  if (within === true) {
    // 営業時間内 → draft 限定 (人間 click)。本フローは送信しない
    return { status: 'within_hours' };
  }

  // --- 営業時間外 ---

  // 最新 inbound 本文 (問い合わせ文)
  const { data: msgs } = await sb
    .from('messages')
    .select('direction, body, sent_at')
    .eq('ticket_id', ticket.id)
    .order('sent_at', { ascending: true });
  const recent = (msgs ?? []).slice(-MAX_THREAD_MESSAGES);
  const inbound = recent.filter((m) => m.direction === 'inbound');
  const inquiryBody =
    (inbound.length > 0 ? inbound[inbound.length - 1] : recent[recent.length - 1])
      ?.body ?? '';

  // origin-ai 認証鍵 (Core 解決)
  let internalKey: string;
  try {
    internalKey = await resolveRagInternalKey();
  } catch (e) {
    return { status: 'error', error: `auth resolve failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // (a) AI 分類 (masked のみ外部送信)
  const cls = await classifyInquiry(internalKey, ticket.subject, inquiryBody, config);
  const category = cls.category;

  // (a') mask_failed fail-closed (codex R3 #2, Blocker):
  //   PII マスクに失敗した場合、外部送信の前提 (raw を外に出さない) が崩れるため、
  //   template 選択 / draft 作成 / 送信のいずれにも進まず、blocked の audit のみ残して中断する。
  //   raw 値は audit に残さない (error_sanitized='mask_failed' とスナップショットのみ)。
  if (cls.maskFailed) {
    await recordSendAudit(sb, {
      ticketId: ticket.id,
      channelId: ticket.channel_id,
      category,
      result: 'blocked',
      errorSanitized: 'mask_failed',
      configSnapshot: {
        reason: 'mask_failed',
        enabled: config.enabled,
        autoSend: config.rakutenAutoSendEnabled,
        classifySource: cls.source,
      },
    });
    return { status: 'blocked', category };
  }

  // (b) template 選択: category 一致、channel 一致優先 → 共通、active、version desc
  const { data: tpls } = await sb
    .from('first_response_templates')
    .select('id, category, channel_id, body_template, version')
    .eq('category', category)
    .eq('is_active', true)
    .or(`channel_id.eq.${ticket.channel_id},channel_id.is.null`)
    .order('version', { ascending: false });
  const candidates = (tpls ?? []) as TemplateRow[];
  // channel 一致を最優先、その後 version desc (上の order で version は既に降順)
  candidates.sort((a, b) => {
    const aCh = a.channel_id === ticket.channel_id ? 0 : 1;
    const bCh = b.channel_id === ticket.channel_id ? 0 : 1;
    if (aCh !== bCh) return aCh - bCh;
    return b.version - a.version;
  });
  const template = candidates[0];
  if (!template) {
    // template 無 → ハードコードせず中止 (監査だけ残す)
    await recordSendAudit(sb, {
      ticketId: ticket.id,
      channelId: ticket.channel_id,
      category,
      result: 'skipped',
      configSnapshot: { reason: 'no_template', enabled: config.enabled, autoSend: config.rakutenAutoSendEnabled },
    });
    return { status: 'no_template', category };
  }

  // (c) placeholder 復元値 (ローカルのみ。raw を log/audit に出さない)
  const customerName = ticket.customer_name?.trim() ?? '';
  let productName = '';
  if (ticket.product_id) {
    const pr = await fetchProductById(ticket.product_id);
    if (pr.ok && pr.product?.product_name) productName = String(pr.product.product_name);
  }
  const placeholderValues: Record<string, string> = {};
  if (customerName) placeholderValues.customer_name = customerName;
  if (productName) placeholderValues.product_name = productName;

  let body = renderTemplate(template.body_template, placeholderValues);
  // (d) 翌営業日連絡の定型文
  body = appendNote(body, config.nextBusinessDayNote);

  // send_audit / log 用のマスク済み差込値 (raw は残さない)
  const maskedPlaceholders: Record<string, string> = {};
  if (customerName) maskedPlaceholders.customer_name = '<masked>';
  if (productName) maskedPlaceholders.product_name = '<masked>';

  // (e) ticket_drafts 保存 (source='first_response'、status は送信判定前は pending)
  //     DB partial UNIQUE index が同時生成を 1 件に制約 (race-safe)
  const { data: inserted, error: insErr } = await sb
    .from('ticket_drafts')
    .insert({
      ticket_id: ticket.id,
      body,
      source: 'first_response',
      status: 'pending',
    })
    .select('id')
    .maybeSingle();
  if (insErr) {
    // unique 違反 (23505) = 他プロセスが先に生成済 → already_handled 扱い (冪等)
    if ((insErr as { code?: string }).code === '23505') {
      return { status: 'already_handled' };
    }
    return { status: 'error', error: insErr.message, category };
  }
  const draftId = (inserted as { id: string } | null)?.id ?? null;

  const baseAudit = {
    ticketId: ticket.id,
    draftId,
    channelId: ticket.channel_id,
    category,
    templateId: template.id,
    templateVersion: template.version,
    maskedPlaceholders,
    bodyForHash: body,
    hmacServiceCode: config.auditHmacServiceCode,
  };

  // (f) 自動送信 flag が false → dry-run (送信せず draft + audit のみ)
  if (!config.rakutenAutoSendEnabled) {
    await recordSendAudit(sb, {
      ...baseAudit,
      result: 'dry_run',
      configSnapshot: { autoSend: false, classifySource: cls.source, maskFailed: cls.maskFailed },
    });
    return { status: 'dry_run', category, draftId, sendResult: 'dry_run' };
  }

  // 自動送信 ON: 単発送信 (send 側でも flag/source/business_hours を再確認)
  if (!draftId) {
    return { status: 'error', error: 'draft id missing after insert', category };
  }
  const send = await sendFirstResponseDraft(draftId);
  if (send.sent) {
    await recordSendAudit(sb, {
      ...baseAudit,
      result: 'sent',
      externalMessageId: send.externalMessageId ?? null,
      configSnapshot: { autoSend: true, classifySource: cls.source },
    });
    return {
      status: 'sent',
      category,
      draftId,
      sendResult: 'sent',
      externalMessageId: send.externalMessageId ?? null,
    };
  }

  // 送信されなかった: flag/前提未充足は 'blocked'、実エラーは 'failed'
  const blockedReasons = ['auto_send_disabled', 'no_business_hours', 'within_business_hours', 'channel_not_rakuten', 'already_sent', 'not_first_response'];
  const result: SendAuditResult = blockedReasons.includes(send.reason) ? 'blocked' : 'failed';
  await recordSendAudit(sb, {
    ...baseAudit,
    result,
    errorSanitized: send.error ?? send.reason,
    configSnapshot: { autoSend: true, sendReason: send.reason },
  });
  return {
    status: result === 'failed' ? 'send_failed' : 'blocked',
    category,
    draftId,
    sendResult: result,
    error: send.error,
  };
}
