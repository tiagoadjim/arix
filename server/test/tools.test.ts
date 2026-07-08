import { describe, it, expect } from 'vitest';
import { toolNames, runTool } from '../src/agent/tools';
import type { ToolContext } from '../src/types';

const ctx: ToolContext = {
  conversationId: 'c1',
  jid: '549111@s.whatsapp.net',
  phone: '549111',
  customerName: 'Test',
  lastImage: null,
};

describe('tool registry', () => {
  it('exposes the agent’s skills', () => {
    expect(toolNames).toEqual(
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
    expect(out.error).toMatch(/desconocida/);
  });

  it('returns an error for invalid JSON arguments', async () => {
    const out = JSON.parse(await runTool('find_order', '{not json', ctx));
    expect(out.error).toMatch(/JSON/);
  });
});
