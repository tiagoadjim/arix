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

/** Tool definitions advertised to Minimax on every completion request. */
export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = SPECS.map(
  (s) => s.definition,
);

export const toolNames: string[] = [...byName.keys()];

/** Execute a tool call by name; always returns a JSON string for the model. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const spec = byName.get(name);
  if (!spec) return JSON.stringify({ error: `tool desconocida: ${name}` });

  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ error: 'argumentos JSON inválidos', recibido: rawArgs });
  }

  try {
    const result = await spec.handler(args, ctx);
    return JSON.stringify(result);
  } catch (err) {
    logger.error({ err, name, args }, 'tool handler threw');
    return JSON.stringify({
      error: 'fallo interno ejecutando la tool',
      detalle: err instanceof Error ? err.message : String(err),
    });
  }
}
