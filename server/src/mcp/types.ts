/**
 * Operator-configured MCP (Model Context Protocol) servers. Each enabled
 * server contributes its tools to the agent under a namespaced tool name
 * (`mcp_<serverId>_<toolName>`) so they never collide with built-in skills.
 */

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  /** Stable slug used in tool name prefixes — lowercase alphanumeric + `_`/`-`. */
  id: string;
  /** Human label shown in the dashboard. */
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: argv after the command. */
  args?: string[];
  /** stdio: extra env vars for the child process (may hold secrets). */
  env?: Record<string, string>;
  /** stdio: working directory. */
  cwd?: string;
  /** http: Streamable HTTP endpoint URL. */
  url?: string;
  /** http: extra request headers (may hold secrets, e.g. Authorization). */
  headers?: Record<string, string>;
}

/** Dashboard-facing view: secret env/header values are never sent in plaintext. */
export interface McpServerDto {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  /** Env keys present; values are never returned. */
  envKeys: string[];
  cwd?: string;
  url?: string;
  /** Header names present; values are never returned. */
  headerKeys: string[];
}

export interface McpToolInfo {
  serverId: string;
  /** Original tool name on the MCP server. */
  name: string;
  /** Namespaced name advertised to the LLM. */
  namespacedName: string;
  description?: string;
}

// No consecutive underscores — `__` is the delimiter between server id and
// tool name in namespaced MCP tool names (`mcp_<id>__<tool>`).
const ID_RE = /^[a-z](?:[a-z0-9-]|_(?!_)){0,63}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_RE.test(id);
}

/** Namespace an MCP tool so it can't collide with built-in skill tool names.
 * Format: `mcp_<serverId>__<toolName>` — double underscore separates the id
 * from the tool so server ids may themselves contain single underscores. */
export function namespaceMcpTool(serverId: string, toolName: string): string {
  // OpenAI function names: letters, digits, `_`, `-` — replace anything else.
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp_${serverId}__${safeTool}`;
}

export function parseNamespacedMcpTool(
  namespaced: string,
): { serverId: string; toolName: string } | null {
  if (!namespaced.startsWith('mcp_')) return null;
  const rest = namespaced.slice('mcp_'.length);
  const idx = rest.indexOf('__');
  if (idx <= 0) return null;
  return { serverId: rest.slice(0, idx), toolName: rest.slice(idx + 2) };
}

/** Coerce unknown JSON into a clean McpServerConfig list. Drops invalid entries. */
export function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!isValidMcpServerId(id) || seen.has(id)) continue;
    seen.add(id);
    const transport: McpTransport = o.transport === 'http' ? 'http' : 'stdio';
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;
    const enabled = o.enabled !== false;
    const cfg: McpServerConfig = { id, name, enabled, transport };
    if (typeof o.command === 'string') cfg.command = o.command;
    if (Array.isArray(o.args)) cfg.args = o.args.filter((a): a is string => typeof a === 'string');
    if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      cfg.env = env;
    }
    if (typeof o.cwd === 'string') cfg.cwd = o.cwd;
    if (typeof o.url === 'string') cfg.url = o.url;
    if (o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
      cfg.headers = headers;
    }
    out.push(cfg);
  }
  return out;
}

/** Strip secret values for the dashboard. */
export function toMcpServerDto(cfg: McpServerConfig): McpServerDto {
  return {
    id: cfg.id,
    name: cfg.name,
    enabled: cfg.enabled,
    transport: cfg.transport,
    command: cfg.command,
    args: cfg.args,
    envKeys: Object.keys(cfg.env ?? {}),
    cwd: cfg.cwd,
    url: cfg.url,
    headerKeys: Object.keys(cfg.headers ?? {}),
  };
}

/**
 * Merge an incoming (possibly partial / redacted) server list with the
 * previously stored one so blank env/header values mean "keep current".
 * Mirrors the secret-field keep-current rule used elsewhere in settings.
 */
export function mergeMcpServers(
  incoming: McpServerConfig[],
  previous: McpServerConfig[],
): McpServerConfig[] {
  const prevById = new Map(previous.map((s) => [s.id, s]));
  return incoming.map((next) => {
    const prev = prevById.get(next.id);
    if (!prev) return next;
    const env = { ...(next.env ?? {}) };
    for (const [k, v] of Object.entries(env)) {
      if (!v.trim() && prev.env?.[k] !== undefined) env[k] = prev.env[k];
    }
    // Keys present on prev but omitted from next (dashboard only sends typed
    // keys) — keep them when the dashboard sent the key list via empty values.
    // If the dashboard omitted a key entirely, treat it as removed.
    const headers = { ...(next.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) {
      if (!v.trim() && prev.headers?.[k] !== undefined) headers[k] = prev.headers[k];
    }
    return {
      ...next,
      env: Object.keys(env).length > 0 ? env : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  });
}
