import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  REASONING_EFFORTS,
  isReasoningModel,
  type PrepareBodyOptions,
  type ProviderId,
} from '../src/agent/llm/providers';

const ALL_IDS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax'];

const OPTS: PrepareBodyOptions = {
  reasoningSplit: false,
  thinkingDisabled: false,
  reasoningEffort: 'medium',
};

/** The body runAgent builds before any provider gets to shape it. */
function agentBody(model: string): Record<string, unknown> {
  return { model, messages: [], temperature: 0.4, max_tokens: 4096 };
}

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
      PROVIDERS.minimax.prepareBody(body, OPTS);
      expect(body.reasoning_split).toBeUndefined();

      const body2: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body2, { ...OPTS, reasoningSplit: true });
      expect(body2.reasoning_split).toBe(true);
    });

    it('minimax sets thinking:{type:"disabled"} only when thinkingDisabled is true', () => {
      const body: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body, OPTS);
      expect(body.thinking).toBeUndefined();

      const body2: Record<string, unknown> = {};
      PROVIDERS.minimax.prepareBody(body2, { ...OPTS, thinkingDisabled: true });
      expect(body2.thinking).toEqual({ type: 'disabled' });
    });

    it.each(['openai', 'anthropic', 'gemini', 'deepseek'] as ProviderId[])(
      '%s never adds reasoning_split/thinking, even with both opts enabled',
      (id) => {
        const body: Record<string, unknown> = { model: 'gpt-4o' };
        PROVIDERS[id].prepareBody(body, { ...OPTS, reasoningSplit: true, thinkingDisabled: true });
        expect(body.reasoning_split).toBeUndefined();
        expect(body.thinking).toBeUndefined();
      },
    );
  });

  describe('isReasoningModel', () => {
    it.each([
      'gpt-5.6-luna',
      'gpt-5.6-luna-pro',
      'gpt-5.4-mini',
      'openai/gpt-5.6-luna',
      'GPT-5.6-Luna',
      '  gpt-5.6-luna  ',
      'o3-mini',
    ])('treats %s as a reasoning model', (model) => {
      expect(isReasoningModel(model)).toBe(true);
    });

    it.each([
      'gpt-4o',
      'gpt-4.1-mini',
      // The *-chat ids in the GPT-5 family are NOT reasoning models.
      'gpt-5-chat-latest',
      'gpt-5.6-luna-chat',
      'claude-sonnet-5',
      'gemini-3.5-flash',
      'MiniMax-M3',
      '',
    ])('treats %s as a classic chat model', (model) => {
      expect(isReasoningModel(model)).toBe(false);
    });
  });

  describe('openai prepareBody (GPT-5.x reasoning dialect)', () => {
    it('drops temperature/top_p and converts max_tokens for gpt-5.6-luna', () => {
      const body = agentBody('gpt-5.6-luna');
      body.top_p = 0.9;
      PROVIDERS.openai.prepareBody(body, OPTS);

      // Sent verbatim these are a 400, so they must be gone — not just ignored.
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      // 4096 visible-answer budget + the medium reasoning headroom.
      expect(body.max_completion_tokens).toBe(4096 + 12_288);
      expect(body.reasoning_effort).toBe('medium');
    });

    it('reserves reasoning headroom per effort, and none at all for "none"', () => {
      const budgets = REASONING_EFFORTS.map((effort) => {
        const body = agentBody('gpt-5.6-luna');
        PROVIDERS.openai.prepareBody(body, { ...OPTS, reasoningEffort: effort });
        expect(body.reasoning_effort).toBe(effort);
        return body.max_completion_tokens as number;
      });

      // 'none' spends nothing on thinking; every level after it is strictly
      // roomier, and the priciest stays well under luna's 128k output cap.
      expect(budgets[0]).toBe(4096);
      expect([...budgets].sort((a, b) => a - b)).toEqual(budgets);
      expect(Math.max(...budgets)).toBeLessThan(128_000);
    });

    it('rewrites a vendor-prefixed id from an OpenAI-compatible gateway', () => {
      const body = agentBody('openai/gpt-5.6-luna');
      PROVIDERS.openai.prepareBody(body, OPTS);
      expect(body.max_completion_tokens).toBe(4096 + 12_288);
      expect(body.temperature).toBeUndefined();
    });

    it('leaves a classic chat model untouched', () => {
      const body = agentBody('gpt-4o');
      PROVIDERS.openai.prepareBody(body, OPTS);
      expect(body).toEqual(agentBody('gpt-4o'));
    });

    it('preserves the probe\'s 1-token ping at effort "none"', () => {
      const body: Record<string, unknown> = {
        model: 'gpt-5.6-luna',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
      PROVIDERS.openai.prepareBody(body, { ...OPTS, reasoningEffort: 'none' });
      expect(body.max_completion_tokens).toBe(1);
      expect(body.reasoning_effort).toBe('none');
    });

    it.each(['anthropic', 'gemini', 'deepseek', 'minimax'] as ProviderId[])(
      '%s does not apply the OpenAI reasoning dialect to a gpt-5 id',
      (id) => {
        const body = agentBody('gpt-5.6-luna');
        PROVIDERS[id].prepareBody(body, OPTS);
        expect(body.temperature).toBe(0.4);
        expect(body.max_tokens).toBe(4096);
        expect(body.max_completion_tokens).toBeUndefined();
        expect(body.reasoning_effort).toBeUndefined();
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
