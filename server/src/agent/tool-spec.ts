import type OpenAI from 'openai';
import type { ToolContext, ToolResult } from '../types';

/**
 * An agent skill: the OpenAI function-tool `definition` advertised to the model,
 * plus the `handler` that runs when the model calls it. Handlers receive the
 * parsed arguments and the conversation `ctx` (so sensitive values like the
 * customer's phone come from the server, not the model).
 */
export interface ToolSpec {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
