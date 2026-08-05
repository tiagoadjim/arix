/**
 * Focused crawl of a store's own website, used once during onboarding.
 *
 * Scope is deliberately small — roughly two dozen institutional pages — because
 * the goal is not a copy of the site. It is the handful of paragraphs a shop
 * keeps about shipping, payment, returns and who they are, which today someone
 * has to retype by hand into the settings screen.
 *
 * Every outbound request goes through `safeFetch`, so this inherits Arix's
 * whole network policy for free: DNS pinned after validation, private and
 * reserved ranges refused, redirects revalidated hop by hop, response bodies
 * capped. A store URL typed into the wizard is untrusted input like any other.
 */

import { assertSafeRemoteUrl, readTextLimited, safeFetch } from '../net/safe-fetch';
import { logger } from '../logger';
import { extractLinks, extractPageContent, type PageContent } from './html-text';
import { isCrawlCandidate, rankCandidates } from './scoring';

export const DEFAULT_MAX_PAGES = 25;

const PAGE_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 1_500_000;
const ROBOTS_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 256 * 1024;
const SITEMAP_TIMEOUT_MS = 8_000;
const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
const MAX_SITEMAP_DOCUMENTS = 4;
const MAX_SITEMAP_URLS = 2_000;
const CONCURRENCY = 4;
/** Wall-clock ceiling for the whole crawl, independent of per-request timeouts. */
const CRAWL_BUDGET_MS = 90_000;
/** Total prose handed to the model, across every page. */
export const TEXT_BUDGET_CHARS = 120_000;
const PER_PAGE_TEXT_CHARS = 12_000;

export interface CrawledPage {
  url: string;
  title: string | null;
  description: string | null;
  headings: string[];
  text: string;
  jsonLd: unknown[];
}

/**
 * Facts read from WordPress's own REST index rather than inferred by a model.
 * Anything available here is strictly better than an LLM guess: it is
 * structured, authoritative, and cannot be talked into saying something else by
 * text on a page.
 */
export interface SiteFacts {
  name: string | null;
  description: string | null;
  timezone: string | null;
}

export interface CrawlResult {
  root: string;
  pages: CrawledPage[];
  facts: SiteFacts;
  /** How many candidates were discovered before ranking. */
  discovered: number;
  /** True when robots.txt asked us not to crawl anything useful. */
  blockedByRobots: boolean;
}

export interface CrawlOptions {
  maxPages?: number;
  signal?: AbortSignal;
  /** Called as pages are discovered and fetched, for the wizard's progress UI. */
  onProgress?: (progress: { discovered: number; fetched: number; currentUrl: string | null }) => void;
}

/** Minimal robots.txt view: the paths a generic crawler must avoid, plus any
 * declared sitemaps. Wildcard and `$` anchors are honoured because WooCommerce
 * and WordPress SEO plugins emit both. */
interface RobotsPolicy {
  disallow: RegExp[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsPolicy {
  const disallow: RegExp[] = [];
  const sitemaps: string[] = [];
  let appliesToUs = false;

  for (const rawLine of text.split(/\r?\n/).slice(0, 2_000)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Only the catch-all group applies: Arix does not claim a named agent.
      appliesToUs = value === '*';
      continue;
    }
    if (field === 'disallow' && appliesToUs && value) {
      const pattern = robotsPathToRegExp(value);
      if (pattern) disallow.push(pattern);
    }
  }

  return { disallow, sitemaps };
}

function robotsPathToRegExp(path: string): RegExp | null {
  const escaped = path
    .slice(0, 300)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(escaped.endsWith('$') ? `^${escaped}` : `^${escaped}`);
  } catch {
    return null;
  }
}

function robotsAllows(policy: RobotsPolicy, url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  return !policy.disallow.some((re) => re.test(target));
}

/** `<loc>` values from a sitemap or sitemap index, bounded. */
export function parseSitemapLocations(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]{1,2048})\s*<\/loc>/gi)) {
    const value = match[1];
    if (value) out.push(value);
    if (out.length >= MAX_SITEMAP_URLS) break;
  }
  return out;
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

export async function crawlStore(rawRoot: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, 60));
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const root = await assertSafeRemoteUrl(rawRoot);

  const robots = await fetchRobots(root, options.signal);
  const [facts, wpPages] = await Promise.all([
    fetchSiteFacts(root, options.signal),
    fetchWordPressPages(root, options.signal),
  ]);
  const candidates = await discoverCandidates(root, robots, deadline, options.signal, wpPages);

  const allowed = candidates.filter(({ url }) => {
    try {
      return robotsAllows(robots, new URL(url));
    } catch {
      return false;
    }
  });

  const ranked = rankCandidates(allowed, maxPages);
  options.onProgress?.({ discovered: ranked.length, fetched: 0, currentUrl: null });

  const pages: CrawledPage[] = [];
  let textBudget = TEXT_BUDGET_CHARS;
  let fetched = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const candidate = ranked[index];
      if (!candidate) return;
      if (options.signal?.aborted) return;
      if (Date.now() > deadline || textBudget <= 0) return;

      options.onProgress?.({ discovered: ranked.length, fetched, currentUrl: candidate.url });
      const content = await fetchPage(candidate.url, options.signal);
      fetched += 1;
      if (content) {
        const text = content.text.slice(0, Math.max(0, textBudget));
        textBudget -= text.length;
        pages.push({
          url: candidate.url,
          title: content.title,
          description: content.description,
          headings: content.headings,
          text,
          jsonLd: content.jsonLd,
        });
      }
      options.onProgress?.({ discovered: ranked.length, fetched, currentUrl: null });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranked.length || 1) }, worker));

  // Restore ranking order: the workers finish out of order, and the model reads
  // better when the most relevant page comes first.
  const rank = new Map(ranked.map((entry, index) => [entry.url, index]));
  pages.sort((a, b) => (rank.get(a.url) ?? 0) - (rank.get(b.url) ?? 0));

  return {
    root: root.toString(),
    pages,
    facts,
    discovered: candidates.length,
    blockedByRobots: candidates.length > 0 && allowed.length === 0,
  };
}

/** WordPress publishes its own name, tagline and timezone at the REST index. */
async function fetchSiteFacts(root: URL, signal?: AbortSignal): Promise<SiteFacts> {
  const empty: SiteFacts = { name: null, description: null, timezone: null };
  try {
    const res = await safeFetch(new URL('/wp-json/', root), { headers: { Accept: 'application/json' }, signal }, {
      timeoutMs: 8_000,
      maxResponseBytes: 512 * 1024,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return empty;
    }
    const parsed: unknown = JSON.parse(await readTextLimited(res, 512 * 1024));
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const root_ = parsed as Record<string, unknown>;
    return {
      name: typeof root_.name === 'string' ? root_.name.slice(0, 120) : null,
      description: typeof root_.description === 'string' ? root_.description.slice(0, 300) : null,
      timezone: typeof root_.timezone_string === 'string' && root_.timezone_string ? root_.timezone_string : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Enumerate published *pages* through the WordPress REST API.
 *
 * On a WordPress store this beats every sitemap heuristic: `wp/v2/pages`
 * excludes products by construction, so "shipping", "returns" and "about" come
 * back without any of the catalog we deliberately skip.
 */
async function fetchWordPressPages(
  root: URL,
  signal?: AbortSignal,
): Promise<Array<{ url: string; anchorText?: string }>> {
  try {
    const target = new URL('/wp-json/wp/v2/pages', root);
    target.searchParams.set('per_page', '40');
    target.searchParams.set('status', 'publish');
    target.searchParams.set('_fields', 'link,title');
    const res = await safeFetch(target, { headers: { Accept: 'application/json' }, signal }, {
      timeoutMs: 10_000,
      maxResponseBytes: 1_000_000,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const parsed: unknown = JSON.parse(await readTextLimited(res, 1_000_000));
    if (!Array.isArray(parsed)) return [];
    const out: Array<{ url: string; anchorText?: string }> = [];
    for (const entry of parsed as Array<{ link?: unknown; title?: unknown }>) {
      if (typeof entry.link !== 'string') continue;
      const rendered = (entry.title as { rendered?: unknown } | undefined)?.rendered;
      out.push(
        typeof rendered === 'string'
          ? { url: entry.link, anchorText: rendered.replace(/<[^>]*>/g, ' ').slice(0, 120) }
          : { url: entry.link },
      );
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchRobots(root: URL, signal?: AbortSignal): Promise<RobotsPolicy> {
  try {
    const res = await safeFetch(new URL('/robots.txt', root), { signal }, {
      timeoutMs: ROBOTS_TIMEOUT_MS,
      maxResponseBytes: ROBOTS_MAX_BYTES,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { disallow: [], sitemaps: [] };
    }
    return parseRobots(await readTextLimited(res, ROBOTS_MAX_BYTES));
  } catch {
    // No robots.txt is the common case and means "no restrictions".
    return { disallow: [], sitemaps: [] };
  }
}

async function discoverCandidates(
  root: URL,
  robots: RobotsPolicy,
  deadline: number,
  signal: AbortSignal | undefined,
  wpPages: Array<{ url: string; anchorText?: string }>,
): Promise<Array<{ url: string; anchorText?: string }>> {
  const out: Array<{ url: string; anchorText?: string }> = [{ url: root.toString() }];
  const seen = new Set([root.toString()]);

  const push = (value: string, anchorText?: string) => {
    let url: URL;
    try {
      url = new URL(value, root);
    } catch {
      return;
    }
    if (url.origin !== root.origin) return;
    url.hash = '';
    const normalized = url.toString();
    if (seen.has(normalized)) return;
    if (!isCrawlCandidate(url)) return;
    seen.add(normalized);
    out.push(anchorText === undefined ? { url: normalized } : { url: normalized, anchorText });
  };

  // Highest-signal source first — these are pages by definition, not products.
  for (const page of wpPages) push(page.url, page.anchorText);

  const sitemapQueue = [
    ...robots.sitemaps,
    new URL('/sitemap.xml', root).toString(),
    new URL('/sitemap_index.xml', root).toString(),
    new URL('/wp-sitemap.xml', root).toString(),
  ];

  let documentsRead = 0;
  while (sitemapQueue.length > 0 && documentsRead < MAX_SITEMAP_DOCUMENTS && Date.now() < deadline) {
    const next = sitemapQueue.shift();
    if (!next) break;
    const xml = await fetchSitemap(next, root, signal);
    if (!xml) continue;
    documentsRead += 1;
    const locations = parseSitemapLocations(xml);
    if (isSitemapIndex(xml)) {
      // Follow only the child sitemaps that plausibly hold pages — a store's
      // product sitemap can be tens of thousands of URLs we would discard.
      for (const location of locations) {
        if (/(page|pagina|post|content|categor)/i.test(location)) sitemapQueue.push(location);
      }
      if (sitemapQueue.length === 0) sitemapQueue.push(...locations.slice(0, 2));
      continue;
    }
    for (const location of locations) push(location);
  }

  // Always read the home page's own navigation: many small stores have no
  // sitemap at all, and anchor text ("Cómo comprar") is a better signal than
  // the slug on the ones that do.
  const home = await fetchPageRaw(root.toString(), signal);
  if (home) {
    for (const link of extractLinks(home, root)) push(link);
    for (const { href, text } of extractAnchors(home, root)) push(href, text);
  }

  return out;
}

/** Anchor href + its visible text, for scoring. */
function extractAnchors(html: string, base: URL): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'<>\s]{1,2048})["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = match[1];
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.origin !== base.origin) continue;
    const text = (match[2] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({ href: resolved.toString(), text });
    if (out.length >= 400) break;
  }
  return out;
}

async function fetchSitemap(url: string, root: URL, signal?: AbortSignal): Promise<string | null> {
  try {
    const target = new URL(url, root);
    // A sitemap declared in robots.txt is still attacker-influenced input.
    if (target.origin !== root.origin) return null;
    const res = await safeFetch(target, { headers: { Accept: 'application/xml,text/xml' }, signal }, {
      timeoutMs: SITEMAP_TIMEOUT_MS,
      maxResponseBytes: SITEMAP_MAX_BYTES,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await readTextLimited(res, SITEMAP_MAX_BYTES);
  } catch {
    return null;
  }
}

async function fetchPageRaw(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await safeFetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' }, signal }, {
      timeoutMs: PAGE_TIMEOUT_MS,
      maxResponseBytes: PAGE_MAX_BYTES,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await readTextLimited(res, PAGE_MAX_BYTES);
  } catch (err) {
    logger.debug({ errorType: err instanceof Error ? err.name : typeof err }, 'site scan: page fetch failed');
    return null;
  }
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<PageContent | null> {
  const html = await fetchPageRaw(url, signal);
  if (!html) return null;
  const content = extractPageContent(html, { maxTextLength: PER_PAGE_TEXT_CHARS });
  // A page with almost no prose (an image-only landing, a redirect stub)
  // contributes nothing but noise to the extraction prompt.
  return content.text.trim().length >= 80 ? content : null;
}
