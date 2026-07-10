'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import {
  api,
  apiErrorMessage,
  type McpServerDto,
  type McpToolInfo,
  type SettingDto,
  type SettingsUpdate,
} from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { compactUpdates, findDto, isReadOnly, plainUpdate } from './settings-form-utils';

const ID_RE = /^[a-z](?:[a-z0-9-]|_(?!_)){0,31}$/;
const MAX_SERVERS = 10;

export interface McpServerFormValues {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  /** `Name: value` lines. Blank values preserve stored secrets. */
  headersText: string;
  /** Original MCP tool names explicitly allowed for the customer-facing agent. */
  allowedTools: string[];
  allowMutatingTools: boolean;
}

export interface McpFormValues {
  servers: McpServerFormValues[];
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function dtoToForm(dto: McpServerDto): McpServerFormValues {
  return {
    id: dto.id,
    name: dto.name,
    enabled: dto.enabled,
    url: dto.url,
    headersText: (dto.headerKeys ?? []).map((key) => `${key}: `).join('\n'),
    allowedTools: Array.isArray(dto.allowedTools) ? dto.allowedTools : [],
    allowMutatingTools: dto.allowMutatingTools === true,
  };
}

function formToPayload(row: McpServerFormValues) {
  return {
    id: row.id.trim(),
    name: row.name.trim() || row.id.trim(),
    enabled: row.enabled,
    transport: 'http' as const,
    url: row.url.trim(),
    headers: parseHeaders(row.headersText),
    allowedTools: row.allowedTools,
    allowMutatingTools: row.allowMutatingTools,
  };
}

export function initMcpValues(dtos: SettingDto[] | undefined): McpFormValues {
  const raw = findDto('mcp.servers', dtos)?.value;
  if (!Array.isArray(raw)) return { servers: [] };
  return {
    servers: raw
      .filter((item): item is McpServerDto => Boolean(item && typeof item === 'object' && 'id' in item))
      .map(dtoToForm),
  };
}

export function buildMcpUpdates(
  values: McpFormValues,
  dtos: SettingDto[] | undefined,
): SettingsUpdate[] {
  return compactUpdates([
    plainUpdate('mcp.servers', values.servers.map(formToPayload), dtos),
  ]);
}

function emptyServer(): McpServerFormValues {
  return {
    id: '',
    name: '',
    enabled: true,
    url: '',
    headersText: '',
    allowedTools: [],
    allowMutatingTools: false,
  };
}

interface McpFieldsProps {
  values: McpFormValues;
  onChange: (values: McpFormValues) => void;
  dtos?: SettingDto[];
  disabled?: boolean;
}

/** Secure remote MCP editor. Arix intentionally supports only HTTPS
 * Streamable HTTP here: dashboard-configured stdio would be remote code
 * execution. Tools are deny-by-default until the admin explicitly selects
 * them after a successful discovery. */
export function McpFields({ values, onChange, dtos, disabled }: McpFieldsProps) {
  const { t } = useT();
  const locked = isReadOnly('mcp.servers', dtos);
  const [testingIndex, setTestingIndex] = useState<number | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Record<number, McpToolInfo[]>>({});
  const duplicateIds = new Set(
    values.servers
      .map((server) => server.id.trim())
      .filter((id, index, all) => id && all.indexOf(id) !== index),
  );

  function setServers(servers: McpServerFormValues[]) {
    onChange({ servers });
  }

  function updateAt(index: number, patch: Partial<McpServerFormValues>) {
    setServers(values.servers.map((server, current) => (current === index ? { ...server, ...patch } : server)));
  }

  function removeAt(index: number) {
    setServers(values.servers.filter((_, current) => current !== index));
    setDiscovered((current) => {
      const next: Record<number, McpToolInfo[]> = {};
      Object.entries(current).forEach(([rawIndex, tools]) => {
        const oldIndex = Number(rawIndex);
        if (oldIndex < index) next[oldIndex] = tools;
        else if (oldIndex > index) next[oldIndex - 1] = tools;
      });
      return next;
    });
  }

  function toggleTool(index: number, toolName: string, allowed: boolean) {
    const current = new Set(values.servers[index]?.allowedTools ?? []);
    if (allowed) current.add(toolName);
    else current.delete(toolName);
    updateAt(index, { allowedTools: [...current] });
  }

  async function runTest(row: McpServerFormValues, index: number) {
    setTestingIndex(index);
    setTestError(null);
    try {
      const result = await api.testMcp(formToPayload(row));
      if (result.ok) {
        const tools = result.tools ?? [];
        setDiscovered((current) => ({ ...current, [index]: tools }));
        toast.success(t.settings.mcp.testSuccessToast.replace('{n}', String(tools.length)));
      } else {
        const message = t.errors[result.error ?? ''] ?? t.settings.mcp.testErrorTitle;
        setTestError(message);
        toast.error(message);
      }
    } catch (err) {
      const message = apiErrorMessage(err, t, t.settings.mcp.testErrorTitle);
      setTestError(message);
      toast.error(message);
    } finally {
      setTestingIndex(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t.settings.mcp.description}</p>
      {locked && <Badge variant="secondary" className="w-fit">{t.settings.setByEnvBadge}</Badge>}
      {values.servers.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.settings.mcp.empty}</p>
      )}

      {values.servers.map((row, index) => {
        const idInvalid = Boolean(row.id && !ID_RE.test(row.id));
        const duplicate = duplicateIds.has(row.id);
        const rowInvalid = idInvalid || duplicate || !row.id || !row.url.startsWith('https://');
        const rowTools = discovered[index] ?? [];
        return (
          <div key={`${index}-${row.id}`} className="flex flex-col gap-3 border-b border-border/60 pb-5 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id={`mcp-enabled-${index}`}
                  checked={row.enabled}
                  onCheckedChange={(enabled) => updateAt(index, { enabled })}
                  disabled={disabled || locked}
                />
                <Label htmlFor={`mcp-enabled-${index}`}>
                  {row.name || row.id || t.settings.mcp.newServerTitle}
                </Label>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeAt(index)}
                disabled={disabled || locked}
                aria-label={t.settings.mcp.removeServer}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`mcp-id-${index}`}>{t.settings.mcp.idLabel}</Label>
                <Input
                  id={`mcp-id-${index}`}
                  value={row.id}
                  onChange={(event) => updateAt(index, { id: event.target.value.toLowerCase() })}
                  placeholder="github"
                  aria-invalid={idInvalid || duplicate}
                  disabled={disabled || locked}
                />
                <p className="text-xs text-muted-foreground">
                  {duplicate ? t.settings.mcp.duplicateId : t.settings.mcp.idHint}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`mcp-name-${index}`}>{t.settings.mcp.nameLabel}</Label>
                <Input
                  id={`mcp-name-${index}`}
                  value={row.name}
                  onChange={(event) => updateAt(index, { name: event.target.value })}
                  placeholder="GitHub"
                  disabled={disabled || locked}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`mcp-url-${index}`}>{t.settings.mcp.urlLabel}</Label>
              <Input
                id={`mcp-url-${index}`}
                value={row.url}
                onChange={(event) => updateAt(index, { url: event.target.value })}
                placeholder="https://mcp.example.com/mcp"
                aria-invalid={Boolean(row.url && !row.url.startsWith('https://'))}
                disabled={disabled || locked}
              />
              <p className="text-xs text-muted-foreground">{t.settings.mcp.urlHint}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`mcp-headers-${index}`}>{t.settings.mcp.headersLabel}</Label>
              <textarea
                id={`mcp-headers-${index}`}
                value={row.headersText}
                onChange={(event) => updateAt(index, { headersText: event.target.value })}
                placeholder="Authorization: Bearer …"
                rows={3}
                disabled={disabled || locked}
                className="min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">{t.settings.mcp.headersHint}</p>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => void runTest(row, index)}
              disabled={disabled || locked || testingIndex === index || rowInvalid}
            >
              {testingIndex === index ? t.common.testing : t.common.testConnection}
            </Button>

            {rowTools.length > 0 && (
              <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium">{t.settings.mcp.allowedToolsLabel}</legend>
                <p className="text-xs text-muted-foreground">{t.settings.mcp.allowedToolsHint}</p>
                {rowTools.map((tool) => (
                  <div key={tool.name} className="flex items-start justify-between gap-3">
                    <div>
                      <Label htmlFor={`mcp-tool-${index}-${tool.namespacedName}`} className="font-mono text-xs">
                        {tool.name}
                      </Label>
                      {tool.description && <p className="text-xs text-muted-foreground">{tool.description}</p>}
                      <Badge variant={tool.readOnly ? 'secondary' : 'warning'} className="mt-1">
                        {tool.readOnly ? t.settings.mcp.readOnlyTool : t.settings.mcp.mutatingTool}
                      </Badge>
                    </div>
                    <Switch
                      id={`mcp-tool-${index}-${tool.namespacedName}`}
                      checked={row.allowedTools.includes(tool.name)}
                      onCheckedChange={(allowed) => toggleTool(index, tool.name, allowed)}
                      disabled={disabled || locked || (!tool.readOnly && !row.allowMutatingTools)}
                    />
                  </div>
                ))}
                {rowTools.some((tool) => !tool.readOnly) && (
                  <div className="mt-2 flex items-start justify-between gap-3 border-t border-border pt-3">
                    <div>
                      <Label htmlFor={`mcp-mutating-${index}`}>{t.settings.mcp.allowMutatingLabel}</Label>
                      <p className="text-xs text-muted-foreground">{t.settings.mcp.allowMutatingHint}</p>
                    </div>
                    <Switch
                      id={`mcp-mutating-${index}`}
                      checked={row.allowMutatingTools}
                      onCheckedChange={(allowMutatingTools) =>
                        updateAt(index, {
                          allowMutatingTools,
                          allowedTools: allowMutatingTools
                            ? row.allowedTools
                            : row.allowedTools.filter(
                                (name) => rowTools.find((tool) => tool.name === name)?.readOnly,
                              ),
                        })
                      }
                      disabled={disabled || locked}
                    />
                  </div>
                )}
              </fieldset>
            )}
          </div>
        );
      })}

      {testError && <Alert variant="destructive"><AlertDescription>{testError}</AlertDescription></Alert>}

      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => setServers([...values.servers, emptyServer()])}
        disabled={disabled || locked || values.servers.length >= MAX_SERVERS}
      >
        <PlusIcon className="size-4" />
        {t.settings.mcp.addServer}
      </Button>
    </div>
  );
}
