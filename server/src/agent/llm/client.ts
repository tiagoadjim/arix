import OpenAI from 'openai';
import { llm as resolveLlm, settingsVersion } from '../../config/runtime';
import { logger } from '../../logger';
import { PROVIDERS, type ProviderId, type ProviderSpec } from './providers';

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatCompletionCreateParamsNonStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/**
 * Thrown by `chatComplete()` once it gives up on a request — either because
 * the error was never retryable (a validation/auth 4xx) or because all 3
 * attempts were exhausted. `retryable` tells the caller whether the failure
 * was a transient one (so it could, in principle, retry the whole turn later)
 * vs. a hard failure (bad request/auth) that will not recover on its own.
 */
export class LlmRequestError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, opts: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'LlmRequestError';
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

export interface LlmHandle {
  provider: ProviderSpec;
  model: string;
  /**
   * Bounded-retry wrapper around `client.chat.completions.create()`. Forced
   * `tool_choice` (or any other body field) is entirely the caller's
   * responsibility — this just passes `params` through after retry handling.
   */
  chatComplete(params: ChatCompletionCreateParamsNonStreaming & Record<string, unknown>): Promise<ChatCompletion>;
  /** Cleans up raw assistant text (delegates to provider.postprocess). */
  postprocess(text: string): string;
}

const MAX_ATTEMPTS = 3;
// Backoff BEFORE attempt 2 and attempt 3, respectively (index 0 → before the
// 2nd call, index 1 → before the 3rd call). No sleep after the final attempt.
const BACKOFF_MS: readonly number[] = [500, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Numeric HTTP status if `err` carries one (OpenAI SDK APIError shape),
 * else undefined — including for APIConnectionError-style network errors,
 * which the SDK constructs with `status: undefined`. */
function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/** 429, any 5xx, and anything with no HTTP status at all (network-level
 * failures — DNS, ECONNRESET, timeouts, etc.) are retryable. Any other
 * numbered 4xx (auth/validation) is not — retrying won't fix a bad request. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'LLM request failed';
}

async function callWithRetry(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming & Record<string, unknown>,
): Promise<ChatCompletion> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await client.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      const status = statusOf(err);
      if (!isRetryableStatus(status)) {
        throw new LlmRequestError(messageOf(err), { retryable: false, status, cause: err });
      }
      if (attempt < MAX_ATTEMPTS) {
        const delay = BACKOFF_MS[attempt - 1] ?? 500;
        logger.warn(
          { attempt, status, delay },
          'llm request failed — retrying after backoff',
        );
        await sleep(delay);
      }
    }
  }
  throw new LlmRequestError(messageOf(lastErr), {
    retryable: true,
    status: statusOf(lastErr),
    cause: lastErr,
  });
}

interface CachedHandle {
  version: number;
  handle: LlmHandle;
}

let cached: CachedHandle | null = null;

/**
 * Resolve the LLM handle from the runtime config service (settings table +
 * env seed), memoized until a settings write calls runtime.invalidate() — so
 * a dashboard save takes effect on the next turn with no restart. Replaces
 * the pre-Fase-4 single-provider getLlm(), reusing the exact same
 * cache-by-settingsVersion() pattern.
 */
export async function getLlm(): Promise<LlmHandle> {
  const version = settingsVersion();
  if (cached && cached.version === version) return cached.handle;

  const resolved = await resolveLlm();
  // `llm.provider` is a schema `enum` — runtime.ts's own parsing already
  // falls back to the schema default for any unrecognized raw value (DB/env),
  // so `resolved.provider` is always one of the 5 registered ids here; no
  // extra runtime guard needed.
  const providerId = resolved.provider as ProviderId;
  const provider = PROVIDERS[providerId];
  const model = resolved.model || provider.defaultModel;

  // A never-configured deployment still gets a usable client object back
  // (never null) — the OpenAI SDK requires a non-empty apiKey string to
  // construct. It's never actually called: handlers/messages.ts checks
  // `configured` before invoking the agent at all. maxRetries: 0 because we
  // own retries ourselves (see callWithRetry) — the SDK's own retry loop
  // would otherwise double up and mask our backoff/error-wrapping contract.
  const client = new OpenAI({
    apiKey: resolved.apiKey || 'unconfigured',
    baseURL: resolved.baseUrl || provider.baseURL,
    maxRetries: 0,
    // The SDK's default (600s) is unacceptable for a chat turn — bound it the
    // same way the setup-wizard credential-test client already does (15s
    // there; this is a real conversational request, so a slightly larger
    // budget) so a hung provider can't wedge a WhatsApp reply indefinitely.
    timeout: 60_000,
  });

  const handle: LlmHandle = {
    provider,
    model,
    async chatComplete(params) {
      const resp = await callWithRetry(client, params);
      if (resp.usage) {
        logger.info(
          {
            provider: provider.id,
            model,
            promptTokens: resp.usage.prompt_tokens,
            completionTokens: resp.usage.completion_tokens,
            totalTokens: resp.usage.total_tokens,
          },
          'llm usage',
        );
      }
      return resp;
    },
    postprocess: provider.postprocess,
  };
  cached = { version, handle };
  return handle;
}
