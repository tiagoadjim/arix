import { describe, it, expect, vi } from 'vitest';
import { getBuiltinToolNames, runTool } from '../src/agent/tools';
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
    expect(out.error).toMatch(/unknown tool/);
  });

  it('returns an error for invalid JSON arguments', async () => {
    const out = JSON.parse(await runTool('find_order', '{not json', ctx));
    expect(out.error).toMatch(/JSON/);
  });
});
