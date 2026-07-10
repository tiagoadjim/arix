import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the `openai` SDK constructor + the `create` call so no real network
// call ever happens; `OpenAIMock` lets us assert on constructor args (e.g.
// which baseURL/apiKey was used).
const { create, OpenAIMock } = vi.hoisted(() => {
  const create = vi.fn();
  const OpenAIMock = vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    __opts: opts,
    chat: { completions: { create } },
  }));
  return { create, OpenAIMock };
});

vi.mock('openai', () => ({ default: OpenAIMock }));

const { loggerInfo } = vi.hoisted(() => ({ loggerInfo: vi.fn() }));
vi.mock('../src/logger', () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

// Mutable fake runtime settings — reset in beforeEach. `version` is bumped
// every test so getLlm()'s internal settingsVersion()-keyed cache always
// rebuilds a fresh handle/client instead of reusing one from a prior test.
const llmSettings = vi.hoisted(() => ({
  provider: 'minimax' as string,
  apiKey: 'test-key',
  model: '',
  baseUrl: '',
  reasoningSplit: false,
  thinkingDisabled: false,
  visionFallback: 'ask_details' as 'ask_details' | 'handoff',
  configured: true,
}));
let version = 0;
vi.mock('../src/config/runtime', () => ({
  llm: async () => llmSettings,
  settingsVersion: () => version,
}));

import { getLlm, LlmRequestError } from '../src/agent/llm/client';

function okResponse(content = 'ok') {
  return { choices: [{ message: { role: 'assistant', content, tool_calls: [] } }] };
}

beforeEach(() => {
  create.mockReset();
  OpenAIMock.mockClear();
  loggerInfo.mockClear();
  version += 1; // force a fresh handle every test
  llmSettings.provider = 'minimax';
  llmSettings.apiKey = 'test-key';
  llmSettings.model = '';
  llmSettings.baseUrl = '';
  llmSettings.reasoningSplit = false;
  llmSettings.thinkingDisabled = false;
  llmSettings.visionFallback = 'ask_details';
  llmSettings.configured = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getLlm()', () => {
  it('returns a handle exposing provider/model/chatComplete/postprocess', async () => {
    const handle = await getLlm();
    expect(handle.provider.id).toBe('minimax');
    expect(handle.model).toBe('MiniMax-M3'); // provider default, llm.model was ''
    expect(typeof handle.chatComplete).toBe('function');
    expect(typeof handle.postprocess).toBe('function');
  });

  it('constructs the OpenAI client with the provider default baseURL when settings.baseUrl is unset', async () => {
    await getLlm();
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.minimax.io/v1', apiKey: 'test-key' }),
    );
  });

  it('a settings.baseUrl override wins over the provider registry baseURL', async () => {
    llmSettings.baseUrl = 'https://custom.example.com/v1';
    await getLlm();
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://custom.example.com/v1' }),
    );
  });

  it('constructs the OpenAI client with a bounded timeout (SDK default of 600s is unacceptable)', async () => {
    await getLlm();
    expect(OpenAIMock).toHaveBeenCalledWith(expect.objectContaining({ timeout: 60_000 }));
  });
});

describe('chatComplete() retry behavior', () => {
  it('propagates abort to the active SDK request and never retries it', async () => {
    const controller = new AbortController();
    const budgetError = new Error('turn budget exhausted');
    create.mockImplementationOnce(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    const handle = await getLlm();
    const pending = handle.chatComplete(
      { model: 'x', messages: [] } as never,
      { signal: controller.signal },
    );
    controller.abort(budgetError);

    await expect(pending).rejects.toBe(budgetError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('retries once on a 429 and succeeds on the 2nd attempt', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    create.mockRejectedValueOnce(rateLimited).mockResolvedValueOnce(okResponse());

    vi.useFakeTimers();
    const handle = await getLlm();
    const promise = handle.chatComplete({ model: 'x', messages: [] } as never);
    await vi.advanceTimersByTimeAsync(500);
    const resp = await promise;

    expect(create).toHaveBeenCalledTimes(2);
    expect(resp.choices[0]?.message.content).toBe('ok');
  });

  it('retries on a 5xx and succeeds', async () => {
    const serverErr = Object.assign(new Error('bad gateway'), { status: 502 });
    create.mockRejectedValueOnce(serverErr).mockResolvedValueOnce(okResponse());

    vi.useFakeTimers();
    const handle = await getLlm();
    const promise = handle.chatComplete({ model: 'x', messages: [] } as never);
    await vi.advanceTimersByTimeAsync(500);
    const resp = await promise;

    expect(create).toHaveBeenCalledTimes(2);
    expect(resp.choices[0]?.message.content).toBe('ok');
  });

  it('retries on a network error with no HTTP status (e.g. ECONNRESET)', async () => {
    const networkErr = new Error('ECONNRESET');
    create.mockRejectedValueOnce(networkErr).mockResolvedValueOnce(okResponse());

    vi.useFakeTimers();
    const handle = await getLlm();
    const promise = handle.chatComplete({ model: 'x', messages: [] } as never);
    await vi.advanceTimersByTimeAsync(500);
    const resp = await promise;

    expect(create).toHaveBeenCalledTimes(2);
    expect(resp.choices[0]?.message.content).toBe('ok');
  });

  it('gives up after the 3rd attempt and throws a retryable LlmRequestError', async () => {
    const serverErr = Object.assign(new Error('still down'), { status: 503 });
    create.mockRejectedValue(serverErr);

    vi.useFakeTimers();
    const handle = await getLlm();
    const promise = handle.chatComplete({ model: 'x', messages: [] } as never);
    promise.catch(() => {}); // avoid an unhandled-rejection warning while timers advance
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).rejects.toBeInstanceOf(LlmRequestError);
    await expect(promise).rejects.toMatchObject({ retryable: true, status: 503 });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-retryable 4xx (401) — throws immediately after 1 call', async () => {
    const authErr = Object.assign(new Error('unauthorized'), { status: 401 });
    create.mockRejectedValueOnce(authErr);

    const handle = await getLlm();
    await expect(handle.chatComplete({ model: 'x', messages: [] } as never)).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('usage logging', () => {
  it('logs "llm usage" with token fields when the response has usage', async () => {
    create.mockResolvedValueOnce({
      ...okResponse(),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const handle = await getLlm();
    await handle.chatComplete({ model: 'x', messages: [] } as never);

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'minimax',
        model: 'MiniMax-M3',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
      'llm usage',
    );
  });

  it('does not log usage when the response has none', async () => {
    create.mockResolvedValueOnce(okResponse());
    const handle = await getLlm();
    await handle.chatComplete({ model: 'x', messages: [] } as never);
    expect(loggerInfo).not.toHaveBeenCalled();
  });
});
