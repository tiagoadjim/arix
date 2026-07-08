import type OpenAI from 'openai';
import { getLlm } from '../agent/minimax';
import { buildSystemPrompt } from '../agent/prompt';
import { toolDefinitions } from '../agent/tools';
import { businessProfile, complianceRules, hoursConfig, infoBlocks, woo } from '../config/runtime';
import type { ToolContext } from '../types';

/**
 * Empirical probe against the REAL configured LLM provider (uses whatever
 * llm.api_key is resolved — env seed or dashboard-saved).
 *
 * Confirms the regression + fix hands-on:
 *  - with reasoning_split OFF (the fix) M3 should call 'search_catalog' on a
 *    catalog question;
 *  - with reasoning_split ON (the regression) it tends to answer from parametric
 *    memory without a tool call.
 * Also checks whether the provider accepts tool_choice:{type:'function'} (decides
 * the grounding-lock fallback in runAgent).
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

async function ask(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  label: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming &
    Record<string, unknown> = {
    model,
    messages,
    tools: toolDefinitions,
    temperature: 0.4,
    max_tokens: 4096, // match runAgent so inline <think> isn't truncated before the tool call
    ...extra,
  };
  try {
    const resp = await client.chat.completions.create(body);
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
  const [profile, schedule, blocks, rules, wooCfg, llmCfg] = await Promise.all([
    businessProfile(),
    hoursConfig(),
    infoBlocks(),
    complianceRules(),
    woo(),
    getLlm(),
  ]);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: buildSystemPrompt(ctx, {
        businessName: profile.businessName,
        agentName: profile.agentName,
        language: profile.language,
        discloseBot: profile.discloseBot,
        timezone: profile.timezone,
        hoursSchedule: schedule,
        storefrontUrl: wooCfg.frontUrl || wooCfg.url,
        infoBlocks: blocks,
        complianceRules: rules,
      }),
    },
    { role: 'user', content: '¿qué tienen en stock?' },
  ];

  // The fix: no reasoning_split → expect a search_catalog tool_call.
  await ask(llmCfg.client, llmCfg.model, messages, 'reasoning_split OFF (fix)', {});
  // The regression: reasoning_split on → expect degradation / no tool_call.
  await ask(llmCfg.client, llmCfg.model, messages, 'reasoning_split ON (regresión)', {
    reasoning_split: true,
  });
  // Does the provider honor a forced function choice? Decides the grounding-lock path.
  await ask(llmCfg.client, llmCfg.model, messages, 'tool_choice forzado a search_catalog', {
    tool_choice: { type: 'function', function: { name: 'search_catalog' } },
  });
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
