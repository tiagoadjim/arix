import type OpenAI from 'openai';
import { getLlm, LlmRequestError, type LlmHandle } from './llm/client';
import { buildSystemPrompt } from './prompt';
import { toolDefinitions, runTool } from './tools';
import { getGuardrails, type Guardrails } from './guardrails';
import {
  businessProfile,
  complianceRules,
  hoursConfig,
  infoBlocks,
  woo,
  llm as resolveLlmSettings,
} from '../config/runtime';
import { config } from '../config';
import { logger } from '../logger';
import type { Message, ToolContext } from '../types';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_STEPS = 6;
/** Hard wall-clock budget for the whole turn: config, LLM retries/steps and tools. */
export const AGENT_TURN_BUDGET_MS = config.AGENT_TURN_TIMEOUT_MS;

export interface RunAgentOptions {
  /** Override used by deterministic tests; production uses AGENT_TURN_BUDGET_MS. */
  turnBudgetMs?: number;
  /** External lifecycle cancellation (takeover/shutdown). */
  signal?: AbortSignal;
}

class AgentTurnBudgetError extends Error {
  constructor(readonly budgetMs: number) {
    super(`agent turn exceeded its ${budgetMs}ms budget`);
    this.name = 'AgentTurnBudgetError';
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AgentTurnBudgetError(AGENT_TURN_BUDGET_MS);
}

/** Race any work against the shared turn signal and remove the listener when done. */
function withinTurnBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Whether the configured provider/model can see images, and what to do
 * instead when it can't (mirrors llm.vision_fallback). */
interface VisionOptions {
  supported: boolean;
  fallback: 'ask_details' | 'handoff';
}

/** Map persisted conversation history into OpenAI chat messages. */
function historyToMessages(
  history: Message[],
  ctx: ToolContext,
  guardrails: Guardrails,
  vision: VisionOptions,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  history.forEach((m, idx) => {
    const isLast = idx === history.length - 1;
    if (m.sender === 'system') return; // internal notes are not model context

    if (m.direction === 'in') {
      // Customer turn. Attach the image only for the latest turn (we keep the
      // base64 in ctx.lastImage for the current message) — and only when the
      // configured provider/model can actually see it.
      if (isLast && ctx.lastImage) {
        const text = m.body?.trim() || guardrails.receiptCaption;
        if (vision.supported) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${ctx.lastImage.mime};base64,${ctx.lastImage.base64}`,
                  detail: 'high',
                },
              },
            ],
          });
        } else {
          // No vision support: send the customer's text as-is (a real
          // message, kept clean), then a system note steering the model to
          // ask for the order number + amount paid, or hand off — per
          // llm.vision_fallback. The image itself is still stored/shown
          // elsewhere in the pipeline (receipts/orders flow) — only the LLM
          // request loses the bytes.
          out.push({ role: 'user', content: text });
          out.push({
            role: 'system',
            content:
              vision.fallback === 'handoff'
                ? guardrails.visionUnsupportedHandoff
                : guardrails.visionUnsupportedAskDetails,
          });
        }
      } else {
        const body = (m.body ?? '').trim();
        // Never emit empty content: an empty user turn makes the model hallucinate /
        // leak reasoning (the sticker/audio "wrong-language reply" bug).
        const content = body
          ? (m.msg_type === 'image' ? guardrails.imageAttachedPrefix : '') + body
          : guardrails.placeholderForMedia(m.msg_type);
        out.push({ role: 'user', content });
      }
    } else {
      // The agent's or a human agent's prior reply — both are "assistant" to the model.
      out.push({ role: 'assistant', content: m.body ?? '' });
    }
  });
  return out;
}

function finalText(
  handle: LlmHandle,
  content: OpenAI.Chat.Completions.ChatCompletionMessage['content'],
): string {
  return handle.postprocess(typeof content === 'string' ? content : '');
}

/** Log only the argument shape, never customer/order/payment values. */
export function toolArgumentKeys(rawArgs: string): string[] {
  try {
    const parsed: unknown = rawArgs ? JSON.parse(rawArgs) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed).sort().slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * Run the agent for one customer turn. `history` is the recent conversation
 * (chronological, last item = the message that just arrived). Returns the text
 * to send back to the customer (already stripped of <think> reasoning).
 *
 * Callers MUST check `(await llm()).configured` first (see
 * handlers/messages.ts) — this function assumes an LLM client is usable.
 */
export async function runAgent(
  ctx: ToolContext,
  history: Message[],
  options: RunAgentOptions = {},
): Promise<string> {
  const budgetMs = Math.max(1, options.turnBudgetMs ?? AGENT_TURN_BUDGET_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new AgentTurnBudgetError(budgetMs)), budgetMs);
  timeout.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  // Default to Spanish only if even runtime configuration cannot resolve
  // before the deadline. runAgentTurn updates this as soon as it knows the
  // configured language.
  const budgetState = { fallback: getGuardrails('es').fallback };
  try {
    return await withinTurnBudget(
      runAgentTurn(ctx, history, signal, budgetState),
      signal,
    );
  } catch (err) {
    if (signal.aborted || err instanceof AgentTurnBudgetError) {
      logger.warn(
        { conversationId: ctx.conversationId, budgetMs },
        'agent turn exceeded total time budget — returning the safe fallback',
      );
      return budgetState.fallback;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function runAgentTurn(
  ctx: ToolContext,
  history: Message[],
  signal: AbortSignal,
  budgetState: { fallback: string },
): Promise<string> {
  // Resolve everything the turn needs from the runtime config service once,
  // up front — memoized internally, so this is cheap after the first turn.
  const [profile, schedule, blocks, rules, wooCfg, handle, llmSettings] = await Promise.all([
    businessProfile(),
    hoursConfig(),
    infoBlocks(),
    complianceRules(),
    woo(),
    getLlm(),
    resolveLlmSettings(),
  ]);
  const guardrails = getGuardrails(profile.language);
  budgetState.fallback = guardrails.fallback;
  const vision: VisionOptions = {
    supported: handle.provider.supportsVision(handle.model),
    fallback: llmSettings.visionFallback,
  };

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(ctx, {
        businessName: profile.businessName,
        agentName: profile.agentName,
        language: profile.language,
        discloseBot: profile.discloseBot,
        timezone: profile.timezone,
        hoursSchedule: schedule,
        // WC_FRONT_URL is optional — fall back to the REST domain when unset.
        storefrontUrl: wooCfg.frontUrl || wooCfg.url,
        infoBlocks: blocks,
        complianceRules: rules,
      }),
    },
    ...historyToMessages(history, ctx, guardrails, vision),
  ];
  let retried = false; // allow one corrective retry if the reply looks garbled
  // Grounding lock: never let a product/price/stock fact reach the customer
  // unless it came from a catalog tool in THIS turn.
  let catalogQueried = false;
  let forcedCatalog = false; // one-shot: we already forced a catalog lookup
  let forceCatalogNext = false; // set tool_choice on the next request
  const lastCustomerText =
    [...history].reverse().find((m) => m.direction === 'in')?.body?.trim() ?? '';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    // Intersect with an index signature so providers can attach extra,
    // provider-specific request fields that the OpenAI types don't know
    // about (see llm/providers.ts::prepareBody); the SDK forwards unknown
    // body keys verbatim.
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming &
      Record<string, unknown> = {
      model: handle.model,
      messages,
      tools: toolDefinitions,
      temperature: 0.4,
      // Generous budget: thinking models need headroom so the answer isn't
      // truncated (handled below).
      max_tokens: 4096,
    };
    // Keep the model's thinking OUT of `content` (it goes to separate
    // reasoning_content/reasoning_details fields) so it can never leak to the
    // customer. Provider-specific request-shaping quirks live in the
    // provider registry (llm/providers.ts), not here.
    handle.provider.prepareBody(body, {
      reasoningSplit: llmSettings.reasoningSplit,
      thinkingDisabled: llmSettings.thinkingDisabled,
    });
    // Grounding lock forced a catalog lookup this round: make the model call it —
    // but only if the provider actually honors a forced function choice. Some
    // compat layers don't (see agent/llm/providers.ts); those rely on the
    // system-message nudge (forceCatalogNudge) alone.
    if (forceCatalogNext) {
      if (handle.provider.supportsForcedToolChoice) {
        body.tool_choice = { type: 'function', function: { name: 'search_catalog' } };
      }
      forceCatalogNext = false; // one-shot
    }

    let resp: OpenAI.Chat.Completions.ChatCompletion;
    try {
      resp = await handle.chatComplete(body, { signal, conversationId: ctx.conversationId });
    } catch (err) {
      // chatComplete() already retried internally (see llm/client.ts) — by
      // the time an error reaches here, further retries won't help. Fail
      // soft: the customer gets a friendly fallback instead of silence
      // (previously an unhandled throw from .create() would propagate all
      // the way up and the customer got nothing).
      if (err instanceof LlmRequestError) {
        logger.error(
          { err, conversationId: ctx.conversationId, retryable: err.retryable, status: err.status },
          'llm request failed — returning the safe fallback',
        );
        return guardrails.fallback;
      }
      throw err;
    }

    const choice = resp.choices[0];
    if (!choice) return guardrails.fallback;
    const msg = choice.message;

    // Preserve the FULL assistant message (incl. any reasoning) in history —
    // required for providers with interleaved thinking across tool calls.
    messages.push(msg as unknown as ChatMessage);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // A truncated turn (finish_reason 'length') may hold an unclosed <think>
      // with no real answer — never surface that raw reasoning to the customer.
      if (choice.finish_reason === 'length') {
        logger.warn({ conversationId: ctx.conversationId }, 'agent reply truncated (max_tokens)');
        return guardrails.fallback;
      }
      const text = finalText(handle, msg.content);
      // Backstop for a reply that's in the wrong language / leaked reasoning:
      // retry once with a firm reminder, and if it's still garbled send the
      // safe fallback rather than gibberish.
      if (text && guardrails.looksGarbled(text)) {
        if (!retried) {
          retried = true;
          logger.warn({ conversationId: ctx.conversationId }, 'agent reply looked garbled — retrying');
          // Drop the garbled assistant turn (just pushed) so the retry doesn't
          // anchor on / echo it, then nudge with a firm reminder.
          messages.pop();
          messages.push({ role: 'system', content: guardrails.garbledRetryNudge });
          continue;
        }
        logger.warn({ conversationId: ctx.conversationId }, 'agent reply still garbled — using fallback');
        return guardrails.fallback;
      }
      // Grounding lock: the customer asked about the catalog (or the reply states a
      // product/price/stock fact) but we never queried the catalog this turn — the
      // fact would be invented. Force a lookup once; if the model still won't, hedge.
      const ungrounded =
        !catalogQueried &&
        (guardrails.asksAboutCatalog(lastCustomerText) || guardrails.makesProductClaim(text));
      if (ungrounded) {
        if (!forcedCatalog) {
          forcedCatalog = true;
          forceCatalogNext = true;
          logger.warn(
            { conversationId: ctx.conversationId },
            'agent answered about products without a catalog lookup — forcing search_catalog',
          );
          messages.pop(); // drop the ungrounded reply so it isn't echoed
          messages.push({ role: 'system', content: guardrails.forceCatalogNudge });
          continue;
        }
        logger.warn(
          { conversationId: ctx.conversationId },
          'agent still ungrounded after forcing catalog — using safe fallback',
        );
        return guardrails.ungroundedFallback;
      }
      return text || guardrails.fallback;
    }

    for (const tc of toolCalls) {
      if (tc.type !== 'function') {
        // Every tool_call in the assistant message needs a matching tool result,
        // or the next request is invalid. Emit an error result for unknown types.
        messages.push({
          role: 'tool',
          tool_call_id: (tc as { id: string }).id,
          content: JSON.stringify({ error: 'unsupported tool type' }),
        });
        continue;
      }
      logger.info(
        { tool: tc.function.name, argKeys: toolArgumentKeys(tc.function.arguments) },
        'agent tool call',
      );
      if (tc.function.name === 'search_catalog' || tc.function.name === 'view_product') {
        catalogQueried = true; // product facts are now grounded in real data
      }
      const result = await withinTurnBudget(
        runTool(tc.function.name, tc.function.arguments, { ...ctx, signal }),
        signal,
      );
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  logger.warn({ conversationId: ctx.conversationId }, 'agent hit MAX_STEPS without a final answer');
  return guardrails.maxStepsFallback;
}
