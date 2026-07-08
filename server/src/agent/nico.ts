import type OpenAI from 'openai';
import { minimax, MODEL, stripThinking } from './minimax';
import { buildSystemPrompt } from './prompt';
import { toolDefinitions, runTool } from './tools';
import { config } from '../config';
import { logger } from '../logger';
import type { Message, MessageType, ToolContext } from '../types';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_STEPS = 6;
const FALLBACK =
  'Perdón, tuve un problemita para procesar eso 🙈. ¿Lo podés repetir? Si seguís con problemas, te paso con una persona del equipo.';
// Sent when the model insists on talking about products without ever querying the
// catalog (even after we force the tool): better a hedge than a fabricated price/stock.
const UNGROUNDED_FALLBACK =
  'Uy, dejame chequear bien el stock y los precios y te confirmo al toque 🙏';

/**
 * A non-text message (sticker, audio, …) arrives with no body. Feeding the model
 * an empty user turn makes M3 (a thinking model) emit degenerate output / leaked
 * reasoning, sometimes in another language. Give it a clear note instead so it
 * answers naturally (the prompt tells Nico not to echo these bracketed notes).
 */
function placeholderForMedia(type: MessageType): string {
  switch (type) {
    case 'audio':
      return '[El cliente te envió un mensaje de audio que no podés escuchar]';
    case 'sticker':
      return '[El cliente te envió un sticker]';
    case 'video':
      return '[El cliente te envió un video]';
    case 'image':
      return '[El cliente te envió una imagen]';
    case 'document':
      return '[El cliente te envió un archivo]';
    default:
      return '[El cliente te envió un mensaje que no podés interpretar]';
  }
}

// Cyrillic, Greek, Hiragana/Katakana, CJK and Hangul — none of which a
// Spanish-speaking customer ever legitimately receives. Used as a backstop to
// catch leaked reasoning / wrong-language replies that slip past reasoning_split.
const SUSPECT_SCRIPT =
  /[Ѐ-ԯͰ-Ͽ぀-ヿ㐀-䶿一-鿿가-힣]/;

/** True if a would-be reply looks like leaked reasoning or the wrong language. */
function looksGarbled(text: string): boolean {
  if (!text) return false;
  if (SUSPECT_SCRIPT.test(text)) return true; // non-Latin script → not Spanish
  if (/<\/?think>/i.test(text)) return true; // leftover reasoning tag
  return false;
}

// The customer is asking about the catalog (what's in stock, prices, flavors,
// brands/models…) — a turn that MUST be answered from 'buscar_catalogo', never
// from the model's memory.
const ASKS_CATALOG =
  /\b(qu[eé]\s+(tienen|hay|ten[eé]s)|ten[eé]s|tienen|hay|precio|precios|cu[aá]nto|sale|cuesta|stock|disponib|sabor|sabores|marca|marcas|modelo|vape|vapes|pod|pods|descartab|elf\s*bar|recomend[aá])/i;

// The reply is asserting a concrete product fact (a price, a stock status, a
// "we have/carry"): if it wasn't grounded in a catalog lookup it may be invented.
const CLAIMS_PRODUCT =
  /(\$\s*\d|\d\s*(pesos|mil)|en\s+stock|sin\s+stock|disponible|tenemos|contamos\s+con)/i;

/** Customer intent that requires a catalog lookup before answering. */
function asksAboutCatalog(text: string): boolean {
  return !!text && ASKS_CATALOG.test(text);
}

/** A reply that states a product/price/stock fact (grounded or not). */
function makesProductClaim(text: string): boolean {
  return !!text && CLAIMS_PRODUCT.test(text);
}

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
        const text = m.body?.trim() || 'Te mando el comprobante de la transferencia.';
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
        // Never emit empty content: an empty user turn makes M3 hallucinate /
        // leak reasoning (the sticker/audio "responde en ruso" bug).
        const content = body
          ? (m.msg_type === 'image' ? '[imagen adjunta] ' : '') + body
          : placeholderForMedia(m.msg_type);
        out.push({ role: 'user', content });
      }
    } else {
      // Nico's or a human agent's prior reply — both are "assistant" to the model.
      out.push({ role: 'assistant', content: m.body ?? '' });
    }
  });
  return out;
}

function finalText(content: OpenAI.Chat.Completions.ChatCompletionMessage['content']): string {
  return stripThinking(typeof content === 'string' ? content : '');
}

/**
 * Run Nico for one customer turn. `history` is the recent conversation
 * (chronological, last item = the message that just arrived). Returns the text
 * to send back to the customer (already stripped of <think> reasoning).
 */
export async function runNico(
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
    // customer. MINIMAX_THINKING_DISABLED is an optional hard-off switch.
    if (config.MINIMAX_REASONING_SPLIT) body.reasoning_split = true;
    if (config.MINIMAX_THINKING_DISABLED) body.thinking = { type: 'disabled' };
    // Grounding lock forced a catalog lookup this round: make the model call it.
    if (forceCatalogNext) {
      body.tool_choice = { type: 'function', function: { name: 'buscar_catalogo' } };
      forceCatalogNext = false; // one-shot
    }
    const resp = await minimax.chat.completions.create(body);

    const choice = resp.choices[0];
    if (!choice) return FALLBACK;
    const msg = choice.message;

    // Preserve the FULL assistant message (incl. any reasoning) in history —
    // required for M3's interleaved thinking across tool calls.
    messages.push(msg as unknown as ChatMessage);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // A truncated turn (finish_reason 'length') may hold an unclosed <think>
      // with no real answer — never surface that raw reasoning to the customer.
      if (choice.finish_reason === 'length') {
        logger.warn({ conversationId: ctx.conversationId }, 'Nico reply truncated (max_tokens)');
        return FALLBACK;
      }
      const text = finalText(msg.content);
      // Backstop for a reply that's non-Spanish / leaked reasoning: retry once
      // with a firm reminder, and if it's still garbled send the safe fallback
      // rather than gibberish.
      if (text && looksGarbled(text)) {
        if (!retried) {
          retried = true;
          logger.warn({ conversationId: ctx.conversationId }, 'Nico reply looked garbled — retrying');
          // Drop the garbled assistant turn (just pushed) so the retry doesn't
          // anchor on / echo it, then nudge with a firm reminder.
          messages.pop();
          messages.push({
            role: 'system',
            content:
              'IMPORTANTE: respondé ÚNICAMENTE en español rioplatense, solo con el mensaje final para el cliente, sin razonamiento, sin otro idioma ni otro alfabeto.',
          });
          continue;
        }
        logger.warn({ conversationId: ctx.conversationId }, 'Nico reply still garbled — using fallback');
        return FALLBACK;
      }
      // Grounding lock: the customer asked about the catalog (or the reply states a
      // product/price/stock fact) but we never queried the catalog this turn — the
      // fact would be invented. Force a lookup once; if the model still won't, hedge.
      const ungrounded =
        !catalogQueried && (asksAboutCatalog(lastCustomerText) || makesProductClaim(text));
      if (ungrounded) {
        if (!forcedCatalog) {
          forcedCatalog = true;
          forceCatalogNext = true;
          logger.warn(
            { conversationId: ctx.conversationId },
            'Nico answered about products without a catalog lookup — forcing buscar_catalogo',
          );
          messages.pop(); // drop the ungrounded reply so it isn't echoed
          messages.push({
            role: 'system',
            content:
              'IMPORTANTE: no des nombres de productos, precios, stock ni sabores sin consultar el catálogo real. Llamá a buscar_catalogo y respondé SOLO con lo que devuelva.',
          });
          continue;
        }
        logger.warn(
          { conversationId: ctx.conversationId },
          'Nico still ungrounded after forcing catalog — using safe fallback',
        );
        return UNGROUNDED_FALLBACK;
      }
      return text || FALLBACK;
    }

    for (const tc of toolCalls) {
      if (tc.type !== 'function') {
        // Every tool_call in the assistant message needs a matching tool result,
        // or the next request is invalid. Emit an error result for unknown types.
        messages.push({
          role: 'tool',
          tool_call_id: (tc as { id: string }).id,
          content: JSON.stringify({ error: 'tipo de tool no soportado' }),
        });
        continue;
      }
      logger.info({ tool: tc.function.name, args: tc.function.arguments }, 'Nico tool call');
      if (tc.function.name === 'buscar_catalogo' || tc.function.name === 'ver_producto') {
        catalogQueried = true; // product facts are now grounded in real data
      }
      const result = await runTool(tc.function.name, tc.function.arguments, ctx);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  logger.warn({ conversationId: ctx.conversationId }, 'Nico hit MAX_STEPS without a final answer');
  return 'Dame un momentito que estoy procesando tu consulta 🙏';
}
