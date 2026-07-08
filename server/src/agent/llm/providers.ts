import { stripThinking } from './postprocess';

/**
 * Multi-provider LLM registry (Fase 4). Each entry captures the per-provider
 * knowledge that used to be hardcoded in agent/minimax.ts (a single-provider
 * MiniMax client): base URL, default model, and the handful of behavioral
 * quirks (vision support, forced tool_choice support, request-body shaping)
 * that differ across OpenAI-compatible chat-completions APIs.
 *
 * Model IDs and capability flags below were verified against each provider's
 * official docs on 2026-07-08 (see docsUrl + inline notes per entry) except
 * `minimax`, which is carried over unchanged from the pre-Fase-4 single
 * provider code — its capabilities are already proven by existing production
 * behavior (agent.ts unconditionally attached images and forced tool_choice
 * for MiniMax with no gating at all).
 */

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'minimax';

export interface PrepareBodyOptions {
  reasoningSplit: boolean;
  thinkingDisabled: boolean;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** Default OpenAI-compatible base URL, used when `llm.base_url` is unset. */
  baseURL: string;
  /** Default model id, used when `llm.model` is unset. */
  defaultModel: string;
  /** Reference docs URL — surfaced by the Fase 7 dashboard provider picker. */
  docsUrl: string;
  /** Whether this provider/model can accept image_url content parts. */
  supportsVision(model: string): boolean;
  /** Whether a forced `tool_choice: {type:'function', function:{name}}` is
   * honored by this provider (through its OpenAI-compat layer, where
   * applicable). When false, the grounding-lock loop in agent.ts relies on
   * its system-message nudge alone instead of also forcing the call. */
  supportsForcedToolChoice: boolean;
  /** Mutates `body` in place with any provider-specific request fields
   * (e.g. MiniMax's reasoning_split / thinking toggles). No-op for providers
   * with no such quirks. */
  prepareBody(body: Record<string, unknown>, opts: PrepareBodyOptions): void;
  /** Cleans up the raw assistant text before it reaches a human. */
  postprocess(text: string): string;
  // Extension point if a compat layer proves too lossy for a given provider —
  // NOT implemented in Fase 4:
  // adapter?: (params) => Promise<ChatCompletion>
}

function noopPrepareBody(): void {
  // No provider-specific request fields for this provider.
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    // developers.openai.com/api/docs/models (verified 2026-07-08): current
    // cost-effective vision+tools model, replacing the now-stale gpt-5.1-mini.
    defaultModel: 'gpt-5.4-mini',
    docsUrl: 'https://developers.openai.com/api/docs/models',
    supportsVision: () => true,
    supportsForcedToolChoice: true,
    prepareBody: noopPrepareBody,
    postprocess: stripThinking,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    // Trailing slash per Anthropic's own OpenAI-SDK-compatibility example.
    baseURL: 'https://api.anthropic.com/v1/',
    // platform.claude.com/docs/en/api/openai-sdk (verified 2026-07-08): GA model.
    defaultModel: 'claude-sonnet-5',
    docsUrl: 'https://platform.claude.com/docs/en/api/openai-sdk',
    supportsVision: () => true,
    // Anthropic's compat-layer field support table lists tool_choice and
    // tools[n].function.* as "Fully supported" (only `strict` is ignored).
    supportsForcedToolChoice: true,
    prepareBody: noopPrepareBody,
    postprocess: stripThinking,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    // ai.google.dev/gemini-api/docs/openai (verified 2026-07-08): supersedes
    // the stale gemini-2.5-flash candidate.
    defaultModel: 'gemini-3.5-flash',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    supportsVision: () => true,
    // Only `tool_choice: "auto"` is confirmed through this compat proxy;
    // Gemini's native forced single-function tool_choice may use a different
    // allowed_tools/generation_config shape that doesn't translate 1:1 here.
    // Kept conservatively false until verified empirically via probe-tools.ts.
    supportsForcedToolChoice: false,
    prepareBody: noopPrepareBody,
    postprocess: stripThinking,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    // Deliberate deviation from the plan's literal candidate 'deepseek-chat':
    // api-docs.deepseek.com (verified 2026-07-08) — the 'deepseek-chat' /
    // 'deepseek-reasoner' aliases are retired 2026-07-24 15:59 UTC. They
    // currently route to this canonical id; using the alias would give a new
    // deploy a hard 404 cliff 16 days after this phase landed.
    defaultModel: 'deepseek-v4-flash',
    docsUrl: 'https://api-docs.deepseek.com',
    // No vision support in DeepSeek's documented API (a separate unreleased
    // deepseek-vision-preview beta exists but is out of scope for Fase 4).
    supportsVision: () => false,
    supportsForcedToolChoice: false,
    prepareBody: noopPrepareBody,
    postprocess: stripThinking,
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseURL: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    // Root domain only — carried over from the pre-Fase-4 single-provider
    // setup; no specific docs path was verified this session. Confirm before
    // wiring into the Fase 7 dashboard provider picker.
    docsUrl: 'https://www.minimax.io',
    supportsVision: () => true,
    supportsForcedToolChoice: true,
    // M3 is a thinking model: reasoning_split keeps the visible answer short
    // by moving reasoning out of `content`; thinking:{type:'disabled'} is a
    // hard off-switch. Both are MiniMax-specific request fields the OpenAI
    // SDK types don't know about — forwarded verbatim by the SDK.
    prepareBody(body, opts) {
      if (opts.reasoningSplit) body.reasoning_split = true;
      if (opts.thinkingDisabled) body.thinking = { type: 'disabled' };
    },
    postprocess: stripThinking,
  },
};
