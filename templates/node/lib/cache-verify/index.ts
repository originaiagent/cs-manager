import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CACHE_TAGS = [
  'products',
  'product-groups',
  'product-costs',
  'product-mall-settings',
  'mall-identifiers',
  'malls',
] as const;

export type CacheTag = (typeof CACHE_TAGS)[number];

export interface FixtureRow {
  master: CacheTag;
  id: number | string;
  updated_at: string | null;
  fixture_owner_tool: string;
}

/**
 * Adapter contract.
 *
 * Each tool MUST implement getCachedMasters() so it reads from the same
 * cache layer (Redis / in-memory / Cloudflare cache / etc.) the business UI
 * uses. The nightly CI verifies that updates in Core propagate to this exact
 * cache within 30 seconds.
 *
 * Identification: query Core for rows matching
 *   is_test_fixture = true AND fixture_owner_tool = toolName
 * via the SDK option { includeTestFixture: true, fixtureOwnerTool: toolName }.
 * The legacy slug-prefix scheme is no longer supported — INTEGER id columns
 * make it unportable.
 *
 * If a tool does not have a cache layer, getCachedMasters() must still go
 * through whatever fetch path the business UI uses, so the test catches
 * regressions if a cache layer is added later without proper invalidation.
 */
export interface CacheVerifyAdapter {
  getCachedMasters(opts: { toolName: string }): Promise<FixtureRow[]>;
}

function checkAuth(headerValue: string | string[] | undefined): boolean {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) return false;
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Framework-agnostic handler. Wire it up under GET /_test/cache-verify in
 * your tool's HTTP server (Express/Fastify/Hono/raw http).
 */
export function createCacheVerifyHandler(adapter: CacheVerifyAdapter) {
  return async function cacheVerifyHandler(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (!checkAuth(req.headers['x-internal-api-key'])) {
      console.warn(
        '[cache-verify] auth_failed; returning 404. ' +
          'Triage: verify INTERNAL_API_KEY env var and X-Internal-API-Key header.',
      );
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const toolName = process.env.TOOL_NAME ?? process.env.NEXT_PUBLIC_APP_NAME ?? process.env.ORIGIN_AI_TOOL_NAME;
    if (!toolName) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    try {
      const fixtures = await adapter.getCachedMasters({ toolName });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ tool: toolName, fixtures }));
    } catch (err) {
      console.error('[cache-verify] adapter_error', err);
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream_error' }));
    }
  };
}
