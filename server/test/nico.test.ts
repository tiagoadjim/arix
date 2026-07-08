import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock the LLM client and tool dispatch so we can drive the harness loop.
const { create, runTool } = vi.hoisted(() => ({ create: vi.fn(), runTool: vi.fn() }));

vi.mock('../src/agent/minimax', () => ({
  minimax: { chat: { completions: { create } } },
  MODEL: 'test-model',
  stripThinking: (t?: string | null) =>
    (t ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim(),
}));

vi.mock('../src/agent/tools', () => ({ toolDefinitions: [], toolNames: [], runTool }));

import { runNico } from '../src/agent/nico';
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
});

describe('runNico harness', () => {
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
                { id: 'call_1', type: 'function', function: { name: 'buscar_orden', arguments: '{"numero_orden":"1042"}' } },
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

    const reply = await runNico(ctx, history);

    expect(reply).toBe('¡Listo Juan! Tu pago quedó confirmado 🙌');
    expect(runTool).toHaveBeenCalledWith('buscar_orden', '{"numero_orden":"1042"}', ctx);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns a direct answer when no tool is called', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hola! ¿En qué te ayudo?', tool_calls: [] } }],
    });

    const reply = await runNico(ctx, history);
    expect(reply).toBe('Hola! ¿En qué te ayudo?');
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('runNico input/output guards', () => {
  const sentMessages = () =>
    create.mock.calls[0][0].messages as { role: string; content: string }[];

  it('never sends empty content for a sticker — uses a placeholder', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'jaja 👍', tool_calls: [] } }],
    });
    const stickerHistory = [
      { id: 'm1', direction: 'in', sender: 'customer', body: null, msg_type: 'sticker' },
    ] as unknown as Message[];

    await runNico(ctx, stickerHistory);

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

    await runNico(ctx, audioHistory);

    const userTurn = sentMessages().find((m) => m.role === 'user');
    expect(userTurn?.content).toMatch(/audio/i);
  });

  it('does not send reasoning_split when it is off by default', async () => {
    create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '¡Listo!', tool_calls: [] } }],
    });
    await runNico(ctx, history);
    expect(create.mock.calls[0][0].reasoning_split).toBeUndefined();
  });

  const catalogHistory = [
    { id: 'm1', direction: 'in', sender: 'customer', body: '¿qué tienen en stock?', msg_type: 'text' },
  ] as unknown as Message[];

  it('forces buscar_catalogo when it answers about products without a lookup', async () => {
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
                { id: 'call_1', type: 'function', function: { name: 'buscar_catalogo', arguments: '{}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ahora tenemos Elf Bar 🙌', tool_calls: [] } }],
      });
    runTool.mockResolvedValue(JSON.stringify({ productos: [{ nombre: 'Elf Bar' }] }));

    const reply = await runNico(ctx, catalogHistory);

    expect(create.mock.calls[1][0].tool_choice).toEqual({
      type: 'function',
      function: { name: 'buscar_catalogo' },
    });
    expect(runTool).toHaveBeenCalledWith('buscar_catalogo', '{}', ctx);
    expect(reply).toContain('Elf Bar');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('returns the safe fallback when it stays ungrounded after forcing the catalog', async () => {
    create
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tenemos varios modelos!', tool_calls: [] } }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tenemos Ignite a $5000', tool_calls: [] } }],
      });

    const reply = await runNico(ctx, catalogHistory);

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

    const reply = await runNico(ctx, history);
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

    const reply = await runNico(ctx, history);
    expect(reply).toBe('¡Hola! ¿Qué andás buscando?');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
