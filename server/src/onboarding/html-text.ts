/**
 * Bounded HTML → text extraction for the onboarding site scan.
 *
 * Deliberately not a DOM parser. The server ships fifteen production
 * dependencies and gates releases on `pnpm audit:prod`; pulling a full parser
 * tree in to read a handful of "about us" pages once, during setup, is a poor
 * trade. What this needs to do is narrow and testable: drop the markup, keep
 * the prose, and never let a hostile page allocate without bound.
 *
 * Everything here treats its input as adversarial. Output is capped, control
 * characters are stripped, and no branch depends on the document being
 * well-formed — unclosed tags degrade to "keep less text", never to a hang.
 */

/** Blocks whose *contents* are never prose worth keeping. */
const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'form',
  'select',
  'nav',
  'header',
  'footer',
];

/** Elements that imply a line break once their tag is removed. */
const BLOCK_TAG_RE =
  /<\/?(?:p|div|section|article|main|aside|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|table|h[1-6]|blockquote|pre|figure|figcaption|address|details|summary)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  ccedil: 'ç',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * Collapse C0/C1 controls to spaces, keeping tab and newline.
 *
 * Written as a scan rather than a regex on purpose: a character class of
 * literal control codes is invisible in a diff and easy to break silently
 * during an edit. Inputs here are already capped well below a megabyte.
 */
export function stripControlCharacters(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10) out += char;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += ' ';
    else out += char;
  }
  return out;
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Reject anything outside the Unicode range and the surrogate block; a
      // decoded entity must never become a control character either.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code >= 0xd800 && code <= 0xdfff) return '';
      if (code < 0x20 && code !== 0x09 && code !== 0x0a) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Remove an element and everything inside it.
 *
 * The closing-tag search is intentionally literal rather than nesting-aware:
 * HTML forbids nesting for the elements listed above, and a literal scan cannot
 * be driven into pathological backtracking by crafted input. An unclosed block
 * swallows the rest of the document, which is the safe direction to fail.
 */
function stripElement(html: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b`, 'i');
  let out = html;
  for (let guard = 0; guard < 200; guard += 1) {
    const start = out.search(open);
    if (start < 0) return out;
    const closeAt = out.toLowerCase().indexOf(`</${tag}`, start);
    if (closeAt < 0) return out.slice(0, start);
    const after = out.indexOf('>', closeAt);
    out = `${out.slice(0, start)} ${after < 0 ? '' : out.slice(after + 1)}`;
  }
  return out;
}

export interface PageContent {
  title: string | null;
  description: string | null;
  headings: string[];
  text: string;
  /** Parsed `application/ld+json` blocks, unvalidated. */
  jsonLd: unknown[];
}

export interface ExtractOptions {
  /** Hard ceiling on the returned prose. */
  maxTextLength?: number;
}

const DEFAULT_MAX_TEXT = 12_000;
const MAX_JSON_LD_BYTES = 100_000;
const MAX_JSON_LD_BLOCKS = 8;

export function extractPageContent(html: string, options: ExtractOptions = {}): PageContent {
  const maxTextLength = Math.max(200, options.maxTextLength ?? DEFAULT_MAX_TEXT);

  const title = firstMatch(html, /<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const description =
    firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]{0,600}?)["']/i) ??
    firstMatch(html, /<meta[^>]+content=["']([\s\S]{0,600}?)["'][^>]+name=["']description["']/i);

  const headings: string[] = [];
  for (const match of html.matchAll(/<h[12][^>]*>([\s\S]{0,300}?)<\/h[12]>/gi)) {
    const heading = cleanInline(match[1] ?? '');
    if (heading) headings.push(heading);
    if (headings.length >= 12) break;
  }

  const jsonLd = extractJsonLd(html);

  let body = html;
  for (const tag of DROPPED_ELEMENTS) body = stripElement(body, tag);
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(BLOCK_TAG_RE, '\n');
  body = body.replace(/<[^>]*>/g, ' ');
  body = decodeEntities(body);
  body = stripControlCharacters(body);
  body = body
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return {
    title: title ? cleanInline(title) : null,
    description: description ? cleanInline(description) : null,
    headings,
    text: body.slice(0, maxTextLength),
    jsonLd,
  };
}

function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = match[1];
    if (!raw || raw.length > MAX_JSON_LD_BYTES) continue;
    try {
      blocks.push(JSON.parse(decodeEntities(raw)) as unknown);
    } catch {
      // Structured data is a bonus signal, never a requirement.
    }
    if (blocks.length >= MAX_JSON_LD_BLOCKS) break;
  }
  return blocks;
}

function cleanInline(input: string): string {
  return stripControlCharacters(decodeEntities(input.replace(/<[^>]*>/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function firstMatch(input: string, re: RegExp): string | null {
  return input.match(re)?.[1] ?? null;
}

/** Same-origin `href` values, in document order, deduplicated. */
export function extractLinks(html: string, base: URL, limit = 400): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'<>\s]{1,2048})["']/gi)) {
    const href = match[1];
    if (!href || href.startsWith('#')) continue;
    let resolved: URL;
    try {
      resolved = new URL(decodeEntities(href), base);
    } catch {
      continue;
    }
    if (resolved.origin !== base.origin) continue;
    resolved.hash = '';
    const normalized = resolved.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}
