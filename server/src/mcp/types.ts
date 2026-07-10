import { createHash } from 'node:crypto';

/** Production MCP configuration. Only remote Streamable HTTP is accepted.
 * Spawning operator-provided stdio commands from the dashboard would turn a
 * staff session into arbitrary code execution inside the server container. */
export type McpTransport = 'http';

export const MAX_MCP_SERVERS = 10;
export const MAX_MCP_TOOLS_PER_SERVER = 50;
export const MAX_MCP_HEADERS = 20;

export interface McpServerConfig {
  /** Stable slug used in tool name prefixes — lowercase alphanumeric + `_`/`-`. */
  id: string;
  /** Human label shown in the dashboard. */
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** http: Streamable HTTP endpoint URL. */
  url: string;
  /** http: extra request headers (may hold secrets, e.g. Authorization). */
  headers?: Record<string, string>;
  /** Original MCP tool names that may be exposed to the model. Deny by
   * default: an empty list connects successfully but advertises no tools. */
  allowedTools: string[];
  /** Tools not explicitly annotated read-only are blocked unless an admin
   * enables this additional high-risk switch. */
  allowMutatingTools: boolean;
}

/** Dashboard-facing view: secret env/header values are never sent in plaintext. */
export interface McpServerDto {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  url: string;
  /** Header names present; values are never returned. */
  headerKeys: string[];
  allowedTools: string[];
  allowMutatingTools: boolean;
}

export interface McpToolInfo {
  serverId: string;
  /** Original tool name on the MCP server. */
  name: string;
  /** Namespaced name advertised to the LLM. */
  namespacedName: string;
  description?: string;
  readOnly: boolean;
}

// No consecutive underscores — `__` is the delimiter between server id and
// tool name in namespaced MCP tool names (`mcp_<id>__<tool>`).
const ID_RE = /^[a-z](?:[a-z0-9-]|_(?!_)){0,31}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isValidMcpServerId(id: string): boolean {
  return ID_RE.test(id);
}

function isSafeToolName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    [...value].every((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
  );
}

/** Namespace an MCP tool into an OpenAI-compatible function name (max 64
 * chars). A hash of the original pair prevents collisions after sanitizing. */
export function namespaceMcpTool(serverId: string, toolName: string): string {
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 10);
  const prefix = `mcp_${serverId}__`;
  const room = 64 - prefix.length - hash.length - 1;
  return `${prefix}${safeTool.slice(0, Math.max(1, room))}_${hash}`;
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_MCP_HEADERS)) {
    const lower = name.toLowerCase();
    if (
      typeof value === 'string' &&
      value.length <= 4096 &&
      HEADER_NAME_RE.test(name) &&
      !FORBIDDEN_HEADERS.has(lower)
    ) {
      headers[name] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeAllowedTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((value): value is string => typeof value === 'string' && isSafeToolName(value))
        .slice(0, MAX_MCP_TOOLS_PER_SERVER),
    ),
  ];
}

/** Coerce persisted JSON into a bounded config list. Invalid entries are
 * ignored at runtime; API writes use validateMcpServersInput and fail closed. */
export function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_MCP_SERVERS)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!isValidMcpServerId(id) || seen.has(id)) continue;
    if (o.transport !== 'http') continue;
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    if (!url) continue;
    seen.add(id);
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;
    const enabled = o.enabled !== false;
    out.push({
      id,
      name: name.slice(0, 100),
      enabled,
      transport: 'http',
      url,
      headers: normalizeHeaders(o.headers),
      allowedTools: normalizeAllowedTools(o.allowedTools),
      allowMutatingTools: o.allowMutatingTools === true,
    });
  }
  return out;
}

export type ValidateMcpServersResult =
  | { ok: true; servers: McpServerConfig[] }
  | { ok: false; errors: string[] };

/** Strict API boundary validation. Never silently drops malformed servers,
 * duplicate ids, unsafe headers or unsupported stdio transports. */
export function validateMcpServersInput(raw: unknown): ValidateMcpServersResult {
  if (!Array.isArray(raw)) return { ok: false, errors: ['mcp.servers must be an array'] };
  if (raw.length > MAX_MCP_SERVERS) {
    return { ok: false, errors: [`at most ${MAX_MCP_SERVERS} MCP servers are allowed`] };
  }
  const errors: string[] = [];
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`server ${index + 1}: invalid object`);
      return;
    }
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!isValidMcpServerId(id)) errors.push(`server ${index + 1}: invalid id`);
    else if (ids.has(id)) errors.push(`server ${index + 1}: duplicate id`);
    else ids.add(id);
    if (o.transport !== 'http') errors.push(`server ${id || index + 1}: only HTTP transport is supported`);
    if (typeof o.url !== 'string' || !o.url.trim()) errors.push(`server ${id || index + 1}: URL is required`);
    if (Array.isArray(o.allowedTools) && o.allowedTools.length > MAX_MCP_TOOLS_PER_SERVER) {
      errors.push(`server ${id || index + 1}: too many allowed tools`);
    }
    if (o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)) {
      const entries = Object.entries(o.headers as Record<string, unknown>);
      if (entries.length > MAX_MCP_HEADERS) errors.push(`server ${id || index + 1}: too many headers`);
      for (const [header, value] of entries) {
        if (
          !HEADER_NAME_RE.test(header) ||
          FORBIDDEN_HEADERS.has(header.toLowerCase()) ||
          typeof value !== 'string' ||
          value.length > 4096
        ) {
          errors.push(`server ${id || index + 1}: invalid or forbidden header "${header}"`);
        }
      }
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  const servers = normalizeMcpServers(raw);
  return servers.length === raw.length ? { ok: true, servers } : { ok: false, errors: ['invalid MCP configuration'] };
}

/** Strip secret values for the dashboard. */
export function toMcpServerDto(cfg: McpServerConfig): McpServerDto {
  return {
    id: cfg.id,
    name: cfg.name,
    enabled: cfg.enabled,
    transport: cfg.transport,
    url: cfg.url,
    headerKeys: Object.keys(cfg.headers ?? {}),
    allowedTools: [...cfg.allowedTools],
    allowMutatingTools: cfg.allowMutatingTools,
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
    const headers = { ...(next.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) {
      if (!v.trim() && prev.headers?.[k] !== undefined) headers[k] = prev.headers[k];
    }
    return {
      ...next,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  });
}
