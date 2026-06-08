/**
 * MCP signed manifest — TEMPLATE (各ツールが埋める)
 *
 * 正本: minpaku-tool/src/mcp/manifest.ts。
 * place_id は DB 列名 / API フィールド名と 1:1 対応 (durable id)。
 * manifest に無い place_id への read/write はすべて fail-closed 拒否。
 *
 * 各ツールの作業:
 *   1. TOOL_SLUG を自ツール slug に変更 (= ai_embed_clients.tool_slug / mcp_server_name)。
 *   2. FORMS を自ツールの業務エンティティ (DB列名に1:1) で定義。
 *   3. write を有効化する時のみ write_route / file_route を実値にする。
 */

import { createHash } from 'crypto';

export type PlaceType =
  | 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'lookup' | 'repeating' | 'file';

export interface PlaceValidation { min?: number; max?: number; pattern?: string; maxLength?: number; }
export interface EnumOption { value: string; label: string; }
export interface Place {
  place_id: string;
  label: string;
  type: PlaceType;
  required: boolean;
  writable: boolean;
  unit?: string;
  description?: string;
  example?: string;
  validation?: PlaceValidation;
  enum?: EnumOption[];
  lookup?: { source: string };
  repeating?: { item_places: Place[] };
  file?: { accept: string[]; max_bytes: number };
  conditional_on?: { place_id: string; equals: unknown };
}
export interface WriteRoute { method: string; path_template: string; }
export interface FileRoute { upload_path: string; bucket: string; }
export interface FormDefinition {
  form_id: string;
  target_type: string;
  places: Place[];
  write_route: WriteRoute;
  file_route: FileRoute;
}
export interface Manifest {
  tool_slug: string;
  schema_version: string;
  forms: FormDefinition[];
  signature: string;
  signed_at: string;
  generator: string;
}

export const SCHEMA_VERSION = '1.0.0';
// cs-manager の read-only 窓口 slug (= ai_embed_clients.tool_slug / mcp_server_name)。
export const TOOL_SLUG = 'cs-manager';

// ---------------------------------------------------------------------------
// フォーム定義 (customer_record) — customer_service_records テーブルに 1:1 対応
//
// cs-manager 自前の業務データ (顧客対応記録)。Core master / 財務 / 他WSデータではない。
// write 対象は memo (自由記述メモ) の単一 scalar text 列のみ。
//   - target_type = 'customer_record' は run token (JWT) の target_type と一致させる。
//   - place_id 'memo' は customer_service_records.memo 列名と durable に 1:1。
//   - repeating / file place は持たないため write は set op のみサポート。
// ---------------------------------------------------------------------------
const CUSTOMER_RECORD_PLACES: Place[] = [
  {
    place_id: 'memo',
    label: '対応メモ',
    type: 'text',
    required: false,
    writable: true,
    description: '顧客対応記録の自由記述メモ (customer_service_records.memo)',
    example: '返品リクエスト 対応済み',
    validation: { maxLength: 5000 },
  },
];

const FORMS: FormDefinition[] = [
  {
    form_id: 'customer_record',
    target_type: 'customer_record',
    places: CUSTOMER_RECORD_PLACES,
    write_route: { method: 'PATCH', path_template: '/api/customer-records/{target_id}' },
    // customer_record は file place を持たないが、型を満たすためのプレースホルダ。
    // place-file capability は route 側で disabled のため未使用。
    file_route: { upload_path: '/api/upload', bucket: 'customer-record-assets' },
  },
];

export function computeManifestSignature(forms: FormDefinition[], schemaVersion: string): string {
  const body = JSON.stringify({ schema_version: schemaVersion, forms }, null, 0);
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export const SIGNED_AT = '2026-06-08T00:00:00.000Z';

export const manifest: Manifest = {
  tool_slug: TOOL_SLUG,
  schema_version: SCHEMA_VERSION,
  forms: FORMS,
  signature: computeManifestSignature(FORMS, SCHEMA_VERSION),
  signed_at: SIGNED_AT,
  generator: 'claude-code',
};

export function getForm(form_id: string): FormDefinition | undefined {
  return manifest.forms.find((f) => f.form_id === form_id);
}
export function getPlace(form_id: string, place_id: string): Place | undefined {
  const form = getForm(form_id);
  if (!form) return undefined;
  return findPlace(form.places, place_id);
}
function findPlace(places: Place[], place_id: string): Place | undefined {
  for (const p of places) {
    if (p.place_id === place_id) return p;
    if (p.repeating) {
      const found = findPlace(p.repeating.item_places, place_id);
      if (found) return found;
    }
  }
  return undefined;
}
export function isWritable(form_id: string, place_id: string): boolean {
  return getPlace(form_id, place_id)?.writable === true;
}
