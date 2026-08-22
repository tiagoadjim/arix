/**
 * Business verticals — what kind of business a deployment serves.
 *
 * Arix started as a WooCommerce sales agent, so "store", "product" and
 * "delivery" were baked into the prompt, the guardrails and the default skill
 * set. The vertical turns that into a configuration value: the same agent loop
 * serves a shop, a service business or an appointment-based one, and only the
 * domain-specific layers (prompt pack, grounding lock, default skills, wizard
 * steps) branch on it.
 *
 * Deliberately dependency-free so config/, agent/ and skills/ can all import it
 * without creating a cycle — same reason skills/ids.ts stays import-free.
 */

export const VERTICALS = ['ecommerce', 'services', 'appointments'] as const;

export type Vertical = (typeof VERTICALS)[number];

/** Preserves the behavior of every installation that predates this setting. */
export const DEFAULT_VERTICAL: Vertical = 'ecommerce';

export function isVertical(value: unknown): value is Vertical {
  return typeof value === 'string' && (VERTICALS as readonly string[]).includes(value);
}

/** Falls back to the default rather than throwing: a bad stored value should
 * degrade to today's behavior, never take the agent down mid-conversation. */
export function normalizeVertical(value: unknown): Vertical {
  return isVertical(value) ? value : DEFAULT_VERTICAL;
}

/**
 * Whether this vertical sells from a live product catalog.
 *
 * Gates the grounding lock (agent/guardrails): forcing a `search_catalog` call
 * before any product claim is what stops the agent inventing prices, but in a
 * vertical with no catalog the same retail regexes only produce false
 * positives that block legitimate replies.
 */
export function hasCatalog(vertical: Vertical): boolean {
  return vertical === 'ecommerce';
}

/** Whether this vertical books appointments (and so schedules reminders). */
export function hasAgenda(vertical: Vertical): boolean {
  return vertical === 'appointments';
}
