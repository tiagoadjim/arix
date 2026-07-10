import type OpenAI from 'openai';
import { getLlm } from '../agent/llm/client';
import { buildSystemPrompt } from '../agent/prompt';
import { getToolDefinitions } from '../agent/tools';
import { businessProfile, complianceRules, hoursConfig, infoBlocks, woo, llm as resolveLlmSettings } from '../config/runtime';
import type { ToolContext } from '../types';

/**
 * Empirical cross-provider smoke probe against whichever LLM provider is
 * CURRENTLY CONFIGURED (uses whatever llm.api_key/llm.provider is resolved —
 * env seed or dashboard-saved). Prints the resolved provider + model up front,
 * then reports per-tool results generically instead of assuming MiniMax:
 *
 *  - reasoning_split OFF vs ON: MiniMax-specific (the M3 grounding regression
 *    this probe was originally written to catch). Only meaningful for
 *    `minimax` — skipped with a note for every other provider.
 *  - forced tool_choice: reflects `provider.supportsForcedToolChoice` instead
 *    of always assuming it works, so a "not supported" result isn't reported
 *    as a failure for providers that gate this off deliberately (gemini,
 *    deepseek — see agent/llm/providers.ts).
 *
 * Usage: pnpm probe-tools
 */

const ctx: ToolContext = {
  conversationId: 'probe',
  jid: '549000@s.whatsapp.net',
  phone: '549000',
  customerName: 'Probe',
  lastImage: null,
};

async function ask(
  chatComplete: Awaited<ReturnType<typeof getLlm>>['chatComplete'],
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  label: string,
  extra: Record<string, unknown>,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
): Promise<void> {
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming &
    Record<string, unknown> = {
    model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    temperature: 0.4,
    max_tokens: 4096, // match runAgent so inline <think> isn't truncated before the tool call
    ...extra,
  };
  try {
    const resp = await chatComplete(body);
    const msg = resp.choices[0]?.message;
    const toolName = msg?.tool_calls?.[0]?.type === 'function' ? msg.tool_calls[0].function.name : undefined;
    const called = toolName === 'search_catalog';
    console.log(
      `\n[${label}]\n  tool_call: ${toolName ?? '(none)'} ${called ? 'OK' : 'MISMATCH (expected: search_catalog)'}\n  content: ${JSON.stringify(msg?.content ?? '').slice(0, 200)}`,
    );
  } catch (err) {
    console.log(`\n[${label}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const [profile, schedule, blocks, rules, wooCfg, handle, llmSettings] = await Promise.all([
    businessProfile(),
    hoursConfig(),
    infoBlocks(),
    complianceRules(),
    woo(),
    getLlm(),
    resolveLlmSettings(),
  ]);

  console.log(`Probing provider="${handle.provider.id}" model="${handle.model}"`);

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

  const toolDefinitions = await getToolDefinitions();

  // reasoning_split is a MiniMax-specific quirk (see agent/llm/providers.ts);
  // only meaningful when that's the configured provider.
  if (handle.provider.id === 'minimax') {
    // The fix: no reasoning_split → expect a search_catalog tool_call.
    await ask(handle.chatComplete, handle.model, messages, 'reasoning_split OFF (fix)', {}, toolDefinitions);
    // The regression: reasoning_split on → expect degradation / no tool_call.
    await ask(handle.chatComplete, handle.model, messages, 'reasoning_split ON (regression)', {
      reasoning_split: true,
    }, toolDefinitions);
  } else {
    console.log(
      `\n[reasoning_split] skipped — MiniMax-specific quirk, not applicable to "${handle.provider.id}"`,
    );
    await ask(handle.chatComplete, handle.model, messages, 'baseline (no extra params)', {}, toolDefinitions);
  }

  // Does the provider honor a forced function choice? Decides the
  // grounding-lock fallback path in runAgent.
  if (handle.provider.supportsForcedToolChoice) {
    await ask(handle.chatComplete, handle.model, messages, 'tool_choice forced to search_catalog', {
      tool_choice: { type: 'function', function: { name: 'search_catalog' } },
    }, toolDefinitions);
  } else {
    console.log(
      `\n[tool_choice forced] skipped — provider.supportsForcedToolChoice is false for "${handle.provider.id}"; runAgent relies on the nudge alone`,
    );
  }

  // llmSettings carries the fields chatComplete() itself doesn't need to know
  // about (reasoning_split/thinking, vision_fallback) — surfaced here purely
  // for operator visibility while probing.
  console.log(
    `\nconfigured reasoningSplit=${llmSettings.reasoningSplit} thinkingDisabled=${llmSettings.thinkingDisabled} visionFallback=${llmSettings.visionFallback}`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
