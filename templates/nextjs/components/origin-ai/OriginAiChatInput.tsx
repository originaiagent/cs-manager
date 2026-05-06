'use client';

import React, { useState } from 'react';
import { invokeChat, ChatResult, OriginAiError } from '../../lib/origin-ai';

interface OriginAiChatInputProps {
  onSuccess?: (result: ChatResult) => void;
  onError?: (error: OriginAiError) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Pattern A: Chat input.
 * Handles user text input and chat invocation.
 */
export const OriginAiChatInput: React.FC<OriginAiChatInputProps> = ({
  onSuccess,
  onError,
  placeholder = 'Type your message...',
  className = '',
  disabled = false,
}) => {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  const handleSend = async () => {
    if (!message.trim() || isSending || disabled) return;

    setIsSending(true);
    const currentMessage = message;
    setMessage('');

    try {
      const result = await invokeChat(currentMessage);
      onSuccess?.(result);
    } catch (error) {
      // Restore message on error if appropriate, or handle via onError
      setMessage(currentMessage);
      if (error instanceof OriginAiError) {
        onError?.(error);
      } else {
        console.error('Unexpected error in OriginAiChatInput:', error);
      }
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className={`flex gap-2 ${className}`}>
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        placeholder={placeholder}
        disabled={isSending || disabled}
        className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
      />
      <button
        onClick={handleSend}
        disabled={!message.trim() || isSending || disabled}
        className="px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {isSending ? 'Sending...' : 'Send'}
      </button>
    </div>
  );
};
