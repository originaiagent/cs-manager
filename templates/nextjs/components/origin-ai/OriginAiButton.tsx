'use client';

import React, { useState } from 'react';
import { invokeWorkflow, WorkflowResult, OriginAiError } from '../../lib/origin-ai';

interface OriginAiButtonProps {
  workflowId: string;
  data: Record<string, unknown>;
  onSuccess?: (result: WorkflowResult) => void;
  onError?: (error: OriginAiError) => void;
  label?: string;
  loadingLabel?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Pattern B: Button/Event invocation.
 * Handles loading state and workflow execution.
 */
export const OriginAiButton: React.FC<OriginAiButtonProps> = ({
  workflowId,
  data,
  onSuccess,
  onError,
  label = 'Run AI Workflow',
  loadingLabel = 'Processing...',
  className = '',
  disabled = false,
}) => {
  const [isLoading, setIsLoading] = useState(false);

  const handleClick = async () => {
    if (isLoading || disabled) return;

    setIsLoading(true);
    try {
      const result = await invokeWorkflow(workflowId, data);
      onSuccess?.(result);
    } catch (error) {
      if (error instanceof OriginAiError) {
        onError?.(error);
      } else {
        // Fallback for unexpected errors
        console.error('Unexpected error in OriginAiButton:', error);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const defaultStyles = 'px-4 py-2 rounded font-medium transition-colors';
  const stateStyles = isLoading || disabled 
    ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
    : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800';

  return (
    <button
      onClick={handleClick}
      disabled={isLoading || disabled}
      className={`${defaultStyles} ${stateStyles} ${className}`}
    >
      {isLoading ? loadingLabel : label}
    </button>
  );
};
