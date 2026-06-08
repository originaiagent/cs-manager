/**
 * `list` capability — manifest の place 一覧を返す (DB/network 不要)。
 * 正本: minpaku-tool/src/mcp/capabilities/list.ts。
 */

import { getForm, SCHEMA_VERSION } from '@/lib/mcp/manifest';

export type ListResult =
  | { ok: true; data: { form_id: string; schema_version: string; places: unknown[] } }
  | { ok: false; message: string };

export function handleList(args: { form_id: string }): ListResult {
  const form = getForm(args.form_id);
  if (!form) {
    return { ok: false, message: `form_id "${args.form_id}" は manifest に未定義です` };
  }
  return {
    ok: true,
    data: { form_id: form.form_id, schema_version: SCHEMA_VERSION, places: form.places },
  };
}
