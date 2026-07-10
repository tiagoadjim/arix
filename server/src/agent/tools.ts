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
      // Tool arguments may contain customer email, order/payment data or
      // other secrets. Keep only shape/type in logs, and expose one stable
      // code to the model — never an arbitrary integration exception.
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

  // Not a built-in — try MCP (namespaced mcp_<server>_<tool>).
  if (name.startsWith('mcp_')) {
    if (ctx.signal?.aborted) {
      throw ctx.signal.reason instanceof Error
        ? ctx.signal.reason
        : new DOMException('The operation was aborted', 'AbortError');
    }
    const mcpResult = await runMcpTool(name, rawArgs, { conversationId: ctx.conversationId });
    if (mcpResult !== null) return mcpResult;
  }

  return JSON.stringify({ error: 'unknown_tool' });
}

/**
 * Synchronous snapshot of ALL built-in tool names (ignoring enable/disable).
 * Kept for tests that assert the skill surface without spinning up settings.
 */
export { ALL_BUILTIN_TOOLS as _allBuiltinTools } from '../skills/registry';
