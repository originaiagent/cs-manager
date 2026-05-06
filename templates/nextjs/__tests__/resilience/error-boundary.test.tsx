/**
 * UR-3 verification test cases for the v7 §2.7 UI resilience boundary.
 *
 * Two mandatory scenarios:
 *   1. Orphan reference  — business UI renders past data pointing at a deleted Core record.
 *   2. Type mismatch     — SDK returns a response with an unknown field.
 *
 * Both must localize the crash via <CoreDataBoundary> without nuking the surrounding page.
 *
 * Requires: jest (or vitest with `globals: true`) + @testing-library/react +
 * @testing-library/jest-dom + jsdom. Add to the host tool's devDependencies if missing.
 *
 * For vitest, replace `jest.fn()` with `vi.fn()` when porting this template.
 *
 * This file is a copyable template — it lives in tool-template for distribution.
 */

import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { CoreDataBoundary } from '../../components/resilience';
import { OriginAiServerError } from '../../lib/origin-ai/errors';

// --- Test fixtures simulating Core data ---

interface Product {
  id: string;
  name: string;
  cost: { value: number; currency: string };
}

/**
 * Component that simulates rendering past business data which references a deleted Core record.
 * If `product` is null (deleted from Core), naive rendering crashes on `product.name`.
 */
function ProductLabel({ product }: { product: Product | null }) {
  // Intentionally NOT null-safe: this simulates a tool where UR-1 SDK fallback is missing
  // or where business code accesses Core data fields directly.
  return <span>{(product as Product).name}</span>;
}

/**
 * Component that crashes when SDK returns an unexpected shape (e.g. `cost` missing).
 */
function PriceTag({ product }: { product: Product }) {
  return (
    <span>
      {product.cost.value} {product.cost.currency}
    </span>
  );
}

/**
 * Sibling that should remain rendered even when the boundary fires.
 */
function SurroundingNav() {
  return <nav data-testid="surrounding-nav">Navigation</nav>;
}

// Silence React's componentDidCatch console noise in test output.
let originalError: typeof console.error;
beforeEach(() => {
  originalError = console.error;
  console.error = jest.fn();
});
afterEach(() => {
  console.error = originalError;
});

describe('UR-3: CoreDataBoundary localizes Core data crashes', () => {
  it('orphan reference — deleted Core record does not nuke the surrounding page', () => {
    const orphanedProduct: Product | null = null; // Core record deleted

    render(
      <div>
        <SurroundingNav />
        <CoreDataBoundary sectionLabel="商品名">
          <ProductLabel product={orphanedProduct} />
        </CoreDataBoundary>
      </div>
    );

    // The surrounding nav must remain rendered (blast-radius contained).
    expect(screen.getByTestId('surrounding-nav')).toBeInTheDocument();
    // The boundary fallback must be visible.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Core データの表示に失敗しました/)).toBeInTheDocument();
    // A retry control must exist.
    expect(screen.getByRole('button', { name: /最新化/ })).toBeInTheDocument();
  });

  it('type mismatch — unknown SDK response shape does not nuke surroundings', () => {
    // SDK returns a payload missing `cost` (e.g. backend added a new tier and dropped legacy field).
    const malformed = { id: 'p-1', name: 'Item' } as unknown as Product;

    render(
      <div>
        <SurroundingNav />
        <CoreDataBoundary sectionLabel="価格">
          <PriceTag product={malformed} />
        </CoreDataBoundary>
      </div>
    );

    expect(screen.getByTestId('surrounding-nav')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('OriginAiError vs runtime error — fallback message differentiates', () => {
    const ThrowAiError: React.FC = () => {
      throw new OriginAiServerError('upstream 500', 500, 'trace-abc');
    };

    render(
      <CoreDataBoundary sectionLabel="商品マスタ">
        <ThrowAiError />
      </CoreDataBoundary>
    );

    expect(screen.getByText(/Core データの取得に失敗しました/)).toBeInTheDocument();
    expect(screen.getByText(/Trace ID: trace-abc/)).toBeInTheDocument();
  });

  it('reset button clears the error state and re-renders children', () => {
    let shouldThrow = true;
    const MaybeThrow: React.FC = () => {
      if (shouldThrow) throw new Error('first render fails');
      return <span data-testid="recovered">recovered</span>;
    };

    render(
      <CoreDataBoundary sectionLabel="商品名">
        <MaybeThrow />
      </CoreDataBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /最新化/ }));

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
  });
});
