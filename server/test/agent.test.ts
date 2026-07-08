import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock the LLM client and tool dispatch so we can drive the harness loop.
// `providerCaps` lets individual tests flip provider capabilities
// (supportsForcedToolChoice / supportsVision) to exercise the gating logic in
// agent.ts without needing a second mock module.
const { create, runTool, providerCaps } = vi.hoisted(() => ({
  create: vi.fn(),
  runTool: vi.fn(),
  providerCaps: { supportsForcedToolChoice: true, supportsVision: true },
}));

vi.mock('../src/agent/llm/client', () => {
  class LlmRequestError extends Error {
    retryable: boolean;
    constructor(message: string, retryable = true) {
      super(message);
      this.name = 'LlmRequestError';
      this.retryable = retryable;
    }
  }
  const stripThinking = (t?: string | null) =>
    (t ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim();
  return {
    getLlm: async () => ({
      provider: {
        id: 'test-provider',
        label: 'Test Provider',
        supportsVision: () => providerCaps.supportsVision,
        supportsForcedToolChoice: providerCaps.supportsForcedToolChoice,
        prepareBody: (
          body: Record<string, unknown>,
          opts: { reasoningSplit: boolean; thinkingDisabled: boolean },
        ) => {
          if (opts.reasoningSplit) body.reasoning_split = true;
          if (opts.thinkingDisabled) body.thinking = { type: 'disabled' };
        },
        postprocess: stripThinking,
      },
      model: 'test-model',
      chatComplete: create,
      postprocess: stripThinking,
    }),
    LlmRequestError,
  };
});

vi.mock('../src/agent/tools', () => ({ toolDefinitions: [], toolNames: [], runTool }));

import { runAgent } from '../src/agent/agent';
import { LlmRequestError } from '../src/agent/llm/client';
import type { Message, ToolContext } from '../src/types';

const ctx: ToolContext = {
  conversationId: 'c1',
  jid: '549111@s.whatsapp.net',
  phone: '549111',
  customerName: 'Juan',
  lastImage: null,
};

const history = [
  { id: 'm1', direction: 'in', sender: 'customer', body: 'hola, ya pagué la orden 1042', msg_type: 'text' },
] as unknown as Message[];

beforeEach(() => {
  create.mockReset();
  runTool.mockReset();
  providerCaps.supportsForcedToolChoice = true;
  providerCaps.supportsVision = true;
});

describe('runAgent harness', () => {
  it('runs a tool call, then returns the final answer with <think> stripped', async () => {
    create
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '<think>busco la orden</think>',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'find_order', arguments: '{"order_number":"1042"}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '<think>todo ok</think>¡Listo Juan! Tu pago quedó confirmado 🙌',
              tool_calls: [],
            },
          },
        ],
      });
    runTool.mockResolvedValue(JSON.stringify({ encontrada: true, total: '15400' }));

    const reply = await runAgent(ctx, history);

    expect(reply).toBe('¡Listo Juan! Tu pago quedó confirmado 🙌');
    expect(runTool).toHaveBeenCalledWith('find_order', '{"order_number":"1042"}', ctx);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns a direct answer when no tool is called', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hola! ¿En qué te ayudo?', tool_calls: [] } }],
    });

    const reply = await runAgent(ctx, history);
    expect(reply).toBe('Hola! ¿En qué te ayudo?');
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('runAgent input/output guards', () => {
  const sentMessages = () =>
    create.mock.calls[0][0].messages as { role: string; content: string }[];

  it('never sends empty content for a sticker — uses a placeholder', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'jaja 👍', tool_calls: [] } }],
    });
    const stickerHistory = [
      { id: 'm1', direction: 'in', sender: 'customer', body: null, msg_type: 'sticker' },
    ] as unknown as Message[];

    await runAgent(ctx, stickerHistory);

    const userTurn = sentMessages().find((m) => m.role === 'user');
    expect(userTurn?.content).toContain('sticker');
    expect(userTurn?.content).not.toBe('');
  });

  it('uses the audio placeholder for a voice note with no body', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Uy, no escucho audios 🙈', tool_calls: [] } }],
    });
    const audioHistory = [
      { id: 'm1', direction: 'in', sender: 'customer', body: '', msg_type: 'audio' },
    ] as unknown as Message[];

    await runAgent(ctx, audioHistory);

    const userTurn = sentMessages().find((m) => m.role === 'user');
    expect(userTurn?.content).toMatch(/audio/i);
  });

  it('does not send reasoning_split when it is off by default', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '¡Listo!', tool_calls: [] } }],
    });
    await runAgent(ctx, history);
    expect(create.mock.calls[0][0].reasoning_split).toBeUndefined();
  });

  const catalogHistory = [
    { id: 'm1', direction: 'in', sender: 'customer', body: '¿qué tienen en stock?', msg_type: 'text' },
  ] as unknown as Message[];

  it('forces search_catalog when it answers about products without a lookup', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tenemos un montón!', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'search_catalog', arguments: '{}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ahora tenemos Elf Bar 🙌', tool_calls: [] } }],
      });
    runTool.mockResolvedValue(JSON.stringify({ productos: [{ nombre: 'Elf Bar' }] }));

    const reply = await runAgent(ctx, catalogHistory);

    expect(create.mock.calls[1][0].tool_choice).toEqual({
      type: 'function',
      function: { name: 'search_catalog' },
    });
    expect(runTool).toHaveBeenCalledWith('search_catalog', '{}', ctx);
    expect(reply).toContain('Elf Bar');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not force tool_choice when the provider cannot honor a forced function choice — relies on the nudge alone', async () => {
    providerCaps.supportsForcedToolChoice = false;
    create
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tenemos un montón!', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'search_catalog', arguments: '{}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ahora tenemos Elf Bar 🙌', tool_calls: [] } }],
      });
    runTool.mockResolvedValue(JSON.stringify({ productos: [{ nombre: 'Elf Bar' }] }));

    const reply = await runAgent(ctx, catalogHistory);

    expect(create.mock.calls[1][0].tool_choice).toBeUndefined();
    expect(runTool).toHaveBeenCalledWith('search_catalog', '{}', ctx);
    expect(reply).toContain('Elf Bar');
  });

  it('returns the safe fallback when it stays ungrounded after forcing the catalog', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tenemos varios modelos!', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tenemos Ignite a $5000', tool_calls: [] } }],
      });

    const reply = await runAgent(ctx, catalogHistory);

    expect(reply).toMatch(/chequear/);
    expect(runTool).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('retries once then falls back when the reply is not in Spanish (Cyrillic)', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'человек думает дума', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ситуация: клиент', tool_calls: [] } }],
      });

    const reply = await runAgent(ctx, history);
    expect(reply).toMatch(/problemita/); // FALLBACK
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('retries a garbled reply and returns the corrected Spanish answer', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ситуация: клиент', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '¡Hola! ¿Qué andás buscando?', tool_calls: [] } }],
      });

    const reply = await runAgent(ctx, history);
    expect(reply).toBe('¡Hola! ¿Qué andás buscando?');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns the safe fallback (instead of throwing) when the LLM call exhausts retries', async () => {
    create.mockRejectedValueOnce(new LlmRequestError('rate limited', true));

    const reply = await runAgent(ctx, history);

    expect(reply).toMatch(/problemita/); // esGuardrails.fallback
    expect(create).toHaveBeenCalledTimes(1);
  });
});
