import { describe, it, expect } from 'vitest';
import { isLoneStickerRun } from '../src/handlers/messages';
import type { Message } from '../src/types';

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
