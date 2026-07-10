'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActivityIcon,
  ArrowLeftIcon,
  BotIcon,
  CoinsIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { AuditEvent, UsageSummaryRow } from '@/lib/types';
import { usePolling } from '@/hooks/usePolling';
import { useServerEvents } from '@/hooks/useServerEvents';
import { useT } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Period = 7 | 30 | 90;

interface AnalyticsSnapshot {
  usage: UsageSummaryRow[];
  audit: AuditEvent[];
  metrics: string;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export default function AnalyticsPage() {
  const { t, locale } = useT();
  const [period, setPeriod] = useState<Period>(30);
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      try {
        const [usage, audit, metrics] = await Promise.all([
          api.usage(period, signal),
          api.audit(100, signal),
          api.metrics(signal),
        ]);
        if (signal.aborted) return;
        setSnapshot({ usage: usage.rows, audit: audit.events, metrics });
        setFailed(false);
      } catch {
        if (!signal.aborted) setFailed(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [period],
  );

  const polling = usePolling(load, 30_000, { restartKey: period });
  useServerEvents(() => polling.refresh());

  const totals = useMemo(
    () =>
      (snapshot?.usage ?? []).reduce(
        (sum, row) => ({
          requests: sum.requests + finite(row.requests),
          prompt: sum.prompt + finite(row.prompt_tokens),
          completion: sum.completion + finite(row.completion_tokens),
          tokens: sum.tokens + finite(row.total_tokens),
          cost: sum.cost + finite(row.estimated_cost_usd),
        }),
        { requests: 0, prompt: 0, completion: 0, tokens: 0, cost: 0 },
      ),
    [snapshot],
  );

  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const currency = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }),
    [locale],
  );
  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  return (
    <div className="h-full overflow-y-auto" aria-busy={loading}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <Button variant="ghost" size="icon-sm" asChild className="mt-0.5 shrink-0 md:hidden">
              <Link href="/" aria-label={t.sidebar.backToInbox} title={t.sidebar.backToInbox}>
                <ArrowLeftIcon className="size-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl font-semibold">{t.analytics.pageTitle}</h1>
              <p className="text-sm text-muted-foreground">{t.analytics.pageDescription}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="analytics-period">
              {t.analytics.periodLabel}
            </label>
            <Select
              value={String(period)}
              onValueChange={(value) => setPeriod(value === '7' ? 7 : value === '90' ? 90 : 30)}
            >
              <SelectTrigger id="analytics-period" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t.analytics.days7}</SelectItem>
                <SelectItem value="30">{t.analytics.days30}</SelectItem>
                <SelectItem value="90">{t.analytics.days90}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={polling.refresh}
              disabled={loading}
              aria-label={t.common.refresh}
              title={t.common.refresh}
            >
              <RefreshCwIcon className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </header>

        {failed && (
          <Alert variant="destructive">
            <AlertDescription className="flex w-full flex-row items-center justify-between gap-3">
              <span>{t.analytics.refreshFailed}</span>
              <Button variant="outline" size="xs" onClick={polling.refresh} disabled={loading}>
                {t.common.retry}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {snapshot === null ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t.common.loading}>
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-live="polite">
            <SummaryCard icon={BotIcon} label={t.analytics.totalRequests} value={number.format(totals.requests)} />
            <SummaryCard icon={ActivityIcon} label={t.analytics.totalTokens} value={number.format(totals.tokens)} />
            <SummaryCard icon={CoinsIcon} label={t.analytics.estimatedCost} value={currency.format(totals.cost)} />
            <Card className="gap-3 py-4">
              <CardContent className="grid grid-cols-2 gap-3 px-4">
                <div>
                  <p className="text-xs text-muted-foreground">{t.analytics.inputTokens}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{number.format(totals.prompt)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t.analytics.outputTokens}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{number.format(totals.completion)}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <Tabs defaultValue="usage">
          <TabsList className="w-full justify-start overflow-x-auto sm:w-fit">
            <TabsTrigger value="usage">{t.analytics.usageTitle}</TabsTrigger>
            <TabsTrigger value="audit">{t.analytics.auditTitle}</TabsTrigger>
            <TabsTrigger value="runtime">{t.analytics.runtimeTitle}</TabsTrigger>
          </TabsList>

          <TabsContent value="usage" className="pt-3">
            <Card className="gap-4 py-5">
              <CardHeader className="px-5">
                <CardTitle>{t.analytics.usageTitle}</CardTitle>
                <CardDescription>{t.analytics.usageDescription}</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <UsageTable rows={snapshot?.usage ?? []} number={number} currency={currency} locale={locale} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="audit" className="pt-3">
            <Card className="gap-4 py-5">
              <CardHeader className="px-5">
                <CardTitle>{t.analytics.auditTitle}</CardTitle>
                <CardDescription>{t.analytics.auditDescription}</CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                {(snapshot?.audit.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">{t.analytics.noAudit}</p>
                ) : (
                  <ol className="divide-y divide-border" aria-label={t.analytics.auditTitle}>
                    {snapshot?.audit.map((event) => (
                      <li key={event.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="break-all text-sm font-semibold">{event.action}</code>
                            {event.target_type && <Badge variant="outline">{event.target_type}</Badge>}
                          </div>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {event.actor_id ?? t.analytics.actorSystem}
                            {event.target_id ? ` · ${t.analytics.target}: ${event.target_id}` : ''}
                            {event.request_id ? ` · ${event.request_id}` : ''}
                          </p>
                        </div>
                        <time className="text-xs text-muted-foreground" dateTime={event.created_at}>
                          {date.format(new Date(event.created_at))}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="runtime" className="pt-3">
            <Card className="gap-4 py-5">
              <CardHeader className="px-5">
                <CardTitle>{t.analytics.runtimeTitle}</CardTitle>
                <CardDescription>{t.analytics.runtimeDescription}</CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <pre className="max-h-[32rem] overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed" tabIndex={0}>
                  {snapshot?.metrics.trim() || '—'}
                </pre>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ActivityIcon;
  label: string;
  value: string;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex items-center gap-3 px-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-xl font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageTable({
  rows,
  number,
  currency,
  locale,
}: {
  rows: UsageSummaryRow[];
  number: Intl.NumberFormat;
  currency: Intl.NumberFormat;
  locale: string;
}) {
  const { t } = useT();
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }), [locale]);

  if (rows.length === 0) {
    return <p className="px-5 text-sm text-muted-foreground">{t.analytics.noUsage}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <thead>
          <tr className="border-y border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <th scope="col" className="px-5 py-2.5 font-medium">{t.analytics.day}</th>
            <th scope="col" className="px-3 py-2.5 font-medium">{t.analytics.providerModel}</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">{t.analytics.requests}</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">{t.analytics.inputTokens}</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">{t.analytics.outputTokens}</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">{t.analytics.tokens}</th>
            <th scope="col" className="px-5 py-2.5 text-right font-medium">{t.analytics.cost}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.day}:${row.provider}:${row.model}`} className="border-b border-border last:border-0">
              <td className="whitespace-nowrap px-5 py-3">{day.format(new Date(`${row.day}T00:00:00Z`))}</td>
              <td className="px-3 py-3">
                <span className="font-medium">{row.provider}</span>
                <span className="block max-w-72 truncate text-xs text-muted-foreground" title={row.model}>{row.model}</span>
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{number.format(row.requests)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{number.format(row.prompt_tokens)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{number.format(row.completion_tokens)}</td>
              <td className="px-3 py-3 text-right font-medium tabular-nums">{number.format(row.total_tokens)}</td>
              <td className="px-5 py-3 text-right tabular-nums">{currency.format(row.estimated_cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
