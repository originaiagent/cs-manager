'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

export type ErrorBoundaryFallback =
  | ReactNode
  | ((error: Error, reset: () => void) => ReactNode);

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ErrorBoundaryFallback;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKeys?: ReadonlyArray<unknown>;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary] caught error:', error, info);
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && this.didResetKeysChange(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  private didResetKeysChange(
    prev: ReadonlyArray<unknown> | undefined,
    next: ReadonlyArray<unknown> | undefined
  ): boolean {
    if (!prev || !next) return prev !== next;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i++) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(error, this.reset);
      }
      if (fallback !== undefined) {
        return fallback;
      }
      return (
        <div role="alert" style={{ padding: 16, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', color: '#7f1d1d' }}>
          <p style={{ fontWeight: 700, marginBottom: 4 }}>表示中にエラーが発生しました</p>
          <p style={{ fontSize: 13, opacity: 0.8 }}>{error.message || '不明なエラー'}</p>
          <button
            type="button"
            onClick={this.reset}
            style={{ marginTop: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid #b91c1c', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}
          >
            再試行
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
