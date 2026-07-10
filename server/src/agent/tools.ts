import type OpenAI from 'openai';
import { catalogTools } from '../skills/catalog';
import { orderTools } from '../skills/orders';
import { paymentTools } from '../skills/payments';
import { handoffTools } from '../skills/handoff';
import { logger } from '../logger';
import type { ToolSpec } from './tool-spec';
import type { ToolContext } from '../types';

const SPECS: ToolSpec[] = [...catalogTools, ...orderTools, ...paymentTools, ...handoffTools];

const byName = new Map<string, ToolSpec>(SPECS.map((s) => [s.definition.function.name, s]));

/** Tool definitions advertised to the configured LLM provider on every completion request. */
export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = SPECS.map(
  (s) => s.definition,
);

export const toolNames: string[] = [...byName.keys()];

/** Execute a tool call by name; always returns a JSON string for the model. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const spec = byName.get(name);
  if (!spec) return JSON.stringify({ error: 'unknown_tool' });

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawArgs ? JSON.parse(rawArgs) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return JSON.stringify({ error: 'invalid_tool_arguments' });
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'invalid_tool_arguments' });
  }

  try {
    const result = await spec.handler(args, ctx);
    return JSON.stringify(result);
  } catch (err) {
    if (ctx.signal?.aborted) {
      throw ctx.signal.reason instanceof Error
        ? ctx.signal.reason
        : new DOMException('The operation was aborted', 'AbortError');
    }
    // Tool arguments may contain customer email, order/payment data or other
    // secrets. Keep only shape/type in logs, and expose one stable code to the
    // model — never an arbitrary exception message from an integration.
    logger.error(
      {
        name,
        argKeys: Object.keys(args).sort().slice(0, 20),
        errorType: err instanceof Error ? err.name : typeof err,
      },
      'tool handler threw',
    );
    return JSON.stringify({ error: 'tool_execution_failed' });
  }
}
