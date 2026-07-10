import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listTools, callTool, close, connect, configs } = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  configs: {
    value: [
      {
        id: 'remote',
        name: 'Remote',
        enabled: true,
        transport: 'http' as const,
        url: 'https://8.8.8.8/mcp',
        allowedTools: ['safe_read'],
        allowMutatingTools: false,
      },
    ],
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect,
    listTools,
    callTool,
    close,
  })),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock('../src/config/runtime', () => ({
  mcpServers: async () => configs.value,
}));
vi.mock('../src/mcp/network', () => ({
  assertSafeMcpUrl: async (url: string) => new URL(url),
  secureMcpFetch: vi.fn(),
  closeMcpNetwork: vi.fn().mockResolvedValue(undefined),
}));

import {
  closeMcpPool,
  getMcpToolDefinitions,
  invalidateMcpPool,
  runMcpTool,
} from '../src/mcp/manager';

beforeEach(async () => {
  await closeMcpPool();
  configs.value = [
    {
      id: 'remote',
      name: 'Remote',
      enabled: true,
      transport: 'http',
      url: 'https://8.8.8.8/mcp',
      allowedTools: ['safe_read'],
      allowMutatingTools: false,
    },
  ];
  connect.mockReset().mockResolvedValue(undefined);
  close.mockReset().mockResolvedValue(undefined);
  listTools.mockReset().mockResolvedValue({
    tools: [
      {
        name: 'safe_read',
        description: 'Read data',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
      { name: 'dangerous_delete', description: 'Delete data', inputSchema: { type: 'object' } },
    ],
  });
  callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  invalidateMcpPool();
});

describe('MCP manager policy', () => {
  it('advertises only explicitly allowed tools', async () => {
    const definitions = await getMcpToolDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.function.description).toContain('safe_read');
    expect(definitions[0]?.function.description).not.toContain('Read data');
  });

  it('rejects a discovered but disallowed tool before dispatch', async () => {
    await getMcpToolDefinitions();
    const result = await runMcpTool('mcp_remote__dangerous_delete_fake', '{}');
    expect(JSON.parse(result ?? '{}').error).toMatch(/disallowed/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('dispatches an exact allowed namespaced tool', async () => {
    const definitions = await getMcpToolDefinitions();
    const name = definitions[0]!.function.name;
    await expect(runMcpTool(name, '{"id":1}')).resolves.toBe('ok');
    expect(callTool).toHaveBeenCalledWith(
      { name: 'safe_read', arguments: { id: 1 } },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('blocks allowed tools that are not declared read-only by default', async () => {
    listTools.mockResolvedValue({
      tools: [{ name: 'safe_read', inputSchema: { type: 'object' } }],
    });
    const definitions = await getMcpToolDefinitions();
    expect(definitions).toEqual([]);
  });

  it('stops repeated pagination cursors', async () => {
    listTools
      .mockResolvedValueOnce({ tools: [], nextCursor: 'same' })
      .mockResolvedValueOnce({ tools: [], nextCursor: 'same' });
    const definitions = await getMcpToolDefinitions();
    expect(definitions).toEqual([]);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalled();
  });
});
