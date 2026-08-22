import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

// Mock at the repo boundary, same style as setup-api.test.ts, so no real
// Postgres connection is attempted.
const {
  listKnowledgeEntries,
  countKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  getStaffById,
  getSettings,
  insertAuditEvent,
} = vi.hoisted(() => ({
  listKnowledgeEntries: vi.fn(),
  countKnowledgeEntries: vi.fn(),
  createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn(),
  deleteKnowledgeEntry: vi.fn(),
  getStaffById: vi.fn(),
  getSettings: vi.fn(),
  insertAuditEvent: vi.fn(),
}));

vi.mock('../src/db/repo', () => ({
  listKnowledgeEntries,
  countKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  getStaffById,
  getSettings,
  insertAuditEvent,
}));

import { createApiServer } from '../src/api/server';
import { signSession, SESSION_COOKIE } from '../src/api/auth';
import { invalidate } from '../src/config/runtime';
import type { WhatsAppGateway } from '../src/whatsapp/socket';

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@example.com',
  password_hash: 'x',
  name: 'Admin',
  role: 'admin' as const,
  session_version: 0,
};
const AGENT = { ...ADMIN, id: '22222222-2222-4222-8222-222222222222', role: 'agent' as const };
const ENTRY_ID = '33333333-3333-4333-8333-333333333333';

async function cookie(staff = ADMIN): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(staff)}`;
}

function app() {
  return createApiServer({
    gateway: {
      connected: false,
      latestQR: null,
      sendText: vi.fn(),
      indicateTyping: vi.fn(),
      restart: vi.fn(),
    } as unknown as WhatsAppGateway,
  });
}

/** A full row as the repo returns it — including `search_text`, the derived
 * column the DTO must never expose. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    account_id: 'default',
    question: '¿Hacen envíos?',
    answer: 'Sí, a todo el país.',
    tags: ['envios'],
    source_url: null,
    created_by: ADMIN.id,
    search_text: 'hacen envios si a todo el pais envios',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  listKnowledgeEntries.mockReset().mockResolvedValue([row()]);
  countKnowledgeEntries.mockReset().mockResolvedValue(1);
  createKnowledgeEntry.mockReset().mockImplementation(async () => row());
  updateKnowledgeEntry.mockReset().mockResolvedValue(row());
  deleteKnowledgeEntry.mockReset().mockResolvedValue(true);
  getStaffById.mockReset().mockImplementation(async (id: string) => (id === AGENT.id ? AGENT : ADMIN));
  getSettings.mockReset().mockResolvedValue({});
  insertAuditEvent.mockReset().mockResolvedValue(undefined);
  invalidate();
});

describe('knowledge API authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    await request(app()).get('/api/knowledge').expect(401);
  });

  it('rejects a non-admin staff member on every verb', async () => {
    const c = await cookie(AGENT);
    await request(app()).get('/api/knowledge').set('Cookie', c).expect(403);
    await request(app()).post('/api/knowledge').set('Cookie', c).send({ question: 'q', answer: 'a' }).expect(403);
    await request(app()).put(`/api/knowledge/${ENTRY_ID}`).set('Cookie', c).send({ question: 'q', answer: 'a' }).expect(403);
    await request(app()).delete(`/api/knowledge/${ENTRY_ID}`).set('Cookie', c).expect(403);
    expect(createKnowledgeEntry).not.toHaveBeenCalled();
    expect(deleteKnowledgeEntry).not.toHaveBeenCalled();
  });
});

describe('GET /api/knowledge', () => {
  it('never exposes search_text, account_id or created_by', async () => {
    const res = await request(app()).get('/api/knowledge').set('Cookie', await cookie()).expect(200);

    expect(Object.keys(res.body.entries[0]).sort()).toEqual([
      'answer',
      'created_at',
      'id',
      'question',
      'source_url',
      'tags',
      'updated_at',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('search_text');
    expect(JSON.stringify(res.body)).not.toContain('account_id');
    expect(res.body.total).toBe(1);
  });
});

describe('POST /api/knowledge', () => {
  it('requires both a question and an answer', async () => {
    const c = await cookie();
    for (const body of [{}, { question: 'q' }, { answer: 'a' }, { question: '  ', answer: 'a' }]) {
      const res = await request(app()).post('/api/knowledge').set('Cookie', c).send(body).expect(400);
      expect(res.body.error).toBe('invalid_knowledge_entry');
    }
    expect(createKnowledgeEntry).not.toHaveBeenCalled();
  });

  it('normalizes, dedupes and caps tags', async () => {
    await request(app())
      .post('/api/knowledge')
      .set('Cookie', await cookie())
      .send({
        question: 'q',
        answer: 'a',
        tags: ['  Envios ', 'ENVIOS', 'envios', '', ...Array.from({ length: 20 }, (_, i) => `t${i}`)],
      })
      .expect(201);

    const { tags } = createKnowledgeEntry.mock.calls[0][0];
    expect(tags.length).toBeLessThanOrEqual(10);
    expect(tags.filter((t: string) => t === 'envios')).toHaveLength(1);
    expect(tags).not.toContain('');
  });

  it('refuses to grow past the review ceiling', async () => {
    countKnowledgeEntries.mockResolvedValueOnce(2_000);

    const res = await request(app())
      .post('/api/knowledge')
      .set('Cookie', await cookie())
      .send({ question: 'q', answer: 'a' })
      .expect(409);

    expect(res.body.error).toBe('knowledge_limit_reached');
    expect(createKnowledgeEntry).not.toHaveBeenCalled();
  });

  it('audits the write', async () => {
    await request(app())
      .post('/api/knowledge')
      .set('Cookie', await cookie())
      .send({ question: 'q', answer: 'a' })
      .expect(201);

    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge.created', targetType: 'knowledge' }),
    );
  });
});

describe('PUT / DELETE /api/knowledge/:id', () => {
  it('rejects an id that is not a uuid before touching the database', async () => {
    const c = await cookie();
    await request(app()).put('/api/knowledge/not-a-uuid').set('Cookie', c).send({ question: 'q', answer: 'a' }).expect(400);
    await request(app()).delete('/api/knowledge/not-a-uuid').set('Cookie', c).expect(400);
    expect(updateKnowledgeEntry).not.toHaveBeenCalled();
    expect(deleteKnowledgeEntry).not.toHaveBeenCalled();
  });

  it('404s when the entry does not exist', async () => {
    updateKnowledgeEntry.mockResolvedValueOnce(null);
    deleteKnowledgeEntry.mockResolvedValueOnce(false);
    const c = await cookie();

    await request(app()).put(`/api/knowledge/${ENTRY_ID}`).set('Cookie', c).send({ question: 'q', answer: 'a' }).expect(404);
    await request(app()).delete(`/api/knowledge/${ENTRY_ID}`).set('Cookie', c).expect(404);
  });

  it('deletes and audits', async () => {
    await request(app()).delete(`/api/knowledge/${ENTRY_ID}`).set('Cookie', await cookie()).expect(204);

    expect(deleteKnowledgeEntry).toHaveBeenCalledWith(ENTRY_ID);
    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge.deleted' }),
    );
  });
});
