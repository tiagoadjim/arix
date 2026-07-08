import type OpenAI from 'openai';
import { minimax, MODEL, stripThinking } from './minimax';
import { buildSystemPrompt } from './prompt';
import { toolDefinitions, runTool } from './tools';
import { getGuardrails } from './guardrails';
import { config } from '../config';
import { logger } from '../logger';
import type { Message, ToolContext } from '../types';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_STEPS = 6;

const guardrails = getGuardrails(config.AGENT_LANGUAGE);

/** Map persisted conversation history into OpenAI chat messages. */
function historyToMessages(history: Message[], ctx: ToolContext): ChatMessage[] {
  const out: ChatMessage[] = [];
  history.forEach((m, idx) => {
    const isLast = idx === history.length - 1;
    if (m.sender === 'system') return; // internal notes are not model context

    if (m.direction === 'in') {
      // Customer turn. Attach the image only for the latest turn (we keep the
      // base64 in ctx.lastImage for the current message).
      if (isLast && ctx.lastImage) {
        const text = m.body?.trim() || guardrails.receiptCaption;
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

function finalText(content: OpenAI.Chat.Completions.ChatCompletionMessage['content']): string {
  return stripThinking(typeof content === 'string' ? content : '');
}

/**
 * Run the agent for one customer turn. `history` is the recent conversation
 * (chronological, last item = the message that just arrived). Returns the text
 * to send back to the customer (already stripped of <think> reasoning).
 */
export async function runAgent(
  ctx: ToolContext,
  history: Message[],
  settings: Record<string, string> = {},
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(ctx, settings) },
    ...historyToMessages(history, ctx),
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
    // Intersect with an index signature so we can attach MiniMax-only fields
    // (reasoning_split / thinking) that the OpenAI types don't know about; the
    // SDK forwards unknown body keys verbatim.
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming &
      Record<string, unknown> = {
      model: MODEL,
      messages,
      tools: toolDefinitions,
      temperature: 0.4,
      // Generous budget: M3 is a thinking model. With reasoning_split the visible
      // answer is shorter, but keep headroom so it isn't truncated (handled below).
      max_tokens: 4096,
    };
    // Keep the model's thinking OUT of `content` (it goes to separate
    // reasoning_content/reasoning_details fields) so it can never leak to the
    // customer. LLM_THINKING_DISABLED is an optional hard-off switch.
    if (config.LLM_REASONING_SPLIT) body.reasoning_split = true;
    if (config.LLM_THINKING_DISABLED) body.thinking = { type: 'disabled' };
    // Grounding lock forced a catalog lookup this round: make the model call it.
    if (forceCatalogNext) {
      body.tool_choice = { type: 'function', function: { name: 'search_catalog' } };
      forceCatalogNext = false; // one-shot
    }
    const resp = await minimax.chat.completions.create(body);

    const choice = resp.choices[0];
    if (!choice) return guardrails.fallback;
    const msg = choice.message;

    // Preserve the FULL assistant message (incl. any reasoning) in history —
    // required for M3's interleaved thinking across tool calls.
    messages.push(msg as unknown as ChatMessage);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // A truncated turn (finish_reason 'length') may hold an unclosed <think>
      // with no real answer — never surface that raw reasoning to the customer.
      if (choice.finish_reason === 'length') {
        logger.warn({ conversationId: ctx.conversationId }, 'agent reply truncated (max_tokens)');
        return guardrails.fallback;
      }
      const text = finalText(msg.content);
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
      logger.info({ tool: tc.function.name, args: tc.function.arguments }, 'agent tool call');
      if (tc.function.name === 'search_catalog' || tc.function.name === 'view_product') {
        catalogQueried = true; // product facts are now grounded in real data
      }
      const result = await runTool(tc.function.name, tc.function.arguments, ctx);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  logger.warn({ conversationId: ctx.conversationId }, 'agent hit MAX_STEPS without a final answer');
  return guardrails.maxStepsFallback;
}
