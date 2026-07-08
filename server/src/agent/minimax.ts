import OpenAI from 'openai';
import { llm as resolveLlm, settingsVersion } from '../config/runtime';

// Fallback default for a single-provider (MiniMax) setup — used only when the
// resolved `llm.model` / `llm.base_url` are empty ("use the provider
// default"). Phase 4 replaces this whole file with a multi-provider registry
// (server/src/agent/llm/{providers,client}.ts) that owns a default per
// provider; these two constants are this file's entire "provider knowledge".
const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = 'MiniMax-M3';

export interface LlmSnapshot {
  client: OpenAI;
  model: string;
  reasoningSplit: boolean;
  thinkingDisabled: boolean;
}

let cached: (LlmSnapshot & { version: number }) | null = null;

/**
 * Resolve the LLM client from the runtime config service (settings table +
 * env seed), memoized until a settings write calls runtime.invalidate() —
 * so a dashboard save takes effect on the next turn with no restart.
 */
export async function getLlm(): Promise<LlmSnapshot> {
  const version = settingsVersion();
  if (cached && cached.version === version) return cached;

  const resolved = await resolveLlm();
  const snapshot: LlmSnapshot & { version: number } = {
    version,
    // A never-configured deployment still gets a client object back (never
    // null) — the OpenAI SDK requires a non-empty apiKey string to construct.
    // It's never actually called: handlers/messages.ts checks `configured`
    // before invoking the agent at all.
    client: new OpenAI({
      apiKey: resolved.apiKey || 'unconfigured',
      baseURL: resolved.baseUrl || DEFAULT_BASE_URL,
    }),
    model: resolved.model || DEFAULT_MODEL,
    reasoningSplit: resolved.reasoningSplit,
    thinkingDisabled: resolved.thinkingDisabled,
  };
  cached = snapshot;
  return snapshot;
}

/**
 * M3 is a thinking model: when reasoning is inlined it wraps it in
 * <think>...</think> inside `content`. Strip it before sending to a human.
 * (The raw, unstripped message is still kept in the conversation history that
 * we pass back to the model — preserving the reasoning chain as M3 requires.)
 */
export function stripThinking(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // complete reasoning blocks
    .replace(/<think>[\s\S]*$/i, '') // trailing UNCLOSED block (truncated output) → drop to end
    .replace(/<\/?think>/gi, '') // stray tags
    .trim();
}
