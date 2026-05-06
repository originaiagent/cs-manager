import { invokeChat, invokeWorkflow } from '../../lib/origin-ai/client';
import { OriginAiConfigError, OriginAiServerError, OriginAiTimeoutError } from '../../lib/origin-ai/errors';

// Mock fetch
global.fetch = jest.fn();

describe('Origin-AI Client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.ORIGIN_AI_URL = 'https://api.example.com';
    process.env.ORIGIN_AI_API_KEY = 'test-key';
    (fetch as jest.Mock).mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws ConfigError if env vars are missing', async () => {
    delete process.env.ORIGIN_AI_URL;
    await expect(invokeChat('hello')).rejects.toThrow(OriginAiConfigError);
  });

  it('successfully invokes chat', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: 'AI response' }),
    });

    const result = await invokeChat('hello');
    expect(result.message).toBe('AI response');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat/sync'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
      })
    );
  });

  it('retries once on 500 error', async () => {
    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'Recovered' }),
      });

    const result = await invokeChat('hello');
    expect(result.message).toBe('Recovered');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws ServerError after retry fails', async () => {
    (fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(invokeChat('hello')).rejects.toThrow(OriginAiServerError);
    expect(fetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('throws TimeoutError on AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    (fetch as jest.Mock).mockRejectedValue(abortError);

    await expect(invokeChat('hello')).rejects.toThrow(OriginAiTimeoutError);
  });

  it('successfully invokes workflow', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 'Workflow success' }),
    });

    const result = await invokeWorkflow('test-wf', { key: 'val' });
    expect(result.result).toBe('Workflow success');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/managed-agent/run'),
      expect.objectContaining({
        body: JSON.stringify({ workflow_id: 'test-wf', data: { key: 'val' } }),
      })
    );
  });
});
