import { describe, it, expect, vi } from 'vitest';

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock('../src/logger', () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), fatal: vi.fn() },
}));

import { getBuiltinToolNames, runTool } from '../src/agent/tools';
import { catalogTools } from '../src/skills/catalog';
import type { ToolContext } from '../src/types';

vi.mock('../src/mcp/manager', () => ({
  getMcpToolDefinitions: async () => [],
  runMcpTool: async () => null,
}));

vi.mock('../src/config/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/runtime')>();
  return {
    ...actual,
    enabledSkills: async () => ['catalog', 'orders', 'payments', 'handoff'],
  };
});

const ctx: ToolContext = {
  conversationId: 'c1',
  jid: '549111@s.whatsapp.net',
  phone: '549111',
  customerName: 'Test',
  lastImage: null,
};

describe('tool registry', () => {
  it('exposes the agent’s skills', async () => {
    expect(await getBuiltinToolNames()).toEqual(
      expect.arrayContaining([
        'search_catalog',
        'view_product',
        'find_order',
        'confirm_payment',
        'handoff_to_human',
      ]),
    );
  });
});

describe('runTool dispatch', () => {
  it('returns an error for an unknown tool', async () => {
    const out = JSON.parse(await runTool('no_existe', '{}', ctx));
    expect(out).toEqual({ error: 'unknown_tool' });
  });

  it('returns an error for invalid JSON arguments', async () => {
    const out = JSON.parse(await runTool('find_order', '{not json', ctx));
    expect(out).toEqual({ error: 'invalid_tool_arguments' });
    expect(JSON.stringify(out)).not.toContain('{not json');
  });

  it('rejects valid JSON that is not an argument object', async () => {
    expect(JSON.parse(await runTool('find_order', 'null', ctx))).toEqual({
      error: 'invalid_tool_arguments',
    });
    expect(JSON.parse(await runTool('find_order', '["order-1042"]', ctx))).toEqual({
      error: 'invalid_tool_arguments',
    });
  });

  it('returns a stable code and does not leak a handler exception or argument values', async () => {
    const spec = catalogTools.find((candidate) => candidate.definition.function.name === 'search_catalog');
    expect(spec).toBeDefined();
    const spy = vi
      .spyOn(spec!, 'handler')
      .mockRejectedValueOnce(new Error('upstream leaked secret sk-live-123'));
    loggerError.mockReset();
    try {
      const out = JSON.parse(
        await runTool(
          'search_catalog',
          '{"query":"private customer search","in_stock_only":true}',
          ctx,
        ),
      );
      expect(out).toEqual({ error: 'tool_execution_failed' });
      expect(JSON.stringify(out)).not.toContain('sk-live-123');
      expect(JSON.stringify(out)).not.toContain('private customer search');
      expect(loggerError).toHaveBeenCalledWith(
        {
          name: 'search_catalog',
          argKeys: ['in_stock_only', 'query'],
          errorType: 'Error',
        },
        'tool handler threw',
      );
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain('sk-live-123');
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain('private customer search');
    } finally {
      spy.mockRestore();
    }
  });
});
