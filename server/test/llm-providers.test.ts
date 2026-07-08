import { describe, it, expect } from 'vitest';
import { PROVIDERS, type ProviderId } from '../src/agent/llm/providers';

const ALL_IDS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax'];

describe('PROVIDERS registry', () => {
  it('has exactly the 5 expected provider ids, no more, no fewer', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...ALL_IDS].sort());
  });

  it.each(ALL_IDS)('%s has a non-empty baseURL and defaultModel', (id) => {
    const spec = PROVIDERS[id];
    expect(spec.id).toBe(id);
    expect(typeof spec.baseURL).toBe('string');
    expect(spec.baseURL.length).toBeGreaterThan(0);
    expect(typeof spec.defaultModel).toBe('string');
    expect(spec.defaultModel.length).toBeGreaterThan(0);
    expect(typeof spec.docsUrl).toBe('string');
    expect(spec.docsUrl.length).toBeGreaterThan(0);
  });

  describe('supportsVision matrix', () => {
    it('deepseek does not support vision', () => {
      expect(PROVIDERS.deepseek.supportsVision('deepseek-v4-flash')).toBe(false);
    });

    it.each(['openai', 'anthropic', 'gemini', 'minimax'] as ProviderId[])(
      '%s supports vision',
      (id) => {
        expect(PROVIDERS[id].supportsVision(PROVIDERS[id].defaultModel)).toBe(true);
      },
    );
  });

  describe('supportsForcedToolChoice', () => {
    it('openai, anthropic and minimax support a forced tool_choice', () => {
      expect(PROVIDERS.openai.supportsForcedToolChoice).toBe(true);
      expect(PROVIDERS.anthropic.supportsForcedToolChoice).toBe(true);
      expect(PROVIDERS.minimax.supportsForcedToolChoice).toBe(true);
    });

    it('gemini and deepseek do not (unverified/unsupported through the compat layer)', () => {
      expect(PROVIDERS.gemini.supportsForcedToolChoice).toBe(false);
      expect(PROVIDERS.deepseek.supportsForcedToolChoice).toBe(false);
    });
  });

  describe('prepareBody', () => {
    it('minimax sets reasoning_split only when the opt is enabled', () => {
      const body: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body, { reasoningSplit: false, thinkingDisabled: false });
      expect(body.reasoning_split).toBeUndefined();

      const body2: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body2, { reasoningSplit: true, thinkingDisabled: false });
      expect(body2.reasoning_split).toBe(true);
    });

    it('minimax sets thinking:{type:"disabled"} only when thinkingDisabled is true', () => {
      const body: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body, { reasoningSplit: false, thinkingDisabled: false });
      expect(body.thinking).toBeUndefined();

      const body2: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body2, { reasoningSplit: false, thinkingDisabled: true });
      expect(body2.thinking).toEqual({ type: 'disabled' });
    });

    it.each(['openai', 'anthropic', 'gemini', 'deepseek'] as ProviderId[])(
      '%s never adds reasoning_split/thinking, even with both opts enabled',
      (id) => {
        const body: Record<string, unknown> = {};
        PROVIDERS[id].prepareBody(body, { reasoningSplit: true, thinkingDisabled: true });
        expect(body.reasoning_split).toBeUndefined();
        expect(body.thinking).toBeUndefined();
      },
    );
  });

  describe('postprocess', () => {
    it.each(ALL_IDS)('%s strips a <think>...</think> block', (id) => {
      const result = PROVIDERS[id].postprocess('<think>secret reasoning</think>Hola, ¿en qué te ayudo?');
      expect(result).toBe('Hola, ¿en qué te ayudo?');
    });

    it.each(ALL_IDS)('%s is a safe no-op on plain text', (id) => {
      expect(PROVIDERS[id].postprocess('Hola, ¿en qué te ayudo?')).toBe('Hola, ¿en qué te ayudo?');
    });
  });
});
