'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { api, apiErrorMessage, type McpServerDto, type SettingDto, type SettingsUpdate } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { compactUpdates, findDto, isReadOnly, plainUpdate } from './settings-form-utils';

export type McpTransport = 'stdio' | 'http';

/** Form-local server row. Env/header values are only sent when the operator
 * types a new value; blank means "keep current" (server merges on save). */
export interface McpServerFormValues {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  argsText: string;
  /** KEY=value lines; blank value after `=` means keep current. */
  envText: string;
  cwd: string;
  url: string;
  /** Name: value lines; blank value means keep current. */
  headersText: string;
}

export interface McpFormValues {
  servers: McpServerFormValues[];
}

function parseArgs(text: string): string[] {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    const colon = trimmed.indexOf(':');
    let key = '';
    let value = '';
    if (eq > 0 && (colon < 0 || eq < colon)) {
      key = trimmed.slice(0, eq).trim();
      value = trimmed.slice(eq + 1).trim();
    } else if (colon > 0) {
      key = trimmed.slice(0, colon).trim();
      value = trimmed.slice(colon + 1).trim();
    } else {
      continue;
    }
    if (key) out[key] = value;
  }
  return out;
}

function envTextFromDto(dto: McpServerDto): string {
  // Keys only — values are never returned by the API.
  return (dto.envKeys ?? []).map((k) => `${k}=`).join('\n');
}

function headersTextFromDto(dto: McpServerDto): string {
  return (dto.headerKeys ?? []).map((k) => `${k}: `).join('\n');
}

function dtoToForm(dto: McpServerDto): McpServerFormValues {
  return {
    id: dto.id,
    name: dto.name,
    enabled: dto.enabled,
    transport: dto.transport === 'http' ? 'http' : 'stdio',
    command: dto.command ?? '',
    argsText: (dto.args ?? []).join(' '),
    envText: envTextFromDto(dto),
    cwd: dto.cwd ?? '',
    url: dto.url ?? '',
    headersText: headersTextFromDto(dto),
  };
}

function formToPayload(row: McpServerFormValues) {
  const base = {
    id: row.id.trim(),
    name: row.name.trim() || row.id.trim(),
    enabled: row.enabled,
    transport: row.transport,
  };
  if (row.transport === 'http') {
    return {
      ...base,
      url: row.url.trim(),
      headers: parseKvLines(row.headersText),
    };
  }
  return {
    ...base,
    command: row.command.trim(),
    args: parseArgs(row.argsText),
    env: parseKvLines(row.envText),
    cwd: row.cwd.trim() || undefined,
  };
}

export function initMcpValues(dtos: SettingDto[] | undefined): McpFormValues {
  const raw = findDto('mcp.servers', dtos)?.value;
  if (!Array.isArray(raw)) return { servers: [] };
  const servers: McpServerFormValues[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as McpServerDto;
    if (typeof o.id !== 'string') continue;
    servers.push(
      dtoToForm({
        id: o.id,
        name: typeof o.name === 'string' ? o.name : o.id,
        enabled: o.enabled !== false,
        transport: o.transport === 'http' ? 'http' : 'stdio',
        command: o.command,
        args: o.args,
        envKeys: Array.isArray(o.envKeys) ? o.envKeys : [],
        cwd: o.cwd,
        url: o.url,
        headerKeys: Array.isArray(o.headerKeys) ? o.headerKeys : [],
      }),
    );
  }
  return { servers };
}

export function buildMcpUpdates(values: McpFormValues, dtos: SettingDto[] | undefined): SettingsUpdate[] {
  const payload = values.servers
    .filter((s) => s.id.trim())
    .map(formToPayload);
  return compactUpdates([plainUpdate('mcp.servers', payload, dtos)]);
}

function emptyServer(): McpServerFormValues {
  return {
    id: '',
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    url: '',
    headersText: '',
  };
}

interface McpFieldsProps {
  values: McpFormValues;
  onChange: (values: McpFormValues) => void;
  dtos?: SettingDto[];
  disabled?: boolean;
}

/** MCP server list editor — shared by settings tab and setup wizard. */
export function McpFields({ values, onChange, dtos, disabled }: McpFieldsProps) {
  const { t } = useT();
  const locked = isReadOnly('mcp.servers', dtos);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  function setServers(servers: McpServerFormValues[]) {
    onChange({ servers });
  }

  function updateAt(index: number, patch: Partial<McpServerFormValues>) {
    setServers(values.servers.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function removeAt(index: number) {
    setServers(values.servers.filter((_, i) => i !== index));
  }

  async function runTest(row: McpServerFormValues) {
    setTestingId(row.id || row.name || 'new');
    setTestError(null);
    try {
      const result = await api.testMcp(formToPayload(row));
      if (result.ok) {
        const n = result.tools?.length ?? 0;
        toast.success(t.settings.mcp.testSuccessToast.replace('{n}', String(n)));
      } else {
        setTestError(result.error ?? t.settings.mcp.testErrorTitle);
        toast.error(result.error ?? t.settings.mcp.testErrorTitle);
      }
    } catch (err) {
      const msg = apiErrorMessage(err, t, t.settings.mcp.testErrorTitle);
      setTestError(msg);
      toast.error(msg);
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t.settings.mcp.description}</p>
      {locked && (
        <Badge variant="secondary" className="w-fit">
          {t.settings.setByEnvBadge}
        </Badge>
      )}

      {values.servers.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.settings.mcp.empty}</p>
      )}

      {values.servers.map((row, index) => {
        const key = `${row.id}-${index}`;
        const isTesting = testingId !== null && testingId === (row.id || row.name || 'new');
        return (
          <div key={key} className="flex flex-col gap-3 border-b border-border/60 pb-5 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(v) => updateAt(index, { enabled: v })}
                  disabled={disabled || locked}
                />
                <span className="text-sm font-medium">
                  {row.name || row.id || t.settings.mcp.newServerTitle}
                </span>
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
                  onChange={(e) => updateAt(index, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                  placeholder="github"
                  disabled={disabled || locked}
                />
                <p className="text-xs text-muted-foreground">{t.settings.mcp.idHint}</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`mcp-name-${index}`}>{t.settings.mcp.nameLabel}</Label>
                <Input
                  id={`mcp-name-${index}`}
                  value={row.name}
                  onChange={(e) => updateAt(index, { name: e.target.value })}
                  placeholder="GitHub"
                  disabled={disabled || locked}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t.settings.mcp.transportLabel}</Label>
              <Select
                value={row.transport}
                onValueChange={(v) => updateAt(index, { transport: v === 'http' ? 'http' : 'stdio' })}
                disabled={disabled || locked}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">{t.settings.mcp.transportStdio}</SelectItem>
                  <SelectItem value="http">{t.settings.mcp.transportHttp}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {row.transport === 'stdio' ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-cmd-${index}`}>{t.settings.mcp.commandLabel}</Label>
                  <Input
                    id={`mcp-cmd-${index}`}
                    value={row.command}
                    onChange={(e) => updateAt(index, { command: e.target.value })}
                    placeholder="npx"
                    disabled={disabled || locked}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-args-${index}`}>{t.settings.mcp.argsLabel}</Label>
                  <Input
                    id={`mcp-args-${index}`}
                    value={row.argsText}
                    onChange={(e) => updateAt(index, { argsText: e.target.value })}
                    placeholder="-y @modelcontextprotocol/server-github"
                    disabled={disabled || locked}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-env-${index}`}>{t.settings.mcp.envLabel}</Label>
                  <textarea
                    id={`mcp-env-${index}`}
                    value={row.envText}
                    onChange={(e) => updateAt(index, { envText: e.target.value })}
                    placeholder={'GITHUB_TOKEN=\nOTHER_KEY=value'}
                    rows={3}
                    disabled={disabled || locked}
                    className="min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                  <p className="text-xs text-muted-foreground">{t.settings.mcp.envHint}</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-cwd-${index}`}>{t.settings.mcp.cwdLabel}</Label>
                  <Input
                    id={`mcp-cwd-${index}`}
                    value={row.cwd}
                    onChange={(e) => updateAt(index, { cwd: e.target.value })}
                    placeholder="/optional/workdir"
                    disabled={disabled || locked}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-url-${index}`}>{t.settings.mcp.urlLabel}</Label>
                  <Input
                    id={`mcp-url-${index}`}
                    value={row.url}
                    onChange={(e) => updateAt(index, { url: e.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                    disabled={disabled || locked}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-headers-${index}`}>{t.settings.mcp.headersLabel}</Label>
                  <textarea
                    id={`mcp-headers-${index}`}
                    value={row.headersText}
                    onChange={(e) => updateAt(index, { headersText: e.target.value })}
                    placeholder={'Authorization: Bearer \nX-Api-Key: '}
                    rows={3}
                    disabled={disabled || locked}
                    className="min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                  <p className="text-xs text-muted-foreground">{t.settings.mcp.headersHint}</p>
                </div>
              </>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => void runTest(row)}
              disabled={disabled || locked || isTesting || !row.id.trim()}
            >
              {isTesting ? t.common.testing : t.common.testConnection}
            </Button>
          </div>
        );
      })}

      {testError && (
        <Alert variant="destructive">
          <AlertDescription>{testError}</AlertDescription>
        </Alert>
      )}

      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => setServers([...values.servers, emptyServer()])}
        disabled={disabled || locked}
      >
        <PlusIcon className="size-4" />
        {t.settings.mcp.addServer}
      </Button>
    </div>
  );
}
