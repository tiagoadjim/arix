import type OpenAI from 'openai';
import { minimax, MODEL } from '../agent/minimax';
import { buildSystemPrompt } from '../agent/prompt';
import { toolDefinitions } from '../agent/tools';
import type { ToolContext } from '../types';

/**
 * Empirical probe against the REAL MiniMax API (uses LLM_API_KEY).
 *
 * Confirms the regression + fix hands-on:
 *  - with reasoning_split OFF (the fix) M3 should call 'search_catalog' on a
 *    catalog question;
 *  - with reasoning_split ON (the regression) it tends to answer from parametric
 *    memory without a tool call.
 * Also checks whether MiniMax accepts tool_choice:{type:'function'} (decides the
 * grounding-lock fallback in runAgent).
 *
 * Usage: pnpm tsx src/scripts/probe-tools.ts
 */

const ctx: ToolContext = {
  conversationId: 'probe',
  jid: '549000@s.whatsapp.net',
  phone: '549000',
  customerName: 'Probe',
  lastImage: null,
};

const baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  { role: 'system', content: buildSystemPrompt(ctx, {}) },
  { role: 'user', content: '¿qué tienen en stock?' },
];

async function ask(
  label: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming &
    Record<string, unknown> = {
    model: MODEL,
    messages: baseMessages,
    tools: toolDefinitions,
    temperature: 0.4,
    max_tokens: 4096, // match runAgent so inline <think> isn't truncated before the tool call
    ...extra,
  };
  try {
    const resp = await minimax.chat.completions.create(body);
    const msg = resp.choices[0]?.message;
    const toolName = msg?.tool_calls?.[0]?.type === 'function' ? msg.tool_calls[0].function.name : undefined;
    const called = toolName === 'search_catalog';
    // eslint-disable-next-line no-console
    console.log(
      `\n[${label}]\n  tool_call: ${toolName ?? '(ninguno)'} ${called ? '✅' : '❌ (esperado: search_catalog)'}\n  content: ${JSON.stringify(msg?.content ?? '').slice(0, 200)}`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`\n[${label}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  // The fix: no reasoning_split → expect a search_catalog tool_call.
  await ask('reasoning_split OFF (fix)', {});
  // The regression: reasoning_split on → expect degradation / no tool_call.
  await ask('reasoning_split ON (regresión)', { reasoning_split: true });
  // Does MiniMax honor a forced function choice? Decides the grounding-lock path.
  await ask('tool_choice forzado a search_catalog', {
    tool_choice: { type: 'function', function: { name: 'search_catalog' } },
  });
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
