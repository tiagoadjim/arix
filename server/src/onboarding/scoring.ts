/**
 * Which pages of a store are worth reading during onboarding.
 *
 * The agent already has the catalog: `search_catalog` hits the WooCommerce REST
 * API live on every product question, so a crawled product page is at best
 * redundant and at worst a stale price the model might repeat. What the agent
 * does NOT have is the prose a shop keeps on a handful of institutional pages —
 * how it ships, what it accepts as payment, whether returns are possible, who
 * it is. That is all this scoring tries to find.
 *
 * Spanish and English are both first-class: Arix's default persona is
 * Rioplatense Spanish and most stores are one language or the other.
 */

export interface ScoredUrl {
  url: string;
  score: number;
}

interface Signal {
  patterns: RegExp;
  weight: number;
}

/** Positive signals, strongest first. Matched against the pathname and, when
 * available, the anchor text that pointed at the page. */
const WANTED: Signal[] = [
  { patterns: /(envio|envios|shipping|delivery|entrega|entregas|despacho)/i, weight: 100 },
  { patterns: /(medios-de-pago|formas-de-pago|payment|pagos?|checkout-info|financiacion|cuotas)/i, weight: 100 },
  { patterns: /(devolucion|devoluciones|cambios|returns?|refunds?|garantia|warranty)/i, weight: 90 },
  { patterns: /(faq|preguntas|frecuentes|ayuda|help|support|soporte)/i, weight: 85 },
  { patterns: /(contacto|contact|donde-estamos|ubicacion|sucursal|sucursales|locales|store-locator)/i, weight: 70 },
  { patterns: /(nosotros|quienes-somos|about|about-us|sobre-nosotros|empresa|historia)/i, weight: 60 },
  { patterns: /(terminos|condiciones|terms|conditions|legal|privacidad|privacy)/i, weight: 45 },
  { patterns: /(mayorista|wholesale|revendedor|distribuidor|b2b)/i, weight: 40 },
  { patterns: /(horarios?|opening-hours|hours)/i, weight: 40 },
];

/**
 * Hard exclusions. These are not "less interesting", they are actively wrong to
 * spend the budget on: catalog pages duplicate the live API, and account/cart
 * routes are per-session noise.
 */
const EXCLUDED = [
  /\/(producto|productos|product|shop|tienda|store|categoria|categorias|product-category|product-tag|collections?)(\/|$)/i,
  /\/(cart|carrito|checkout|mi-cuenta|my-account|account|login|register|wp-admin|wp-login|wp-json|feed|comments)(\/|$)/i,
  /\/(tag|author|page|category)\/\d*/i,
  /[?&](add-to-cart|orderby|filter_|min_price|max_price|s=|paged?=)/i,
  /\/\d{4}\/\d{2}\//, // dated blog archives
];

/** Anything that is plainly not an HTML document. */
const NON_HTML = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|pdf|zip|gz|rar|mp[34]|mov|avi|webm|woff2?|ttf|eot|txt|csv)(?:$|\?)/i;

export function isCrawlCandidate(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const target = `${url.pathname}${url.search}`;
  if (NON_HTML.test(target)) return false;
  return !EXCLUDED.some((re) => re.test(target));
}

/**
 * Score a candidate. Higher is more likely to be an institutional page.
 *
 * The home page gets a deliberate floor: it is the one page that reliably
 * carries the business name, the tone of voice, and often a shipping or payment
 * strip, even on stores with no other content pages at all.
 */
export function scoreUrl(url: URL, anchorText = ''): number {
  const path = decodeURIComponentSafe(url.pathname);
  // Fold accents before matching. Slugs are usually written without them
  // ("/envios") while the link text almost never is ("Envíos", "Devoluciones",
  // "Garantía") — matching only the unaccented form would miss the better of
  // the two signals on most Spanish-language stores.
  const haystack = foldAccents(`${path} ${anchorText}`.slice(0, 500));

  if (path === '' || path === '/') return 120;

  let score = 0;
  for (const signal of WANTED) {
    if (signal.patterns.test(haystack)) score += signal.weight;
  }
  if (score === 0) return 0;

  // Prefer shallow, canonical pages: `/envios` beats `/blog/2019/envios-a-todo-el-pais`.
  const depth = path.split('/').filter(Boolean).length;
  score -= Math.max(0, depth - 1) * 12;
  // Very long slugs are usually articles, not policy pages.
  if (path.length > 80) score -= 15;

  return Math.max(0, score);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** "Envíos" → "Envios", "Garantía" → "Garantia". */
function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Rank candidates and keep the best `limit`, at most one per path.
 *
 * Ties are broken by the order the URLs were discovered, which keeps sitemap
 * order (usually meaningful) rather than shuffling it.
 */
export function rankCandidates(
  candidates: Array<{ url: string; anchorText?: string }>,
  limit: number,
): ScoredUrl[] {
  const bestByPath = new Map<string, ScoredUrl>();

  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate.url);
    } catch {
      continue;
    }
    if (!isCrawlCandidate(url)) continue;

    const score = scoreUrl(url, candidate.anchorText ?? '');
    if (score <= 0) continue;

    const key = url.pathname.replace(/\/+$/, '') || '/';
    const existing = bestByPath.get(key);
    if (!existing || score > existing.score) bestByPath.set(key, { url: url.toString(), score });
  }

  return [...bestByPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
