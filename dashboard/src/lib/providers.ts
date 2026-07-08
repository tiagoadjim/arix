// Client-side mirror of server/src/agent/llm/providers.ts's PROVIDERS registry.
// Deliberately NOT imported across the server/dashboard package boundary — this
// is a small, hand-kept copy of just the fields the setup wizard / settings
// "AI Provider" tab need to render a picker (label, default model, docs link,
// static vision hint). Keep in sync by hand when server/src/agent/llm/providers.ts
// changes; values verified against that file on 2026-07-08.

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'minimax';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** Placeholder hint only — the server falls back to this when `model` is left blank. */
  defaultModel: string;
  docsUrl: string;
  /** Static per-provider vision support (none of the current providers vary this by model). */
  supportsVision: boolean;
  /** MiniMax-only request-shaping quirks (reasoning_split / thinking_disabled). */
  hasReasoningQuirks: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.4-mini',
    docsUrl: 'https://developers.openai.com/api/docs/models',
    supportsVision: true,
    hasReasoningQuirks: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-5',
    docsUrl: 'https://platform.claude.com/docs/en/api/openai-sdk',
    supportsVision: true,
    hasReasoningQuirks: false,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-3.5-flash',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    supportsVision: true,
    hasReasoningQuirks: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    docsUrl: 'https://api-docs.deepseek.com',
    supportsVision: false,
    hasReasoningQuirks: false,
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    defaultModel: 'MiniMax-M3',
    docsUrl: 'https://www.minimax.io',
    supportsVision: true,
    hasReasoningQuirks: true,
  },
};

export const PROVIDER_LIST: ProviderMeta[] = Object.values(PROVIDERS);

export function isProviderId(value: string): value is ProviderId {
  return value in PROVIDERS;
}
