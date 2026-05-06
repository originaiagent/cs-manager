# Cache Verify (Node)

Hidden endpoint and verification adapter for the v7 nightly cache-purge CI.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `INTERNAL_API_KEY` | ✅ | Shared secret used by Core and CI to access this endpoint |
| `TOOL_NAME` (or `ORIGIN_AI_TOOL_NAME`) | ✅ | Identifier used in `WHERE is_test_fixture = true AND fixture_owner_tool = TOOL_NAME` |
| `CORE_API_URL` | ✅ (most adapters) | Base URL of origin-core |

## Wiring

```ts
import { createCacheVerifyHandler, type CacheVerifyAdapter } from './lib/cache-verify';

// Tool-specific implementation: read through the SAME cache the business UI uses.
// Use the SDK with { includeTestFixture: true, fixtureOwnerTool: toolName } so
// only this tool's owned fixtures are returned (race-condition safety across
// the 9 nightly runs).
const adapter: CacheVerifyAdapter = {
  async getCachedMasters({ toolName }) {
    return mySharedCachedReader.fetchAllFixtures({
      includeTestFixture: true,
      fixtureOwnerTool: toolName,
    });
  },
};

server.get('/_test/cache-verify', createCacheVerifyHandler(adapter));
```

## Why an adapter, not a fixed implementation

Tools differ: some use Redis, some Cloudflare cache, some in-memory LRU, some
no cache at all. The CI test only catches regressions when the verify endpoint
shares the cache path with the business UI. A canned implementation here would
silently bypass the tool's real cache and return false PASS results.

If you skip the adapter and return data directly from Core, your nightly test
will pass even when the production cache is broken. Don't do that.

## Endpoint behaviour

- `GET /_test/cache-verify` with `X-Internal-API-Key: $INTERNAL_API_KEY`
  → `200 { tool, fixtures: [{ master, id, updated_at, fixture_owner_tool }] x 6 }`
- Any auth failure → `404` (we hide the endpoint from unauthenticated probes).
  Server logs include a triage hint distinguishing real 404 from auth failure.

## Invalidation hook

If your stack supports cache tags (Redis pub/sub, Cloudflare purge, etc.),
expose `POST /api/internal/revalidate` with the same auth and accept
`{ tags: string[] }`. Core calls this after mutating test-fixture rows.

The valid tag set is:

```
products
product-groups
product-costs
product-mall-settings
mall-identifiers
malls
```

Reject unknown tags so Core regressions show up as `rejected` in the response.
