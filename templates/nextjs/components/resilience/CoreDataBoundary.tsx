'use client';

import React, { ReactNode } from 'react';
import { ErrorBoundary, ErrorBoundaryFallback } from './ErrorBoundary';
import { OriginAiError } from '../../lib/origin-ai';

export interface CoreDataBoundaryProps {
  children: ReactNode;
  /**
   * Optional override of the fallback. If omitted, a Core-data specific fallback is used
   * which differentiates between OriginAiError and unexpected runtime errors (orphan refs,
   * type mismatches from SDK fallback, etc).
   */
  fallback?: ErrorBoundaryFallback;
  onError?: (error: Error) => void;
  /**
   * Identifier used in the fallback UI to help operators spot which Core data section failed.
   */
  sectionLabel?: string;
  resetKeys?: ReadonlyArray<unknown>;
}

const defaultFallback =
  (sectionLabel?: string): ErrorBoundaryFallback =>
  (error, reset) => {
    const isOriginAiError = error instanceof OriginAiError;
    const traceId = isOriginAiError ? error.traceId : undefined;
    const heading = isOriginAiError
      ? 'Core データの取得に失敗しました'
      : 'Core データの表示に失敗しました';
    const detail = isOriginAiError
      ? '一時的な問題の可能性があります。少し待ってから再試行してください。'
      : 'データ形式が想定外でした。最新化ボタンで再取得を試してください。';

    return (
      <div
        role="alert"
        style={{
          padding: 16,
          border: '1px solid #fde68a',
          borderRadius: 8,
          background: '#fffbeb',
          color: '#78350f',
        }}
      >
        <p style={{ fontWeight: 700, marginBottom: 4 }}>
          {heading}
          {sectionLabel ? `（${sectionLabel}）` : ''}
        </p>
        <p style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>{detail}</p>
        <p style={{ fontSize: 12, opacity: 0.6 }}>{error.message}</p>
        {traceId && (
          <p style={{ fontSize: 10, fontFamily: 'monospace', opacity: 0.5, marginTop: 8 }}>
            Trace ID: {traceId}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 12,
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #b45309',
            background: '#fff',
            color: '#92400e',
            cursor: 'pointer',
          }}
        >
          最新化
        </button>
      </div>
    );
  };

/**
 * Resilience boundary specifically for Core data display sections.
 *
 * Layered defense (§2.7 UR-2):
 * - SDK side (UR-1): null safety + typed fallback in fetchers
 * - UI side (UR-2): this boundary localizes any rendering crash that slips past UR-1
 *
 * Use around any subtree that renders origin-core master data (products, users, groups, etc).
 * For Server Components, place an `error.tsx` at the page level instead/in addition to this.
 */
export const CoreDataBoundary: React.FC<CoreDataBoundaryProps> = ({
  children,
  fallback,
  onError,
  sectionLabel,
  resetKeys,
}) => {
  return (
    <ErrorBoundary
      fallback={fallback ?? defaultFallback(sectionLabel)}
      onError={(error) => onError?.(error)}
      resetKeys={resetKeys}
    >
      {children}
    </ErrorBoundary>
  );
};
