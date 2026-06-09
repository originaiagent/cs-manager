/**
 * canonical JSON + payloadHash — origin-ai と **ビット一致** する正準化
 *
 * 正本: minpaku-tool/src/mcp/canonical.ts (codex 9R PASS)。本ファイルは **ビット一致**。
 *
 * embed 書き込み可逆性レイヤー (v4) の payload_hash は origin 側 (intent / validate /
 * audit) と一致しなければならない。両者が同一アルゴリズムで canonicalize → sha256 する
 * ことで、ツール側で計算した payload_hash を origin が照合できる (write_id 束縛の要)。
 *
 * 規則 (origin と同一):
 *   - スカラ (null / number / string / boolean) は JSON.stringify そのまま
 *   - 配列は要素順を保持し、各要素を再帰 canonicalize
 *   - オブジェクトはキーを **コードポイント昇順** (Array.prototype.sort 既定) で並べ、
 *     キーは JSON.stringify、値は再帰 canonicalize
 *   - undefined は JSON.stringify が undefined を返すため "null" にフォールバック
 *
 * golden vectors (contract.test.ts §canonical) で origin と同一の sha256 を保証する。
 */

import { createHash } from 'node:crypto';

export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    // JSON.stringify(undefined) === undefined → "null" にフォールバック
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) {
    return `[${v.map(canonicalize).join(',')}]`;
  }
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(',')}}`;
}

export function payloadHash(v: unknown): string {
  return createHash('sha256').update(canonicalize(v), 'utf8').digest('hex');
}
