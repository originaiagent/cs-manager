/**
 * `read` capability — 箇所の現在値 + revision を返す。
 * 正本: minpaku-tool/src/mcp/capabilities/read.ts。
 *
 * in : { form_id, place_id, index? }
 * out: { form_id, place_id, value, revision }
 *
 * revision = customer_service_records.updated_at (etag として楽観ロックに使用)。
 * manifest に無い form_id / place_id は fail-closed 拒否。
 */

import { getForm, getPlace } from '@/lib/mcp/manifest';
import { getCustomerRecord } from '@/lib/mcp/service';

export type ReadResult =
  | { ok: true; data: { form_id: string; place_id: string; value: unknown; revision: string } }
  | { ok: false; message: string };

export async function handleRead(
  args: { form_id: string; place_id: string; index?: number },
  target_id: string,
): Promise<ReadResult> {
  const form = getForm(args.form_id);
  if (!form) return { ok: false, message: `form_id "${args.form_id}" は manifest に未定義です` };
  const place = getPlace(args.form_id, args.place_id);
  if (!place) return { ok: false, message: `place_id "${args.place_id}" は manifest に未定義です` };

  if (args.form_id === 'customer_record') {
    const result = await getCustomerRecord(target_id);
    if (!result.ok) return { ok: false, message: result.error.message };
    const record = result.data;
    const value = record[args.place_id] ?? null;
    const revision = record.updated_at ?? new Date(0).toISOString();
    return { ok: true, data: { form_id: args.form_id, place_id: args.place_id, value, revision } };
  }

  return { ok: false, message: `form_id "${args.form_id}" は未サポートです` };
}
