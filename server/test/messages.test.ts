import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every dependency MessageRouter.flush() touches so we can drive it
// directly (bypassing handle()'s Baileys-specific plumbing, which flush()
// doesn't need) and observe the warnedUnconfigured clear-on-configured path.
const {
  getConversationMock,
  getOrCreateConversationMock,
  getRecentMessagesMock,
  insertInboundMessageMock,
  prepareOutboundMessageMock,
  prepareOutboundBatchMock,
  claimMessageForSendingMock,
  cancelOutboundMessageMock,
  cancelAgentOutboxForTurnMock,
  getAgentOutboxForTurnMock,
  getRecoverableHumanOutboxMock,
  getMessageByClientIdMock,
  markMessageSentMock,
  markMessageFailedMock,
  touchConversationMock,
} = vi.hoisted(() => ({
  getConversationMock: vi.fn(),
  getOrCreateConversationMock: vi.fn(),
  getRecentMessagesMock: vi.fn(),
  insertInboundMessageMock: vi.fn(),
  prepareOutboundMessageMock: vi.fn(),
  prepareOutboundBatchMock: vi.fn(),
  claimMessageForSendingMock: vi.fn(),
  cancelOutboundMessageMock: vi.fn(),
  cancelAgentOutboxForTurnMock: vi.fn(),
  getAgentOutboxForTurnMock: vi.fn(),
  getRecoverableHumanOutboxMock: vi.fn(),
  getMessageByClientIdMock: vi.fn(),
  markMessageSentMock: vi.fn(),
  markMessageFailedMock: vi.fn(),
  touchConversationMock: vi.fn(),
}));
vi.mock('../src/db/repo', () => ({
  getConversation: getConversationMock,
  getRecentMessages: getRecentMessagesMock,
  prepareOutboundMessage: prepareOutboundMessageMock,
  prepareOutboundBatch: prepareOutboundBatchMock,
  claimMessageForSending: claimMessageForSendingMock,
  cancelOutboundMessage: cancelOutboundMessageMock,
  cancelAgentOutboxForTurn: cancelAgentOutboxForTurnMock,
  getAgentOutboxForTurn: getAgentOutboxForTurnMock,
  getRecoverableHumanOutbox: getRecoverableHumanOutboxMock,
  getMessageByClientId: getMessageByClientIdMock,
  markMessageSent: markMessageSentMock,
  markMessageFailed: markMessageFailedMock,
  touchConversation: touchConversationMock,
  // Unused by flush(), but messages.ts imports them too — stubbed so the
  // mock factory satisfies every named import.
  getOrCreateConversation: getOrCreateConversationMock,
  getUnansweredBotConversations: vi.fn(),
  getRecoverableAgentOutbox: vi.fn().mockResolvedValue([]),
  isAgentOutboxTurnCurrent: vi.fn().mockResolvedValue(true),
  insertInboundMessage: insertInboundMessageMock,
}));

async function claimLatestPrepared(id: string): Promise<Message | null> {
  for (const result of [...prepareOutboundMessageMock.mock.results].reverse()) {
    if (result.type !== 'return') continue;
    const prepared = await Promise.resolve(result.value) as { message?: Message } | undefined;
    if (prepared?.message?.id === id) {
      return { ...prepared.message, send_status: 'sending', send_attempt_id: 'attempt-1' };
    }
  }
  return null;
}

async function batchFromSingle(input: {
  conversationId: string;
  sender: string;
  messages: Array<{ body: string; clientId: string; waMessageId: string }>;
}): Promise<Message[]> {
  return Promise.all(
    input.messages.map(async (item) => {
      const prepared = await prepareOutboundMessageMock({
        conversationId: input.conversationId,
        sender: input.sender,
        ...item,
      }) as { message: Message };
      return prepared.message;
    }),
  );
}

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent', () => ({ runAgent: runAgentMock }));

const { llmMock } = vi.hoisted(() => ({ llmMock: vi.fn() }));
vi.mock('../src/config/runtime', () => ({ llm: llmMock }));

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));
vi.mock('../src/logger', () => ({
  logger: { warn: loggerWarnMock, error: vi.fn(), info: vi.fn(), fatal: vi.fn() },
}));

import {
  isLoneStickerRun,
  evictIdleStates,
  pruneWarnedUnconfigured,
  STATE_IDLE_TTL_MS,
  MessageRouter,
} from '../src/handlers/messages';
import type { Message } from '../src/types';
import type { ConvState } from '../src/handlers/messages';
import type { WhatsAppGateway } from '../src/whatsapp/socket';
import type { WAMessage, WASocket } from 'baileys';

const inMsg = (msg_type: string): Message => ({ direction: 'in', msg_type } as unknown as Message);
const outMsg = (): Message => ({ direction: 'out', msg_type: 'text' } as unknown as Message);

describe('isLoneStickerRun', () => {
  it('is true for a single trailing sticker', () => {
    expect(isLoneStickerRun([outMsg(), inMsg('sticker')])).toBe(true);
  });

  it('is true for several trailing stickers', () => {
    expect(isLoneStickerRun([inMsg('sticker'), inMsg('sticker')])).toBe(true);
  });

  it('is false when text is mixed into the trailing run (we should reply)', () => {
    expect(isLoneStickerRun([inMsg('sticker'), inMsg('text')])).toBe(false);
  });

  it('is false when the trailing run is an audio (we should reply)', () => {
    expect(isLoneStickerRun([inMsg('audio')])).toBe(false);
  });

  it('only considers the trailing inbound run, ignoring stickers before a reply', () => {
    // sticker → bot replied → new sticker: the trailing run is just the last sticker.
    expect(isLoneStickerRun([inMsg('sticker'), outMsg(), inMsg('sticker')])).toBe(true);
  });

  it('is false for empty history', () => {
    expect(isLoneStickerRun([])).toBe(false);
  });
});

describe('evictIdleStates', () => {
  const state = (over: Partial<ConvState> = {}): ConvState => ({
    timer: null,
    processing: false,
    dirty: false,
    inboundGeneration: 0,
    processedGeneration: 0,
    inboundCursor: null,
    lastImage: null,
    imageAt: 0,
    lastTouchedAt: 0,
    ...over,
  });

  it('evicts an entry with no pending timer, not processing, idle beyond the TTL', () => {
    const states = new Map([['c1', state({ lastTouchedAt: 0 })]]);
    const evicted = evictIdleStates(states, STATE_IDLE_TTL_MS + 1, STATE_IDLE_TTL_MS);
    expect(evicted).toBe(1);
    expect(states.has('c1')).toBe(false);
  });

  it('does not evict an entry still within the idle window', () => {
    const states = new Map([['c1', state({ lastTouchedAt: 1000 })]]);
    const evicted = evictIdleStates(states, 1000 + STATE_IDLE_TTL_MS - 1, STATE_IDLE_TTL_MS);
    expect(evicted).toBe(0);
    expect(states.has('c1')).toBe(true);
  });

  it('never evicts an entry with a pending debounce timer, no matter how idle', () => {
    const timer = setTimeout(() => {}, 100_000);
    try {
      const states = new Map([['c1', state({ lastTouchedAt: 0, timer })]]);
      const evicted = evictIdleStates(states, STATE_IDLE_TTL_MS + 1, STATE_IDLE_TTL_MS);
      expect(evicted).toBe(0);
      expect(states.has('c1')).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('never evicts an entry that is mid-flush (processing)', () => {
    const states = new Map([['c1', state({ lastTouchedAt: 0, processing: true })]]);
    const evicted = evictIdleStates(states, STATE_IDLE_TTL_MS + 1, STATE_IDLE_TTL_MS);
    expect(evicted).toBe(0);
    expect(states.has('c1')).toBe(true);
  });

  it('evicts multiple idle entries and leaves fresh ones alone', () => {
    const states = new Map([
      ['idle1', state({ lastTouchedAt: 0 })],
      ['idle2', state({ lastTouchedAt: 0 })],
      ['fresh', state({ lastTouchedAt: STATE_IDLE_TTL_MS + 1 })],
    ]);
    const evicted = evictIdleStates(states, STATE_IDLE_TTL_MS + 1, STATE_IDLE_TTL_MS);
    expect(evicted).toBe(2);
    expect(states.has('idle1')).toBe(false);
    expect(states.has('idle2')).toBe(false);
    expect(states.has('fresh')).toBe(true);
  });

  it('defaults idleMs to STATE_IDLE_TTL_MS when not passed explicitly', () => {
    const states = new Map([['c1', state({ lastTouchedAt: 0 })]]);
    const evicted = evictIdleStates(states, STATE_IDLE_TTL_MS + 1);
    expect(evicted).toBe(1);
  });
});

describe('pruneWarnedUnconfigured', () => {
  const state = (over: Partial<ConvState> = {}): ConvState => ({
    timer: null,
    processing: false,
    dirty: false,
    inboundGeneration: 0,
    processedGeneration: 0,
    inboundCursor: null,
    lastImage: null,
    imageAt: 0,
    lastTouchedAt: 0,
    ...over,
  });

  it('drops a warned conversation ID once its state entry is gone', () => {
    const states = new Map<string, ConvState>(); // already evicted
    const warned = new Set(['c1']);
    pruneWarnedUnconfigured(warned, states);
    expect(warned.has('c1')).toBe(false);
  });

  it('keeps a warned conversation ID whose state entry is still live', () => {
    const states = new Map([['c1', state()]]);
    const warned = new Set(['c1']);
    pruneWarnedUnconfigured(warned, states);
    expect(warned.has('c1')).toBe(true);
  });

  it('prunes multiple stale entries, leaving live ones alone', () => {
    const states = new Map([['live', state()]]);
    const warned = new Set(['stale1', 'stale2', 'live']);
    pruneWarnedUnconfigured(warned, states);
    expect([...warned]).toEqual(['live']);
  });
});

describe('MessageRouter.flush() — warnedUnconfigured clears once the LLM becomes configured', () => {
  const gateway = {
    indicateTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue('wa-msg-1'),
  } as unknown as WhatsAppGateway;

  const conv = (id: string) => ({
    id,
    account_id: 'acc',
    wa_jid: `${id}@s.whatsapp.net`,
    phone: '5491100000000',
    customer_name: 'Test',
    customer_email: null,
    mode: 'bot',
    assigned_to: null,
    status: 'open',
    escalation_reason: null,
    unread_count: 0,
    last_message_at: null,
    last_message_preview: null,
    created_at: '',
    updated_at: '',
  });

  const inboundHistory = (id: string): Message[] =>
    [
      { id: 'm1', conversation_id: id, direction: 'in', sender: 'customer', body: 'hola', msg_type: 'text' },
    ] as unknown as Message[];

  // flush() is TS-private but not JS-private (no #field) — cast to call it
  // directly, bypassing handle()'s Baileys-specific plumbing (irrelevant here).
  type Flushable = { flush(conversationId: string): Promise<void> };

  beforeEach(() => {
    getConversationMock.mockReset();
    getRecentMessagesMock.mockReset();
    prepareOutboundMessageMock.mockReset().mockImplementation(async (input: { conversationId: string; body: string; clientId: string; waMessageId: string }) => ({
      message: {
        id: 'out1',
        conversation_id: input.conversationId,
        direction: 'out',
        sender: 'agent',
        body: input.body,
        msg_type: 'text',
        client_id: input.clientId,
        wa_message_id: input.waMessageId,
        send_status: 'pending',
      },
      created: true,
    }));
    prepareOutboundBatchMock.mockReset().mockImplementation(batchFromSingle);
    claimMessageForSendingMock.mockReset().mockImplementation(claimLatestPrepared);
    cancelOutboundMessageMock.mockReset().mockResolvedValue(undefined);
    cancelAgentOutboxForTurnMock.mockReset().mockResolvedValue(undefined);
    getAgentOutboxForTurnMock.mockReset().mockResolvedValue([]);
    getRecoverableHumanOutboxMock.mockReset().mockResolvedValue([]);
    getMessageByClientIdMock.mockReset().mockResolvedValue(null);
    markMessageSentMock.mockReset().mockResolvedValue(true);
    markMessageFailedMock.mockReset().mockResolvedValue(true);
    touchConversationMock.mockReset().mockResolvedValue(undefined);
    runAgentMock.mockReset().mockResolvedValue('ok');
    llmMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('re-warns a conversation once the LLM flips unconfigured -> configured -> unconfigured again, proving the set was actually cleared (not just deduped)', async () => {
    const router = new MessageRouter(gateway) as unknown as Flushable;

    // conv1: LLM unconfigured — warns once and adds conv1 to warnedUnconfigured.
    llmMock.mockResolvedValue({ configured: false });
    getConversationMock.mockResolvedValue(conv('conv1'));
    getRecentMessagesMock.mockResolvedValue(inboundHistory('conv1'));
    await router.flush('conv1');
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).not.toHaveBeenCalled();

    // conv1 again, still unconfigured — no re-warn (already in the set).
    await router.flush('conv1');
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);

    // conv2: still unconfigured — a NEW id, so it warns too.
    getConversationMock.mockResolvedValue(conv('conv2'));
    getRecentMessagesMock.mockResolvedValue(inboundHistory('conv2'));
    await router.flush('conv2');
    expect(loggerWarnMock).toHaveBeenCalledTimes(2);

    // LLM becomes configured — flush() proceeds all the way through for
    // conv1 and (handlers/messages.ts ~357-360) clears EVERY prior warning,
    // not just conv1's.
    llmMock.mockResolvedValue({ configured: true });
    getConversationMock.mockResolvedValue(conv('conv1'));
    getRecentMessagesMock.mockResolvedValue(inboundHistory('conv1'));
    await router.flush('conv1');
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    // LLM drops back to unconfigured — conv2 warns AGAIN. If
    // warnedUnconfigured hadn't been cleared, conv2 would still be marked
    // as already-warned from its earlier flush() above and this would fail.
    llmMock.mockResolvedValue({ configured: false });
    getConversationMock.mockResolvedValue(conv('conv2'));
    getRecentMessagesMock.mockResolvedValue(inboundHistory('conv2'));
    await router.flush('conv2');
    expect(loggerWarnMock).toHaveBeenCalledTimes(3);
  });
});

describe('MessageRouter.flush() — inbound generation race', () => {
  type Flushable = { flush(conversationId: string): Promise<void> };
  type Inspectable = { states: Map<string, ConvState> };

  const conversation = {
    id: 'conv-race',
    account_id: 'acc',
    wa_jid: '5491100000000@s.whatsapp.net',
    phone: '5491100000000',
    customer_name: 'Test',
    customer_email: null,
    mode: 'bot',
    assigned_to: null,
    status: 'open',
    escalation_reason: null,
    unread_count: 0,
    last_message_at: null,
    last_message_preview: null,
    created_at: '',
    updated_at: '',
  };

  const waInbound = (id: string, body: string) =>
    ({
      key: { remoteJid: conversation.wa_jid, id },
      message: { conversation: body },
      pushName: 'Test',
    }) as WAMessage;

  it('drops a stale model answer and processes the inbound that arrived while runAgent was pending', async () => {
    const persisted: Message[] = [];
    const gateway = {
      indicateTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue('wa-out-1'),
    } as unknown as WhatsAppGateway;
    const router = new MessageRouter(gateway);
    const flushable = router as unknown as Flushable;
    const inspectable = router as unknown as Inspectable;

    getConversationMock.mockReset().mockResolvedValue(conversation);
    getOrCreateConversationMock.mockReset().mockResolvedValue(conversation);
    touchConversationMock.mockReset().mockResolvedValue(undefined);
    prepareOutboundMessageMock.mockReset().mockImplementation(async (input: { conversationId: string; body: string; clientId: string; waMessageId: string }) => ({
      message: {
        id: 'out-1',
        conversation_id: input.conversationId,
        direction: 'out',
        sender: 'agent',
        body: input.body,
        msg_type: 'text',
        client_id: input.clientId,
        wa_message_id: input.waMessageId,
        send_status: 'pending',
      },
      created: true,
    }));
    prepareOutboundBatchMock.mockReset().mockImplementation(batchFromSingle);
    claimMessageForSendingMock.mockReset().mockImplementation(claimLatestPrepared);
    cancelOutboundMessageMock.mockReset().mockResolvedValue(undefined);
    cancelAgentOutboxForTurnMock.mockReset().mockResolvedValue(undefined);
    getAgentOutboxForTurnMock.mockReset().mockResolvedValue([]);
    getRecoverableHumanOutboxMock.mockReset().mockResolvedValue([]);
    getMessageByClientIdMock.mockReset().mockResolvedValue(null);
    markMessageSentMock.mockReset().mockResolvedValue(true);
    markMessageFailedMock.mockReset().mockResolvedValue(true);
    llmMock.mockReset().mockResolvedValue({ configured: true });
    getRecentMessagesMock.mockReset().mockImplementation(async (_id: string, limit?: number) =>
      limit ? persisted.slice(-limit) : [...persisted],
    );
    insertInboundMessageMock.mockReset().mockImplementation(async (input: { body: string }) => {
      const message = {
        id: `m${persisted.length + 1}`,
        conversation_id: conversation.id,
        direction: 'in',
        sender: 'customer',
        body: input.body,
        msg_type: 'text',
      } as unknown as Message;
      persisted.push(message);
      return message;
    });

    let releaseOldReply!: (reply: string) => void;
    const oldReplyPending = new Promise<string>((resolve) => {
      releaseOldReply = resolve;
    });
    runAgentMock
      .mockReset()
      .mockReturnValueOnce(oldReplyPending)
      .mockResolvedValueOnce('respuesta para los dos mensajes');

    await router.handle({} as WASocket, waInbound('wa-in-1', 'primer mensaje'));
    const firstFlush = flushable.flush(conversation.id);
    // runAgent has now captured generation 1 and is still thinking.
    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(1));

    await router.handle({} as WASocket, waInbound('wa-in-2', 'dato adicional'));
    releaseOldReply('respuesta obsoleta');
    await firstFlush;

    expect(gateway.sendText).not.toHaveBeenCalled();
    // The stale run schedules the newer generation instead of letting the old
    // outbound become the DB tail and hide it.
    expect(inspectable.states.get(conversation.id)?.timer).not.toBeNull();

    // Drive the guaranteed follow-up directly (it also clears the tracked
    // 250ms retry timer), keeping this race test independent of wall-clock time.
    await flushable.flush(conversation.id);

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    const secondHistory = runAgentMock.mock.calls[1]?.[1] as Message[];
    expect(secondHistory.map((m) => m.body)).toEqual(['primer mensaje', 'dato adicional']);
    expect(gateway.sendText).toHaveBeenCalledTimes(1);
    expect(gateway.sendText).toHaveBeenCalledWith(
      conversation.wa_jid,
      'respuesta para los dos mensajes',
      expect.any(String),
    );
  });

  it('keeps the newer inbound pending when an older send was already in flight', async () => {
    const persisted: Message[] = [];
    let releaseOldSend!: (waId: string) => void;
    const oldSendPending = new Promise<string>((resolve) => {
      releaseOldSend = resolve;
    });
    const gateway = {
      indicateTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockReturnValueOnce(oldSendPending).mockResolvedValueOnce('wa-out-2'),
    } as unknown as WhatsAppGateway;
    const router = new MessageRouter(gateway);
    const flushable = router as unknown as Flushable;

    getConversationMock.mockReset().mockResolvedValue(conversation);
    getOrCreateConversationMock.mockReset().mockResolvedValue(conversation);
    touchConversationMock.mockReset().mockResolvedValue(undefined);
    llmMock.mockReset().mockResolvedValue({ configured: true });
    getRecentMessagesMock.mockReset().mockImplementation(async (_id: string, limit?: number) =>
      limit ? persisted.slice(-limit) : [...persisted],
    );
    insertInboundMessageMock.mockReset().mockImplementation(async (input: { body: string }) => {
      const message = {
        id: `m${persisted.filter((m) => m.direction === 'in').length + 1}`,
        conversation_id: conversation.id,
        direction: 'in',
        sender: 'customer',
        body: input.body,
        msg_type: 'text',
      } as unknown as Message;
      persisted.push(message);
      return message;
    });
    const outboundByClientId = new Map<string, Message>();
    prepareOutboundMessageMock.mockReset().mockImplementation(async (input: {
      conversationId: string;
      body: string;
      clientId: string;
      waMessageId: string;
    }) => {
      const message = {
        id: `o${persisted.filter((m) => m.direction === 'out').length + 1}`,
        conversation_id: conversation.id,
        direction: 'out',
        sender: 'agent',
        body: input.body,
        msg_type: 'text',
        client_id: input.clientId,
        wa_message_id: input.waMessageId,
        send_status: 'pending',
      } as unknown as Message;
      persisted.push(message);
      outboundByClientId.set(input.clientId, message);
      return { message, created: true };
    });
    prepareOutboundBatchMock.mockReset().mockImplementation(batchFromSingle);
    claimMessageForSendingMock.mockReset().mockImplementation(claimLatestPrepared);
    cancelOutboundMessageMock.mockReset().mockResolvedValue(undefined);
    cancelAgentOutboxForTurnMock.mockReset().mockResolvedValue(undefined);
    getAgentOutboxForTurnMock.mockReset().mockResolvedValue([]);
    getRecoverableHumanOutboxMock.mockReset().mockResolvedValue([]);
    getMessageByClientIdMock.mockReset().mockImplementation(async (clientId: string) => outboundByClientId.get(clientId) ?? null);
    markMessageSentMock.mockReset().mockImplementation(async (id: string, _attemptId: string, waId: string) => {
      const message = persisted.find((candidate) => candidate.id === id);
      if (message) {
        message.send_status = 'sent';
        message.wa_message_id = waId;
      }
      return true;
    });
    markMessageFailedMock.mockReset().mockResolvedValue(true);
    runAgentMock
      .mockReset()
      .mockResolvedValueOnce('respuesta vieja ya iniciada')
      .mockResolvedValueOnce('respuesta nueva');

    await router.handle({} as WASocket, waInbound('wa-in-1', 'primera pregunta'));
    const firstFlush = flushable.flush(conversation.id);
    await vi.waitFor(() => expect(gateway.sendText).toHaveBeenCalledTimes(1));

    // The outbox row is durable before transport starts. The new inbound is
    // then stored while the first WhatsApp send remains in flight.
    await router.handle({} as WASocket, waInbound('wa-in-2', 'segunda pregunta'));
    releaseOldSend('wa-out-1');
    await firstFlush;
    expect(persisted.map((m) => m.id)).toEqual(['m1', 'o1', 'm2']);

    await flushable.flush(conversation.id);

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    const followUpHistory = runAgentMock.mock.calls[1]?.[1] as Message[];
    // Cursor slicing keeps the newer inbound visible even though the previous
    // outbound completed after it arrived.
    expect(followUpHistory.map((m) => m.id)).toEqual(['m1', 'o1', 'm2']);
    expect(gateway.sendText).toHaveBeenLastCalledWith(conversation.wa_jid, 'respuesta nueva', expect.any(String));
  });
});
