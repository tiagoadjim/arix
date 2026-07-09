import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every dependency MessageRouter.flush() touches so we can drive it
// directly (bypassing handle()'s Baileys-specific plumbing, which flush()
// doesn't need) and observe the warnedUnconfigured clear-on-configured path.
const {
  getConversationMock,
  getRecentMessagesMock,
  insertOutboundMessageMock,
  touchConversationMock,
} = vi.hoisted(() => ({
  getConversationMock: vi.fn(),
  getRecentMessagesMock: vi.fn(),
  insertOutboundMessageMock: vi.fn(),
  touchConversationMock: vi.fn(),
}));
vi.mock('../src/db/repo', () => ({
  getConversation: getConversationMock,
  getRecentMessages: getRecentMessagesMock,
  insertOutboundMessage: insertOutboundMessageMock,
  touchConversation: touchConversationMock,
  // Unused by flush(), but messages.ts imports them too — stubbed so the
  // mock factory satisfies every named import.
  getOrCreateConversation: vi.fn(),
  getRecentBotConversations: vi.fn(),
  insertInboundMessage: vi.fn(),
}));

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
    insertOutboundMessageMock.mockReset().mockResolvedValue({ id: 'out1' });
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
