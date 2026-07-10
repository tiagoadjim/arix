import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../src/types';

const { many, one, poolMock } = vi.hoisted(() => ({
  many: vi.fn(),
  one: vi.fn(),
  poolMock: { connect: vi.fn(), query: vi.fn(), end: vi.fn() },
}));

vi.mock('../src/db/pool', () => ({ many, one, pool: poolMock }));

import { getMessagePage, getMessages, listConversations } from '../src/db/repo';

const row = (id: string): Message =>
  ({
    id,
    conversation_id: '11111111-1111-4111-8111-111111111111',
    created_at: `2026-01-01T00:00:${id.replace(/\D/g, '').padStart(2, '0')}Z`,
  }) as Message;

beforeEach(() => {
  many.mockReset();
  one.mockReset();
});

describe('stable keyset conversation pagination', () => {
  const conversation = (id: string, at: string): Conversation => ({
    id,
    account_id: 'default',
    wa_jid: `${id}@s.whatsapp.net`,
    phone: null,
    customer_name: null,
    customer_email: null,
    mode: 'bot',
    assigned_to: null,
    status: 'open',
    escalation_reason: null,
    unread_count: 0,
    last_message_at: at,
    last_message_preview: null,
    created_at: at,
    updated_at: at,
  });

  it('uses a timestamp/id cursor, one look-ahead row and returns the next cursor', async () => {
    const rows = [
      conversation('11111111-1111-4111-8111-111111111111', '2026-01-03T00:00:00.000Z'),
      conversation('22222222-2222-4222-8222-222222222222', '2026-01-02T00:00:00.000Z'),
      conversation('33333333-3333-4333-8333-333333333333', '2026-01-01T00:00:00.000Z'),
    ];
    many.mockResolvedValue(rows);

    const page = await listConversations('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      cursor: { at: '2026-01-04T00:00:00.000Z', id: '44444444-4444-4444-8444-444444444444' },
      limit: 2,
    });

    expect(page.conversations.map(({ id }) => id)).toEqual(rows.slice(0, 2).map(({ id }) => id));
    expect(page.nextCursor).toEqual({
      at: '2026-01-02T00:00:00.000Z',
      id: '22222222-2222-4222-8222-222222222222',
    });
    expect(many).toHaveBeenCalledWith(
      expect.stringMatching(/coalesce\(c\.last_message_at, c\.created_at\), c\.id\).*<.*\$3::timestamptz, \$4::uuid[\s\S]*limit \$5/i),
      [
        'default',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '2026-01-04T00:00:00.000Z',
        '44444444-4444-4444-8444-444444444444',
        3,
      ],
    );
  });
});

describe('message history defaults', () => {
  it('loads the latest 100 rows in descending SQL order, then presents them oldest-to-newest', async () => {
    many.mockResolvedValue([row('m103'), row('m102'), row('m101')]);

    const messages = await getMessages('11111111-1111-4111-8111-111111111111');

    expect(messages.map(({ id }) => id)).toEqual(['m101', 'm102', 'm103']);
    expect(many).toHaveBeenCalledWith(
      expect.stringMatching(/order by created_at desc, id desc limit \$2/i),
      ['11111111-1111-4111-8111-111111111111', 100],
    );
  });
});

describe('stable keyset message pagination', () => {
  it('returns the newest page in chronological display order and reports an extra row', async () => {
    many.mockResolvedValue([row('m5'), row('m4'), row('m3')]);

    const page = await getMessagePage('11111111-1111-4111-8111-111111111111', { limit: 2 });

    expect(page.messages.map(({ id }) => id)).toEqual(['m4', 'm5']);
    expect(page.hasMore).toBe(true);
    expect(many).toHaveBeenCalledWith(
      expect.stringMatching(/order by created_at desc, id desc limit \$2/i),
      ['11111111-1111-4111-8111-111111111111', 3],
    );
  });

  it('uses the cursor tuple for older messages and reverses only the selected page', async () => {
    many.mockResolvedValue([row('m3'), row('m2'), row('m1')]);
    const cursor = '22222222-2222-4222-8222-222222222222';

    const page = await getMessagePage('11111111-1111-4111-8111-111111111111', {
      beforeId: cursor,
      limit: 2,
    });

    expect(page.messages.map(({ id }) => id)).toEqual(['m2', 'm3']);
    expect(page.hasMore).toBe(true);
    expect(many).toHaveBeenCalledWith(
      expect.stringMatching(/cursor\.conversation_id = \$1[\s\S]*\(m\.created_at, m\.id\) < \(cursor\.created_at, cursor\.id\)/i),
      ['11111111-1111-4111-8111-111111111111', cursor, 3],
    );
  });

  it('uses ascending keyset order for incremental messages after a cursor', async () => {
    many.mockResolvedValue([row('m6'), row('m7'), row('m8')]);
    const cursor = '33333333-3333-4333-8333-333333333333';

    const page = await getMessagePage('11111111-1111-4111-8111-111111111111', {
      afterId: cursor,
      limit: 2,
    });

    expect(page.messages.map(({ id }) => id)).toEqual(['m6', 'm7']);
    expect(page.hasMore).toBe(true);
    expect(many).toHaveBeenCalledWith(
      expect.stringMatching(/cursor\.conversation_id = \$1[\s\S]*\(m\.created_at, m\.id\) > \(cursor\.created_at, cursor\.id\)[\s\S]*order by m\.created_at asc, m\.id asc/i),
      ['11111111-1111-4111-8111-111111111111', cursor, 3],
    );
  });

  it('returns an empty page for a cursor from another conversation', async () => {
    // The SQL inner join deliberately produces no rows when the cursor does
    // not belong to the requested conversation.
    many.mockResolvedValue([]);

    await expect(
      getMessagePage('11111111-1111-4111-8111-111111111111', {
        beforeId: '44444444-4444-4444-8444-444444444444',
      }),
    ).resolves.toEqual({ messages: [], hasMore: false });
  });

  it('does not query when mutually exclusive before/after cursors are both supplied', async () => {
    await expect(
      getMessagePage('11111111-1111-4111-8111-111111111111', {
        beforeId: '44444444-4444-4444-8444-444444444444',
        afterId: '55555555-5555-4555-8555-555555555555',
      }),
    ).resolves.toEqual({ messages: [], hasMore: false });
    expect(many).not.toHaveBeenCalled();
  });

  it('caps caller-supplied page sizes at 200 plus one look-ahead row', async () => {
    many.mockResolvedValue([]);

    await getMessagePage('11111111-1111-4111-8111-111111111111', { limit: 10_000 });

    expect(many).toHaveBeenCalledWith(expect.any(String), [
      '11111111-1111-4111-8111-111111111111',
      201,
    ]);
  });
});
