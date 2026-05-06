'use client';

/**
 * Next.js App Router page-level error.tsx template (v7 §2.7 UR-2).
 *
 * Copy this file into a page directory (e.g. app/dashboard/products/error.tsx) so that
 * Server Component crashes for that route are caught locally without nuking the whole app.
 *
 * IMPORTANT:
 * - Place at INDIVIDUAL page level. Do NOT place a single error.tsx at the root layout.
 *   Root-level boundaries lose surrounding navigation and produce the exact whitescreen
 *   blast-radius we are trying to avoid.
 * - Server Component async null-access errors slip past Client ErrorBoundary; this file is
 *   the Server-side counterpart to the client-side `<CoreDataBoundary>` defense.
 */
export default function PageErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: 32, maxWidth: 560, margin: '0 auto', fontFamily: "'Noto Sans JP', sans-serif" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        ページの表示中にエラーが発生しました
      </h2>
      <p style={{ fontSize: 14, color: '#4b5563', marginBottom: 16 }}>
        {error.message || '予期しないエラーが発生しました。'}
      </p>
      {error.digest && (
        <p style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af', marginBottom: 16 }}>
          digest: {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        style={{
          padding: '8px 20px',
          borderRadius: 8,
          border: 'none',
          background: '#2d6a4f',
          color: '#fff',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        再試行
      </button>
    </div>
  );
}
