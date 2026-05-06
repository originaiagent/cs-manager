import { unstable_cache } from 'next/cache';

export const CACHE_TAGS = [
  'products',
  'product-groups',
  'product-costs',
  'product-mall-settings',
  'mall-identifiers',
  'malls',
] as const;

export type CacheTag = (typeof CACHE_TAGS)[number];

/**
 * Core master rows are identified by the new v7 schema columns
 * `is_test_fixture BOOLEAN` and `fixture_owner_tool TEXT`. The CI flow asserts
 * that updated_at on every owned fixture moves forward after Core mutates them.
 */
export interface FixtureRow {
  master: CacheTag;
  id: number | string;
  updated_at: string | null;
  fixture_owner_tool: string;
}

interface FetchOptions {
  coreApiUrl: string;
  internalApiKey: string;
  signal?: AbortSignal;
}

/**
 * Resolve TOOL_NAME at module load. A single deployment serves one tool, so
 * this is stable for the process lifetime. TOOL_NAME is canonical; the other
 * two are kept as fallbacks for tools that historically set NEXT_PUBLIC_APP_NAME
 * or ORIGIN_AI_TOOL_NAME and have not migrated yet.
 */
export function resolveToolName(): string {
  return (
    process.env.TOOL_NAME ??
    process.env.NEXT_PUBLIC_APP_NAME ??
    process.env.ORIGIN_AI_TOOL_NAME ??
    'unknown'
  );
}

const TOOL_NAME = resolveToolName();

function buildFetcher(master: CacheTag) {
  return unstable_cache(
    async (opts: FetchOptions): Promise<FixtureRow> => {
      const url =
        `${opts.coreApiUrl.replace(/\/$/, '')}/api/internal/test-fixture/${master}` +
        `?owner=${encodeURIComponent(TOOL_NAME)}`;
      const res = await fetch(url, {
        headers: {
          'X-Internal-API-Key': opts.internalApiKey,
          'X-Tool-Name': TOOL_NAME,
        },
        signal: opts.signal,
      });
      if (!res.ok) {
        throw new Error(`Core fetch failed for ${master}: HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        id: number | string;
        updated_at: string | null;
        fixture_owner_tool: string;
      };
      return {
        master,
        id: body.id,
        updated_at: body.updated_at,
        fixture_owner_tool: body.fixture_owner_tool,
      };
    },
    // Tool name in keyParts isolates caches if the same Next.js process is ever
    // reused for multiple tools (rare, but cheap insurance against pollution).
    ['cache-verify', TOOL_NAME, master],
    { tags: [master] },
  );
}

const fetchers: Record<CacheTag, ReturnType<typeof buildFetcher>> = {
  products: buildFetcher('products'),
  'product-groups': buildFetcher('product-groups'),
  'product-costs': buildFetcher('product-costs'),
  'product-mall-settings': buildFetcher('product-mall-settings'),
  'mall-identifiers': buildFetcher('mall-identifiers'),
  malls: buildFetcher('malls'),
};

export async function fetchAllFixtures(
  opts: FetchOptions & { toolName?: string },
): Promise<FixtureRow[]> {
  // The toolName arg is accepted for API symmetry with the Node/Python adapters
  // but the Next.js fetcher is keyed by the module-level TOOL_NAME (request
  // arg cannot override the cache key, so we surface a mismatch loudly).
  if (opts.toolName && opts.toolName !== TOOL_NAME) {
    throw new Error(
      `cache-verify TOOL_NAME mismatch: env=${TOOL_NAME} request=${opts.toolName}`,
    );
  }
  return Promise.all(CACHE_TAGS.map((tag) => fetchers[tag](opts)));
}
