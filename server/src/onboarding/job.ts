/**
 * Job state for the onboarding site scan.
 *
 * One scan at a time, held in memory, for the length of one wizard screen.
 *
 * The repo's durable-work pattern — a lease column plus an `*_attempt_id` fence
 * on the domain row, as `messages` and `receipts` do — exists for work with
 * irreversible external effects: a WhatsApp message that must not be sent
 * twice, a WooCommerce order whose status must not be lost. A scan has no
 * external effect at all. Nothing is written until a person reads the
 * suggestions and accepts them field by field, so the worst case of a server
 * restart mid-scan is that the administrator presses the button again. A
 * migration and a lease would buy nothing and would put crawled content at
 * rest for no reason.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { crawlStore, DEFAULT_MAX_PAGES, type CrawlResult, type SiteFacts } from './crawler';
import { ExtractionFailedError, extractStoreProfile, sanitizeText, type ProposedField } from './extract';

export type ScanState = 'crawling' | 'extracting' | 'done' | 'error' | 'cancelled';

export interface ScanProgress {
  pagesFound: number;
  pagesFetched: number;
  maxPages: number;
  currentUrl: string | null;
}

export interface ScanResult {
  fields: ProposedField[];
  agentTone: string | null;
  pagesRead: string[];
}

export interface ScanJob {
  id: string;
  state: ScanState;
  startedBy: string;
  startedAt: number;
  root: string;
  progress: ScanProgress;
  result: ScanResult | null;
  /** Stable error code, translated in the dashboard. */
  error: string | null;
  controller: AbortController;
}

export interface ScanJobDto {
  id: string;
  state: ScanState;
  root: string;
  progress: ScanProgress;
  result: ScanResult | null;
  error: string | null;
}

/** Small enough that eviction is never interesting, large enough that a reload
 * during a scan still finds the job it was watching. */
const MAX_JOBS = 4;
const JOB_TTL_MS = 30 * 60_000;

const jobs = new Map<string, ScanJob>();
let activeJobId: string | null = null;

export class ScanAlreadyRunningError extends Error {
  constructor(readonly jobId: string) {
    super('scan_already_running');
    this.name = 'ScanAlreadyRunningError';
  }
}

function evictStale(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished = job.state === 'done' || job.state === 'error' || job.state === 'cancelled';
    if (finished && now - job.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size >= MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    if (oldest === activeJobId) break;
    jobs.delete(oldest);
  }
}

export function getScanJob(id: string): ScanJobDto | null {
  const job = jobs.get(id);
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    root: job.root,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };
}

export function cancelScanJob(id: string, byUserId: string): boolean {
  const job = jobs.get(id);
  if (!job || job.startedBy !== byUserId) return false;
  if (job.state === 'done' || job.state === 'error') return false;
  job.controller.abort();
  job.state = 'cancelled';
  if (activeJobId === id) activeJobId = null;
  return true;
}

/** Test seam — production never needs to reset the registry. */
export function resetScanJobs(): void {
  jobs.clear();
  activeJobId = null;
}

export function startScanJob(input: { root: string; startedBy: string; maxPages?: number }): ScanJob {
  if (activeJobId) {
    const running = jobs.get(activeJobId);
    if (running && (running.state === 'crawling' || running.state === 'extracting')) {
      throw new ScanAlreadyRunningError(activeJobId);
    }
    activeJobId = null;
  }
  evictStale();

  const job: ScanJob = {
    id: randomUUID(),
    state: 'crawling',
    startedBy: input.startedBy,
    startedAt: Date.now(),
    root: input.root,
    progress: { pagesFound: 0, pagesFetched: 0, maxPages: input.maxPages ?? DEFAULT_MAX_PAGES, currentUrl: null },
    result: null,
    error: null,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  void run(job, input.maxPages ?? DEFAULT_MAX_PAGES).finally(() => {
    if (activeJobId === job.id) activeJobId = null;
  });

  return job;
}

async function run(job: ScanJob, maxPages: number): Promise<void> {
  try {
    const crawl = await crawlStore(job.root, {
      maxPages,
      signal: job.controller.signal,
      onProgress: (progress) => {
        job.progress = {
          pagesFound: progress.discovered,
          pagesFetched: progress.fetched,
          maxPages,
          currentUrl: progress.currentUrl,
        };
      },
    });
    if (job.controller.signal.aborted) return;

    if (crawl.pages.length === 0) {
      job.state = 'error';
      job.error = crawl.blockedByRobots ? 'scan_blocked_by_robots' : 'scan_no_pages';
      return;
    }

    job.state = 'extracting';
    job.progress = { ...job.progress, currentUrl: null };

    const extraction = await extractStoreProfile(crawl.pages, { signal: job.controller.signal });
    if (job.controller.signal.aborted) return;

    job.result = {
      fields: withStructuredFacts(extraction.fields, crawl),
      agentTone: extraction.agentTone,
      pagesRead: crawl.pages.map((page) => page.url),
    };
    job.state = 'done';
  } catch (err) {
    if (job.controller.signal.aborted) return;
    job.state = 'error';
    job.error = err instanceof ExtractionFailedError ? 'scan_extraction_failed' : 'scan_failed';
    logger.warn(
      { jobId: job.id, errorType: err instanceof Error ? err.name : typeof err },
      'site scan failed',
    );
  }
}

/**
 * Let WordPress's own REST index win over the model.
 *
 * `/wp-json/` publishes the site name and IANA timezone as structured data. A
 * value read from there cannot be argued into saying something else by text on
 * a page, so where both exist the structured one replaces the inferred one and
 * is presented with full confidence and no warnings.
 */
function withStructuredFacts(fields: ProposedField[], crawl: CrawlResult): ProposedField[] {
  const out = [...fields];
  const replace = (key: ProposedField['key'], value: string, sources: string[]): void => {
    const index = out.findIndex((field) => field.key === key);
    const entry: ProposedField = { key, value, sources, confidence: 1, warnings: [] };
    if (index >= 0) out[index] = entry;
    else out.push(entry);
  };

  const facts: SiteFacts = crawl.facts;
  const restIndex = `${crawl.root.replace(/\/$/, '')}/wp-json/`;

  const name = sanitizeText(facts.name, 120);
  if (name) replace('business.name', name, [restIndex]);
  if (facts.timezone && isKnownTimezone(facts.timezone)) {
    replace('business.timezone', facts.timezone, [restIndex]);
  }

  return out;
}

function isKnownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
