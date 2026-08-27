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

/** Reasoning budget levels accepted by OpenAI's GPT-5.x family, cheapest first. */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * True for models that speak OpenAI's "reasoning" request dialect: they REJECT
 * (400, not silently ignore) `temperature`, `top_p`, `max_tokens` and the
 * penalty/logprob knobs, and take the output budget as `max_completion_tokens`.
 *
 * Matching is on the model id's last path segment so a vendor-prefixed id from
 * an OpenAI-compatible gateway ('openai/gpt-5.6-luna' on OpenRouter) is caught
 * too. The `*-chat*` ids in the GPT-5 family (e.g. gpt-5-chat-latest) are NOT
 * reasoning models and do accept temperature, hence the carve-out.
 */
export function isReasoningModel(model: string): boolean {
  const id = model.toLowerCase().trim().split('/').pop() ?? '';
  if (id.includes('-chat')) return false;
  return /^(gpt-[5-9]|o[1-9])/.test(id);
}

/**
 * Extra `max_completion_tokens` to reserve for reasoning tokens on top of the
 * caller's visible-answer budget. Reasoning tokens are billed as output and
 * count against the same ceiling, so without headroom a thinking turn burns the
 * whole budget and comes back with finish_reason 'length' and empty content —
 * which agent.ts turns into the generic fallback for the customer.
 * Worst case here (max) stays far under gpt-5.6-luna's 128k output limit.
 */
const REASONING_HEADROOM: Record<ReasoningEffort, number> = {
  none: 0,
  low: 4_096,
  medium: 12_288,
  high: 24_576,
  xhigh: 32_768,
  max: 49_152,
};

export interface PrepareBodyOptions {
  reasoningSplit: boolean;
  thinkingDisabled: boolean;
  reasoningEffort: ReasoningEffort;
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
    // developers.openai.com/api/docs/models/gpt-5.6-luna (verified 2026-08-27):
    // supersedes gpt-5.4-mini as the cost-effective vision+tools default —
    // $0.20/$1.20 per million in/out, a 1.05M context window, and vision,
    // function calling and structured outputs all supported.
    defaultModel: 'gpt-5.6-luna',
    docsUrl: 'https://developers.openai.com/api/docs/models',
    supportsVision: () => true,
    supportsForcedToolChoice: true,
    // GPT-5.x / o-series speak a different request dialect from the classic
    // chat models. Translating here (rather than in agent.ts) keeps both body
    // builders — the agent loop and the /api/setup/test/llm probe — correct by
    // construction, and leaves non-reasoning OpenAI models untouched.
    prepareBody(body, opts) {
      if (!isReasoningModel(String(body.model ?? ''))) return;
      // Sent verbatim these are a hard 400, not a no-op.
      delete body.temperature;
      delete body.top_p;
      if (typeof body.max_tokens === 'number') {
        body.max_completion_tokens = body.max_tokens + REASONING_HEADROOM[opts.reasoningEffort];
        delete body.max_tokens;
      }
      body.reasoning_effort = opts.reasoningEffort;
    },
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
