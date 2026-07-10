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
  normalizeMcpServers,
  mergeMcpServers,
  toMcpServerDto,
  validateMcpServersInput,
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

  it('namespaces tool names without collisions and stays under 64 chars', () => {
    const ns = namespaceMcpTool('github', 'list_issues');
    expect(ns).toMatch(/^mcp_github__list_issues_[a-f0-9]{10}$/);
    expect(ns.length).toBeLessThanOrEqual(64);
    expect(namespaceMcpTool('github', 'a.b')).not.toBe(namespaceMcpTool('github', 'a/b'));
    expect(namespaceMcpTool('a'.repeat(32), 'x'.repeat(128)).length).toBeLessThanOrEqual(64);
  });

  it('accepts HTTP and drops stdio/invalid entries at runtime', () => {
    const servers = normalizeMcpServers([
      { id: 'ok', name: 'OK', transport: 'stdio', command: 'npx', enabled: true },
      { id: '1bad', transport: 'stdio' },
      {
        id: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        allowedTools: ['search'],
      },
      null,
      'nope',
    ]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe('remote');
    expect(servers[0]?.allowedTools).toEqual(['search']);
  });

  it('strict validation rejects stdio and duplicate ids', () => {
    const result = validateMcpServersInput([
      { id: 'same', transport: 'stdio', command: 'npx' },
      { id: 'same', transport: 'http', url: 'https://example.com/mcp' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('strips secret values in DTOs', () => {
    const dto = toMcpServerDto({
      id: 's',
      name: 'S',
      enabled: true,
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      allowedTools: ['search'],
      allowMutatingTools: false,
    });
    expect(dto.headerKeys).toEqual(['Authorization']);
    expect(JSON.stringify(dto)).not.toContain('Bearer');
  });

  it('merges blank header values as keep-current', () => {
    const previous = normalizeMcpServers([
      {
        id: 's',
        name: 'S',
        enabled: true,
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer keep-me', 'X-Drop': 'gone' },
        allowedTools: ['search'],
      },
    ]);
    const incoming = normalizeMcpServers([
      {
        id: 's',
        name: 'S',
        enabled: true,
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: '', 'X-New': 'fresh' },
        allowedTools: ['search'],
      },
    ]);
    const merged = mergeMcpServers(incoming, previous);
    expect(merged[0]?.headers).toEqual({ Authorization: 'Bearer keep-me', 'X-New': 'fresh' });
  });
});
