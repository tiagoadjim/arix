'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2Icon, SparklesIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage, type ProposedField, type SettingDto, type SiteScanJob, type SettingsUpdate } from '@/lib/api';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { findDto, isReadOnly, plainUpdate, compactUpdates } from '@/components/settings/settings-form-utils';
import { ConnectionState } from '@/components/wizard/connection-state';
import { ProposalRow, formatValue, type ProposalDecision } from '@/components/wizard/proposal-row';
import { StepActions } from '@/components/wizard/wizard-shell';

const POLL_MS = 1_000;

type Grouped = Record<string, SettingDto[]>;

export function LearnStep({
  grouped,
  storeUrl,
  llmConfigured,
  onNext,
  onSkip,
  onApplied,
  onSettingsChanged,
}: {
  grouped: Grouped | null;
  storeUrl: string;
  llmConfigured: boolean;
  onNext: () => void;
  onSkip: () => void;
  onApplied: (count: number) => void;
  onSettingsChanged: () => void;
}) {
  const { t } = useT();
  const [url, setUrl] = useState(storeUrl);
  const [job, setJob] = useState<SiteScanJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>({});
  const [saving, setSaving] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const running = job?.state === 'crawling' || job?.state === 'extracting';
  const fields = job?.state === 'done' ? (job.result?.fields ?? []) : [];

  // Poll while a scan is alive. Progress is polled rather than pushed because
  // the server's event stream carries no payload and is broadcast to every
  // connected user — a per-scan channel would mean changing that contract.
  useEffect(() => {
    if (!running || !jobIdRef.current) return;
    let alive = true;
    const id = jobIdRef.current;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await api.siteScan(id);
          if (alive) setJob(next);
        } catch {
          // A transient failure just means the next tick reconciles.
        }
      })();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running]);

  async function start() {
    setStarting(true);
    setError(null);
    setDecisions({});
    try {
      const { id } = await api.startSiteScan(url);
      jobIdRef.current = id;
      setJob({
        id,
        state: 'crawling',
        root: url,
        progress: { pagesFound: 0, pagesFetched: 0, maxPages: 25, currentUrl: null },
        result: null,
        error: null,
      });
    } catch (err) {
      setError(apiErrorMessage(err, t, t.common.error));
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    const id = jobIdRef.current;
    if (!id) return;
    try {
      await api.cancelSiteScan(id);
    } catch {
      // Cancelling is best-effort; the job also stops on its own budget.
    }
    setJob(null);
    jobIdRef.current = null;
  }

  async function save() {
    setSaving(true);
    try {
      const updates = compactUpdates(
        fields.map((field) => {
          const decision = decisions[field.key];
          if (!decision?.accepted) return null;
          const dtos = grouped?.[field.key.split('.')[0] ?? ''];
          const value = decision.editedValue ?? field.value;
          return plainUpdate(field.key, value, dtos);
        }) as Array<SettingsUpdate | null>,
      );
      if (updates.length > 0) {
        await api.saveSettings(updates);
        onSettingsChanged();
      }
      onApplied(updates.length);
      onNext();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  function acceptAllSafe() {
    setDecisions((current) => {
      const next = { ...current };
      for (const field of fields) {
        if (field.warnings.length > 0) continue;
        if (isReadOnly(field.key, grouped?.[field.key.split('.')[0] ?? ''])) continue;
        next[field.key] = { ...next[field.key], accepted: true };
      }
      return next;
    });
  }

  function currentValueFor(field: ProposedField): string {
    const dtos = grouped?.[field.key.split('.')[0] ?? ''];
    const value = findDto(field.key, dtos)?.value;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return formatValue(value as unknown as number[][], t.time.weekdays);
    return '';
  }

  const acceptedCount = fields.filter((field) => decisions[field.key]?.accepted).length;

  if (!llmConfigured) {
    return (
      <div className="flex flex-col gap-6">
        <Alert>
          <AlertDescription>{t.wizard.learn.llmRequired}</AlertDescription>
        </Alert>
        <StepActions onSkip={onSkip} skipLabel={t.wizard.learn.skipLink}>
          <Button onClick={onNext}>{t.common.next}</Button>
        </StepActions>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {!job && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scan-url">{t.wizard.learn.urlLabel}</Label>
            <div className="flex gap-2">
              <Input
                id="scan-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="mitienda.com"
                inputMode="url"
                spellCheck={false}
                disabled={starting}
              />
              <Button type="button" onClick={() => void start()} disabled={!url.trim() || starting}>
                <SparklesIcon aria-hidden className="size-4" />
                {t.wizard.learn.start}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t.wizard.learn.urlHint}</p>
          </div>
          {error && <ConnectionState phase="error" message={error} />}
        </>
      )}

      {running && job && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2Icon aria-hidden className="size-4 animate-spin text-primary" />
            {job.state === 'crawling' ? t.wizard.learn.crawling : t.wizard.learn.extracting}
          </p>
          <Progress
            value={
              job.state === 'extracting'
                ? 100
                : job.progress.pagesFound > 0
                  ? (job.progress.pagesFetched / job.progress.pagesFound) * 100
                  : 5
            }
          />
          <p className="truncate text-xs text-muted-foreground">
            {interpolate(t.wizard.learn.pagesProgress, {
              fetched: job.progress.pagesFetched,
              total: job.progress.pagesFound || job.progress.maxPages,
            })}
            {job.progress.currentUrl ? ` · ${job.progress.currentUrl}` : ''}
          </p>
          <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => void stop()}>
            {t.wizard.learn.stop}
          </Button>
        </div>
      )}

      {job?.state === 'error' && (
        <div className="flex flex-col gap-3">
          <ConnectionState phase="error" message={job.error ? (t.errors[job.error] ?? job.error) : t.common.error} />
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={() => {
              setJob(null);
              jobIdRef.current = null;
            }}
          >
            {t.wizard.learn.retry}
          </Button>
        </div>
      )}

      {job?.state === 'done' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">{t.wizard.learn.resultTitle}</h2>
            <p className="text-sm text-muted-foreground text-pretty">{t.wizard.learn.resultSubtitle}</p>
          </div>

          {fields.length === 0 ? (
            <Alert>
              <AlertDescription>{t.wizard.learn.nothingFound}</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={acceptAllSafe}>
                  {t.wizard.learn.acceptAll}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {interpolate(t.wizard.learn.selectedCount, { n: acceptedCount, total: fields.length })}
                </span>
              </div>

              <ul className="flex flex-col gap-3">
                {fields.map((field) => (
                  <ProposalRow
                    key={field.key}
                    field={field}
                    currentValue={currentValueFor(field)}
                    decision={decisions[field.key] ?? { accepted: false }}
                    onChange={(decision) => setDecisions((current) => ({ ...current, [field.key]: decision }))}
                  />
                ))}
              </ul>
            </>
          )}

          {job.result?.agentTone && (
            <p className="text-xs text-muted-foreground">
              {interpolate(t.wizard.learn.toneNote, { tone: job.result.agentTone })}
            </p>
          )}

          {job.result && job.result.pagesRead.length > 0 && (
            <Collapsible className="rounded-lg border bg-card/40">
              <CollapsibleTrigger className="w-full px-4 py-2.5 text-left text-xs font-medium hover:bg-accent/40">
                {t.wizard.learn.pagesReadTitle} ({job.result.pagesRead.length})
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t px-4 py-3">
                <ul className="flex flex-col gap-1">
                  {job.result.pagesRead.map((page) => (
                    <li key={page} className="truncate text-xs text-muted-foreground">
                      {page}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}

      <StepActions onSkip={onSkip} skipLabel={t.wizard.learn.skipLink}>
        {job?.state === 'done' && fields.length > 0 ? (
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? t.common.saving : t.wizard.learn.save}
          </Button>
        ) : (
          <Button onClick={onNext} disabled={running}>
            {t.common.next}
          </Button>
        )}
      </StepActions>
    </div>
  );
}
