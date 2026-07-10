import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type OpenAI from 'openai';
import { logger } from '../logger';
import { mcpServers as resolveMcpServers, settingsVersion } from '../config/runtime';
import {
  namespaceMcpTool,
  parseNamespacedMcpTool,
  type McpServerConfig,
  type McpToolInfo,
} from './types';

/**
 * Live MCP client pool. Connects to every enabled server from `mcp.servers`,
 * caches their tool lists, and exposes them as OpenAI function tools for the
 * agent loop. Reconnects automatically when settingsVersion() bumps.
 */

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  tools: McpToolInfo[];
  /** OpenAI-shaped definitions keyed by namespaced name. */
  definitions: Map<string, OpenAI.Chat.Completions.ChatCompletionTool>;
}

let cacheVersion = -1;
let pool: Map<string, ConnectedServer> = new Map();
let inflight: Promise<void> | null = null;

function jsonSchemaToParameters(
  schema: unknown,
): OpenAI.Chat.Completions.ChatCompletionTool['function']['parameters'] {
  if (schema && typeof schema === 'object') {
    return schema as OpenAI.Chat.Completions.ChatCompletionTool['function']['parameters'];
  }
  return { type: 'object', properties: {} };
}

async function connectOne(cfg: McpServerConfig): Promise<ConnectedServer | null> {
  const client = new Client({ name: 'arix', version: '0.1.0' }, { capabilities: {} });
  try {
    if (cfg.transport === 'stdio') {
      if (!cfg.command?.trim()) {
        logger.warn({ id: cfg.id }, 'mcp: stdio server missing command — skipped');
        return null;
      }
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
        cwd: cfg.cwd,
        stderr: 'pipe',
      });
      await client.connect(transport);
    } else {
      if (!cfg.url?.trim()) {
        logger.warn({ id: cfg.id }, 'mcp: http server missing url — skipped');
        return null;
      }
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers && Object.keys(cfg.headers).length > 0
          ? { headers: cfg.headers }
          : undefined,
      });
      await client.connect(transport);
    }

    const listed = await client.listTools();
    const tools: McpToolInfo[] = [];
    const definitions = new Map<string, OpenAI.Chat.Completions.ChatCompletionTool>();
    for (const tool of listed.tools ?? []) {
      const namespacedName = namespaceMcpTool(cfg.id, tool.name);
      tools.push({
        serverId: cfg.id,
        name: tool.name,
        namespacedName,
        description: tool.description,
      });
      definitions.set(namespacedName, {
        type: 'function',
        function: {
          name: namespacedName,
          description: tool.description
            ? `[MCP:${cfg.name}] ${tool.description}`
            : `MCP tool ${tool.name} from server ${cfg.name}`,
          parameters: jsonSchemaToParameters(tool.inputSchema),
        },
      });
    }

    logger.info(
      { id: cfg.id, transport: cfg.transport, toolCount: tools.length },
      'mcp: connected',
    );
    return { config: cfg, client, tools, definitions };
  } catch (err) {
    logger.warn({ err, id: cfg.id, transport: cfg.transport }, 'mcp: failed to connect');
    try {
      await client.close();
    } catch {
      // ignore close errors on a failed connect
    }
    return null;
  }
}

async function closePool(previous: Map<string, ConnectedServer>): Promise<void> {
  for (const [id, conn] of previous) {
    try {
      await conn.client.close();
    } catch (err) {
      logger.warn({ err, id }, 'mcp: error closing client');
    }
  }
}

async function refresh(): Promise<void> {
  const version = settingsVersion();
  const configs = (await resolveMcpServers()).filter((s) => s.enabled);
  const previous = pool;
  const next = new Map<string, ConnectedServer>();

  for (const cfg of configs) {
    const conn = await connectOne(cfg);
    if (conn) next.set(cfg.id, conn);
  }

  pool = next;
  cacheVersion = version;
  // Close old connections after the new pool is live so in-flight tool calls
  // on the previous pool aren't interrupted mid-turn if possible.
  void closePool(previous);
}

async function ensureFresh(): Promise<void> {
  if (cacheVersion === settingsVersion() && !inflight) return;
  if (!inflight) {
    inflight = refresh()
      .catch((err) => {
        logger.error({ err }, 'mcp: refresh failed');
      })
      .finally(() => {
        inflight = null;
      });
  }
  await inflight;
}

/** Force a reconnect on the next ensureFresh() — called after settings writes. */
export function invalidateMcpPool(): void {
  cacheVersion = -1;
}

/** OpenAI tool definitions from every connected MCP server. */
export async function getMcpToolDefinitions(): Promise<
  OpenAI.Chat.Completions.ChatCompletionTool[]
> {
  await ensureFresh();
  const out: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  for (const conn of pool.values()) {
    for (const def of conn.definitions.values()) out.push(def);
  }
  return out;
}

export async function listMcpTools(): Promise<McpToolInfo[]> {
  await ensureFresh();
  const out: McpToolInfo[] = [];
  for (const conn of pool.values()) out.push(...conn.tools);
  return out;
}

export async function listConnectedServerIds(): Promise<string[]> {
  await ensureFresh();
  return [...pool.keys()];
}

/** Probe a single (possibly unsaved) config — used by the dashboard "Test" button. */
export async function testMcpServer(
  cfg: McpServerConfig,
): Promise<{ ok: boolean; error?: string; tools?: McpToolInfo[] }> {
  const conn = await connectOne(cfg);
  if (!conn) {
    return { ok: false, error: 'Could not connect to the MCP server.' };
  }
  const tools = conn.tools;
  try {
    await conn.client.close();
  } catch {
    // ignore
  }
  return { ok: true, tools };
}

/** Execute a namespaced MCP tool call; returns a JSON string for the model. */
export async function runMcpTool(namespacedName: string, rawArgs: string): Promise<string | null> {
  const parsed = parseNamespacedMcpTool(namespacedName);
  if (!parsed) return null;

  await ensureFresh();
  const conn = pool.get(parsed.serverId);
  if (!conn) {
    return JSON.stringify({ error: `mcp server not connected: ${parsed.serverId}` });
  }

  // Resolve the original tool name from our cache (namespaced form may have
  // sanitized characters — match via the definitions map key).
  const info = conn.tools.find((t) => t.namespacedName === namespacedName);
  const toolName = info?.name ?? parsed.toolName;

  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ error: 'invalid JSON arguments', received: rawArgs });
  }

  try {
    const result = await conn.client.callTool({ name: toolName, arguments: args });
    // Prefer structured content when present; otherwise flatten text parts.
    if (result.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent);
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const texts = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
      .map((c) => c.text);
    if (texts.length === 1) return texts[0]!;
    if (texts.length > 1) return JSON.stringify({ texts });
    return JSON.stringify(result.content ?? { ok: true });
  } catch (err) {
    logger.error({ err, serverId: parsed.serverId, tool: toolName }, 'mcp: tool call failed');
    return JSON.stringify({
      error: 'mcp tool call failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
