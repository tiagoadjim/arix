import { describe, it, expect } from 'vitest';
import {
  BUILTIN_SKILL_IDS,
  normalizeEnabledSkills,
  toolsForEnabledSkills,
  buildSkillCatalog,
} from '../src/skills/registry';
import {
  isValidMcpServerId,
  namespaceMcpTool,
  parseNamespacedMcpTool,
  normalizeMcpServers,
  mergeMcpServers,
  toMcpServerDto,
} from '../src/mcp/types';

describe('skills registry', () => {
  it('defaults to every built-in skill', () => {
    expect(normalizeEnabledSkills(undefined)).toEqual([...BUILTIN_SKILL_IDS]);
    expect(normalizeEnabledSkills('nope')).toEqual([...BUILTIN_SKILL_IDS]);
  });

  it('keeps an intentional empty list', () => {
    expect(normalizeEnabledSkills([])).toEqual([]);
  });

  it('filters unknown ids and dedupes', () => {
    expect(normalizeEnabledSkills(['catalog', 'catalog', 'nope', 'orders'])).toEqual([
      'catalog',
      'orders',
    ]);
  });

  it('returns only tools for enabled skills', () => {
    const names = toolsForEnabledSkills(['handoff']).map((t) => t.definition.function.name);
    expect(names).toEqual(['handoff_to_human']);
  });

  it('builds a catalog with enable flags', () => {
    const catalog = buildSkillCatalog(['catalog', 'payments']);
    expect(catalog.find((s) => s.id === 'catalog')?.enabled).toBe(true);
    expect(catalog.find((s) => s.id === 'orders')?.enabled).toBe(false);
    expect(catalog.find((s) => s.id === 'payments')?.enabled).toBe(true);
  });
});

describe('mcp types', () => {
  it('validates server ids', () => {
    expect(isValidMcpServerId('github')).toBe(true);
    expect(isValidMcpServerId('my-server_1')).toBe(true);
    expect(isValidMcpServerId('1bad')).toBe(false);
    expect(isValidMcpServerId('Has Caps')).toBe(false);
  });

  it('namespaces and parses tool names', () => {
    const ns = namespaceMcpTool('github', 'list_issues');
    expect(ns).toBe('mcp_github__list_issues');
    expect(parseNamespacedMcpTool(ns)).toEqual({ serverId: 'github', toolName: 'list_issues' });
    const withUnderscore = namespaceMcpTool('my_server', 'do_thing');
    expect(withUnderscore).toBe('mcp_my_server__do_thing');
    expect(parseNamespacedMcpTool(withUnderscore)).toEqual({
      serverId: 'my_server',
      toolName: 'do_thing',
    });
    expect(parseNamespacedMcpTool('search_catalog')).toBeNull();
  });

  it('normalizes a server list and drops invalid entries', () => {
    const servers = normalizeMcpServers([
      { id: 'ok', name: 'OK', transport: 'stdio', command: 'npx', enabled: true },
      { id: '1bad', transport: 'stdio' },
      { id: 'ok', transport: 'http', url: 'https://example.com' }, // duplicate id dropped
      null,
      'nope',
    ]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe('ok');
    expect(servers[0]?.command).toBe('npx');
  });

  it('strips secret values in DTOs', () => {
    const dto = toMcpServerDto({
      id: 's',
      name: 'S',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      env: { TOKEN: 'secret-value' },
      headers: { Authorization: 'Bearer x' },
    });
    expect(dto.envKeys).toEqual(['TOKEN']);
    expect(dto.headerKeys).toEqual(['Authorization']);
    expect(JSON.stringify(dto)).not.toContain('secret-value');
    expect(JSON.stringify(dto)).not.toContain('Bearer');
  });

  it('merges blank env/header values as keep-current', () => {
    const previous = normalizeMcpServers([
      {
        id: 's',
        name: 'S',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        env: { TOKEN: 'keep-me', DROP: 'gone' },
      },
    ]);
    const incoming = normalizeMcpServers([
      {
        id: 's',
        name: 'S',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        env: { TOKEN: '', NEW: 'fresh' },
      },
    ]);
    const merged = mergeMcpServers(incoming, previous);
    expect(merged[0]?.env).toEqual({ TOKEN: 'keep-me', NEW: 'fresh' });
  });
});
