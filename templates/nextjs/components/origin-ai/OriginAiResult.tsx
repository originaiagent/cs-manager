import React from 'react';
import { OriginAiError } from '../../lib/origin-ai';

interface OriginAiResultProps {
  result?: string | { message: string } | null;
  error?: OriginAiError | null;
  className?: string;
}

/**
 * Common display component for origin-ai results and errors.
 */
export const OriginAiResult: React.FC<OriginAiResultProps> = ({
  result,
  error,
  className = '',
}) => {
  if (error) {
    let message = 'An unexpected error occurred.';
    let subMessage = error.message;

    switch (error.code) {
      case 'CONFIG_ERROR':
        message = 'System configuration error.';
        subMessage = 'Please contact your administrator.';
        break;
      case 'AUTH_ERROR':
        message = 'Authentication failed.';
        subMessage = 'API key might be invalid.';
        break;
      case 'TIMEOUT_ERROR':
        message = 'Request timed out.';
        subMessage = 'The operation took too long. Please try again.';
        break;
      case 'NETWORK_ERROR':
        message = 'Connection error.';
        subMessage = 'Check your internet connection.';
        break;
      case 'SERVER_ERROR':
        message = 'Origin-AI server error.';
        subMessage = 'Something went wrong on the server. We have been notified.';
        break;
    }

    return (
      <div className={`p-4 rounded border border-red-200 bg-red-50 text-red-800 ${className}`}>
        <p className="font-bold">{message}</p>
        <p className="text-sm opacity-80">{subMessage}</p>
        {error.traceId && (
          <p className="text-[10px] mt-2 opacity-50 font-mono">Trace ID: {error.traceId}</p>
        )}
      </div>
    );
  }

  if (!result) return null;

  const displayResult = typeof result === 'string' ? result : (result as any).message;

  return (
    <div className={`p-4 rounded border border-green-200 bg-green-50 text-green-900 ${className}`}>
      <div className="whitespace-pre-wrap">{displayResult}</div>
    </div>
  );
};
