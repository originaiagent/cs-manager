# Cache Purge Verification (v7 R-4/W-4 Test A)

> Status: distributed by `dispatch-sync.yml`. Edit only in tool-template; tool repos overwrite on each sync (CI workflow + verify script) or accept the initial copy and adapt (stack-specific hidden pages).

## What this guarantees

Every night, for each of the 9 participating tools, CI mechanically proves:

1. The tool's `/_test/cache-verify` endpoint returns a fresh value for every test-fixture row within 30 seconds of Core mutating those rows.
2. The cache layer used by the verify endpoint is the same one the business UI uses (because the adapter contract requires it).

## Identification scheme (v7 §2.8)

Test fixtures are identified by **two new columns** added to every Core master table, not by a slug prefix:

```
is_test_fixture     BOOLEAN NOT NULL DEFAULT FALSE
fixture_owner_tool  TEXT NULL
```

A partial index `WHERE is_test_fixture = false` keeps production query performance unchanged. Most master `id` columns are INTEGER, so the legacy `id LIKE 'test-fixture-%'` scheme is impossible — the column-based scheme replaces it.

The schema migration, the SDK option `{ includeTestFixture: true, fixtureOwnerTool: toolName }`, and the seed of 54 fixtures (9 tools × 6 masters) live in **task 3/6** in the origin-core monorepo. **PRs must merge in the order: 3/6 → this 1/6.** Until 3/6 lands, dev/local can mock the columns.

If the test fails, either the tool's cache is not being purged or the wiring between Core and the tool is broken — both are real production bugs the v6 setup could not detect.

## Participating tools (9)

```
ec-manager
origintree-logi
lp-generator
origin-ai
product-dev-tool
ys-staff-tool
factory-management
testpilot
origintree-soumu-portal
```

`origin-core` is the source of truth (separate flow). Tools not listed do not get the workflow.

## Files distributed

| File | Source | Distribution |
|---|---|---|
| `.github/workflows/cache-purge-nightly.yml` | `tool-template/.github/workflows/templates/cache-purge-nightly.yml.tmpl` | Always overwrite |
| `scripts/cache-purge-verify.mjs` | `tool-template/scripts/cache-purge-verify.mjs` | Always overwrite |
| `app/_test/cache-verify/route.ts` (Next.js) | `tool-template/templates/nextjs/...` | Initial copy only |
| `app/api/internal/revalidate/route.ts` (Next.js) | `tool-template/templates/nextjs/...` | Initial copy only |
| `lib/cache-verify/{auth,masters,index}.ts` (Next.js) | `tool-template/templates/nextjs/lib/cache-verify/` | Initial copy only |
| `lib/cache-verify/{index.ts,README.md}` (Node) | `tool-template/templates/node/...` | Initial copy only |
| `origin_ai/cache_verify.py` (Python) | `tool-template/templates/python/...` | Initial copy only |

Stack detection in `dispatch-sync.yml`: `app/` → Next.js, `origin_ai/` → Python, otherwise → Node.

## Required env vars per tool repo

Set in GitHub Actions vars / secrets and in the deploy environment.

| Name | Type | Description |
|---|---|---|
| `TOOL_NAME` | Actions var | e.g. `ec-manager`. Used as the `fixture_owner_tool` filter. **Canonical name** — set this on the deployed tool too. `NEXT_PUBLIC_APP_NAME` and `ORIGIN_AI_TOOL_NAME` are accepted as legacy fallbacks. |
| `TOOL_URL` | Actions var | Public origin of the deployed tool, e.g. `https://ec-manager.example.com` |
| `CORE_API_URL` | Actions var | `https://origin-core.example.com` |
| `INTERNAL_API_KEY` | Actions secret | Same value Core uses to call the tool and the tool uses to call Core |

The same `INTERNAL_API_KEY` must also be set on the **deployed tool**, otherwise `/_test/cache-verify` returns 404 to CI.

## Cache tag contract

Six tags, shared by business UI and verify endpoint:

```
products
product-groups
product-costs
product-mall-settings
mall-identifiers
malls
```

When Core mutates a master, it POSTs `{tags: [...]}` to `${TOOL_URL}/api/internal/revalidate`. The tool calls `revalidateTag(tag)` (Next.js) or its stack equivalent. Both the business UI cache and the verify endpoint cache must invalidate from the same call — that's why the verify endpoint reads through the same cache path, not a bespoke uncached path.

## CI flow

```
GET /_test/cache-verify        → val_old (6 masters, owned by THIS tool only)
PATCH Core /api/internal/test-fixture/touch  { tool: TOOL_NAME }
  → Core: UPDATE ... SET updated_at = now()
          WHERE is_test_fixture = true AND fixture_owner_tool = TOOL_NAME
  → Core: POST tool /api/internal/revalidate {tags: [...]}
poll /_test/cache-verify every 2s up to 30s → assert all 6 updated_at > val_old
```

The verify endpoint must reject any row where `fixture_owner_tool != TOOL_NAME` — the script aborts with FAIL if it sees one. This is the race-condition guard that lets all 9 tools run nightly at the same UTC minute without stepping on each other.

Cron: `0 18 * * *` UTC (= 03:00 JST) plus up to 60s jitter so the 9 tools don't stampede Core.

## Triage when nightly fails

The verify script prints structured JSON. Common causes:

- **`status:FAIL ... 404 ... "Endpoint not found or Auth failed"`** — endpoint missing or `INTERNAL_API_KEY` mismatch. Confirm deploy and compare values across Core / tool / CI.
- **`status:FAIL ... stale: [...]`** — endpoint reachable but cache not purging. Check the tool's `/api/internal/revalidate` handler logs and confirm the tool subscribes to all six tags.
- **`Core touch endpoint returned 5xx`** — Core-side bug, escalate to origin-core repo.

A failure on `schedule` events automatically opens a `cache-purge-fail`-labeled issue in the affected tool's repo.

## Out of scope (handled by sister tasks)

- Task 2/6: business UI must filter `WHERE is_test_fixture = false` (or rely on the SDK default which does the same) so the 54 fixtures never reach end users.
- Task 3/6: ALTER TABLE migration adding `is_test_fixture` + `fixture_owner_tool` to all Core masters, SDK fail-safe + the seed of 54 fixtures, and the `/api/internal/test-fixture/touch` endpoint plus the outbound revalidate webhook caller — all in one origin-core PR.

## Adapter responsibility (do not skip)

For non-Next.js tools, `lib/cache-verify` ships only an interface plus a no-op handler. **Tools must wire `getCachedMasters` to the same cache reader the business UI uses.** A naive direct-from-Core implementation will pass the test even when the production cache is broken — that defeats the whole point. The Node README and the Python `register_adapter` docstring spell this out.
