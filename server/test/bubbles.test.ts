import { describe, it, expect } from 'vitest';
import { splitBubbles } from '../src/handlers/messages';

describe('splitBubbles', () => {
  it('returns a single bubble when there is no separator', () => {
    expect(splitBubbles('Hola, ¿en qué te ayudo?', 3)).toEqual(['Hola, ¿en qué te ayudo?']);
  });

  it('splits on a line with only ---', () => {
    expect(splitBubbles('Primero\n---\nSegundo', 3)).toEqual(['Primero', 'Segundo']);
  });

  it('trims whitespace around each bubble', () => {
    expect(splitBubbles('  uno  \n --- \n  dos  ', 3)).toEqual(['uno', 'dos']);
  });

  it('merges overflow into the last bubble when exceeding max', () => {
    const out = splitBubbles('a\n---\nb\n---\nc\n---\nd', 3);
    expect(out.length).toBe(3);
    expect(out[2]).toBe('c\n\nd');
  });

  it('handles empty input', () => {
    expect(splitBubbles('', 3)).toEqual([]);
  });
});
