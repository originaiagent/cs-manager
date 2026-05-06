# UI Resilience Boundary (v7 §2.7 UR-2)

Layered defense for Core data display. Pairs with SDK-side null-safe fallback (UR-1).

## When to use which

| Stack | Server Component crash | Client render crash |
|-------|------------------------|---------------------|
| Next.js App Router | `error.tsx` at page level | `<CoreDataBoundary>` |
| Next.js Pages Router | (n/a) | `<CoreDataBoundary>` |
| Vite SPA / Vanilla React | (n/a) | `<CoreDataBoundary>` |

`error.tsx` and `<CoreDataBoundary>` are **complementary**, not alternatives. React Error Boundary cannot catch async null-access in Server Components — that is what `error.tsx` is for.

## App Router (Next.js)

1. Copy `error-template.tsx` to each page that displays Core data, renaming to `error.tsx`:
   ```
   app/dashboard/products/error.tsx     # ← per-page, NOT at root
   app/dashboard/orders/error.tsx
   ```
2. **Do NOT** place a single `error.tsx` at the root layout. That would lose surrounding navigation when a single subtree crashes — exactly the blast-radius §2.7 forbids.
3. Wrap Client Components that render Core data with `<CoreDataBoundary>`:
   ```tsx
   import { CoreDataBoundary } from '@/components/resilience';

   <CoreDataBoundary sectionLabel="商品マスタ">
     <ProductMasterTable />
   </CoreDataBoundary>
   ```

## Vite SPA / Pages Router

Use `<CoreDataBoundary>` (or the more generic `<ErrorBoundary>`) inline:

```tsx
import { CoreDataBoundary } from '@/components/resilience';

function ProductsPage() {
  return (
    <CoreDataBoundary sectionLabel="商品一覧" resetKeys={[productsQuery.data?.updatedAt]}>
      <ProductTable />
    </CoreDataBoundary>
  );
}
```

`resetKeys` lets the boundary auto-recover when a refetch produces new data.

## Custom fallback

```tsx
<CoreDataBoundary
  fallback={(error, reset) => (
    <YourBrandedFallback message={error.message} onRetry={reset} />
  )}
>
  ...
</CoreDataBoundary>
```

## Why two layers?

Per Gemini Deep Think second-pass review:

> React Error Boundary only catches CSR rendering errors. Server Component async null-access slips through and brings down the whole page.

So:
- **UR-1 (SDK)**: returns typed null/empty fallback, never throws on null access.
- **UR-2 (UI)**: even if UR-1 misses (orphan ref to deleted Core record, unknown SDK field), the boundary localizes the crash so the rest of the page remains usable.

## Test coverage (UR-3)

See `__tests__/resilience/error-boundary.test.tsx` for the two mandatory cases:
1. **Orphan reference** — business UI renders past data that points to a deleted Core record.
2. **Type mismatch** — SDK returns a response with unknown fields.

Both must show the fallback UI without nuking the surrounding page.
