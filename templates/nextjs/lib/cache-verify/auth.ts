import { timingSafeEqual } from 'node:crypto';

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: 'missing_key' | 'invalid_key' | 'server_misconfigured' };

/**
 * Verify the X-Internal-API-Key header in constant time.
 * The caller is responsible for translating a failure into a 404 response
 * (we hide the endpoint from unauthenticated probes).
 */
export function verifyInternalApiKey(headerValue: string | null | undefined): AuthResult {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return { ok: false, reason: 'server_misconfigured' };
  }
  if (!headerValue) {
    return { ok: false, reason: 'missing_key' };
  }
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return { ok: false, reason: 'invalid_key' };
  }
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'invalid_key' };
}
