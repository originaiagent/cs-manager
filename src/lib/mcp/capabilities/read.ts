/**
 * `read` capability — 箇所の現在値 + revision を返す。
 * 正本: minpaku-tool/src/mcp/capabilities/read.ts。
 *
 * 各ツールは getServiceValue を自ツールの service/API 層で実装する
 * (service_role 直 read でも可だが write は必ず service/API 経由)。
 */

import { getForm, getPlace } from '@/lib/mcp/manifest';
// TODO: 自ツールの read service を import する。
// import { readPlaceValue } from '@/lib/mcp/service';

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

  // TODO: 自ツール実装に置換。
  //   const v = await readPlaceValue(form, place, target_id, args.index);
  //   return { ok: true, data: { form_id, place_id, value: v.value, revision: v.revision } };
  void target_id;
  return { ok: false, message: 'read service 未実装 (このツールの service 層を配線すること)' };
}
