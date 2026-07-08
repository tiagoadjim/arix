import { describe, it, expect } from 'vitest';
import { isLoneStickerRun, evictIdleStates, STATE_IDLE_TTL_MS } from '../src/handlers/messages';
import type { Message } from '../src/types';
import type { ConvState } from '../src/handlers/messages';

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
