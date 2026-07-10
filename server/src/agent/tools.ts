import type OpenAI from 'openai';
import { logger } from '../logger';
import type { ToolSpec } from './tool-spec';
import type { ToolContext } from '../types';
import { toolsForEnabledSkills } from '../skills/registry';
import { enabledSkills } from '../config/runtime';
import { getMcpToolDefinitions, runMcpTool } from '../mcp/manager';

/**
 * Dynamic tool registry: built-in skills (filtered by `skills.enabled`) plus
 * live MCP tools. Callers that need the OpenAI `tools:` array for a turn
 * should use {@link getToolDefinitions}; {@link runTool} dispatches to either
 * a built-in handler or an MCP server.
 */

function specsByName(specs: ToolSpec[]): Map<string, ToolSpec> {
  return new Map(specs.map((s) => [s.definition.function.name, s]));
}

async function builtinSpecs(): Promise<ToolSpec[]> {
  const enabled = await enabledSkills();
  return toolsForEnabledSkills(enabled);
}

/** Tool definitions advertised to the configured LLM on every completion. */
export async function getToolDefinitions(): Promise<
  OpenAI.Chat.Completions.ChatCompletionTool[]
> {
  const [builtin, mcp] = await Promise.all([builtinSpecs(), getMcpToolDefinitions()]);
  return [...builtin.map((s) => s.definition), ...mcp];
}

/** Names of currently-enabled built-in tools (excludes MCP). Useful for tests. */
export async function getBuiltinToolNames(): Promise<string[]> {
  const specs = await builtinSpecs();
  return specs.map((s) => s.definition.function.name);
}

/** Execute a tool call by name; always returns a JSON string for the model. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const specs = await builtinSpecs();
  const byName = specsByName(specs);
  const spec = byName.get(name);
  if (spec) {
    let args: Record<string, unknown>;
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: 'invalid JSON arguments', received: rawArgs });
    }
    try {
      const result = await spec.handler(args, ctx);
      return JSON.stringify(result);
    } catch (err) {
      logger.error({ err, name }, 'tool handler threw');
      return JSON.stringify({ error: 'internal error running the tool' });
    }
  }

  // Not a built-in — try MCP (namespaced mcp_<server>_<tool>).
  if (name.startsWith('mcp_')) {
    const mcpResult = await runMcpTool(name, rawArgs, { conversationId: ctx.conversationId });
    if (mcpResult !== null) return mcpResult;
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}

/**
 * Synchronous snapshot of ALL built-in tool names (ignoring enable/disable).
 * Kept for tests that assert the skill surface without spinning up settings.
 */
export { ALL_BUILTIN_TOOLS as _allBuiltinTools } from '../skills/registry';
