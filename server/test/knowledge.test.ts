import { vi, describe, it, expect, beforeEach } from 'vitest';
import { normalizeSearchText } from '../src/db/search-text';

const { searchKnowledgeEntries } = vi.hoisted(() => ({ searchKnowledgeEntries: vi.fn() }));

vi.mock('../src/db/repo', () => ({
  searchKnowledgeEntries,
  KNOWLEDGE_SEARCH_LIMIT: 5,
}));

import { knowledgeTools } from '../src/skills/knowledge';
import type { ToolContext } from '../src/types';

const ctx = { conversationId: 'c1', jid: 'j', phone: '1', customerName: 'Ana', lastImage: null } as ToolContext;
const search = knowledgeTools.find((t) => t.definition.function.name === 'search_knowledge')!;

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'k1',
    account_id: 'default',
    question: '¿Hacen envíos?',
    answer: 'Sí, a todo el país.',
    tags: ['envios'],
    source_url: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => searchKnowledgeEntries.mockReset());

describe('normalizeSearchText', () => {
  it('folds accents so "envios" finds "envíos"', () => {
    expect(normalizeSearchText('¿Hacen envíos a Córdoba?')).toBe('¿hacen envios a cordoba?');
    expect(normalizeSearchText('ENVÍOS')).toBe(normalizeSearchText('envios'));
  });

  it('collapses whitespace and skips empty parts', () => {
    expect(normalizeSearchText('Atención  al\n cliente')).toBe('atencion al cliente');
    expect(normalizeSearchText('Envíos', null, undefined, '', 'CABA')).toBe('envios caba');
  });

  it('is stable under repeated application', () => {
    const once = normalizeSearchText('¿Cuánto sale el MANTENIMIENTO?');
    expect(normalizeSearchText(once)).toBe(once);
  });
});

describe('search_knowledge', () => {
  it('rejects an empty query without hitting the database', async () => {
    expect(await search.handler({ query: '   ' }, ctx)).toEqual({ error: 'invalid_query' });
    expect(searchKnowledgeEntries).not.toHaveBeenCalled();
  });

  it('returns an explicit empty result rather than an error when nothing matches', async () => {
    searchKnowledgeEntries.mockResolvedValueOnce([]);

    // The prompt branches on this to say "I don't have that information"
    // instead of inventing an answer — an error code would read to the model
    // as a transient failure worth working around.
    expect(await search.handler({ query: 'algo que no existe' }, ctx)).toEqual({
      found: 0,
      results: [],
    });
  });

  it('returns only the fields the model needs, never internal row data', async () => {
    searchKnowledgeEntries.mockResolvedValueOnce([entry()]);

    const result = (await search.handler({ query: 'envios' }, ctx)) as {
      found: number;
      results: Array<Record<string, unknown>>;
    };

    expect(result.found).toBe(1);
    expect(Object.keys(result.results[0]).sort()).toEqual(['answer', 'question', 'tags']);
    expect(JSON.stringify(result)).not.toContain('account_id');
    expect(JSON.stringify(result)).not.toContain('created_by');
  });

  it('caps a single oversized answer so one row cannot crowd out the turn', async () => {
    searchKnowledgeEntries.mockResolvedValueOnce([entry({ answer: 'x'.repeat(5_000) })]);

    const result = (await search.handler({ query: 'largo' }, ctx)) as {
      results: Array<{ answer: string }>;
    };

    expect(result.results[0].answer.length).toBeLessThanOrEqual(1_201);
    expect(result.results[0].answer.endsWith('…')).toBe(true);
  });

  it('honors the turn abort signal instead of returning stale work', async () => {
    const controller = new AbortController();
    const reason = new Error('turn budget exhausted');
    searchKnowledgeEntries.mockImplementationOnce(async () => {
      controller.abort(reason);
      return [entry()];
    });

    await expect(
      search.handler({ query: 'envios' }, { ...ctx, signal: controller.signal } as ToolContext),
    ).rejects.toBe(reason);
  });
});
