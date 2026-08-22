/**
 * Skill ids + enable-list normalization — kept free of tool-module imports so
 * config/runtime.ts can depend on this without creating a cycle
 * (runtime → registry → catalog/orders/… → runtime).
 */

import { DEFAULT_VERTICAL, type Vertical } from '../verticals';

export const BUILTIN_SKILL_IDS = [
  'catalog',
  'orders',
  'payments',
  'handoff',
  'knowledge',
  'appointments',
] as const;
export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number];

/**
 * Skills enabled out of the box, per vertical.
 *
 * Not every skill makes sense everywhere: a service business has no catalog to
 * search and no order to match a transfer against, so advertising those tools
 * would only give the model a way to fail. An operator can still enable any
 * skill from the dashboard — this is the starting point, not a restriction.
 */
const VERTICAL_DEFAULT_SKILLS: Record<Vertical, readonly BuiltinSkillId[]> = {
  // Unchanged from before verticals existed: every installation that predates
  // the setting resolves to `ecommerce` and keeps exactly this list.
  ecommerce: ['catalog', 'orders', 'payments', 'handoff'],
  services: ['knowledge', 'handoff'],
  appointments: ['appointments', 'knowledge', 'handoff'],
};

export function defaultEnabledSkills(vertical: Vertical = DEFAULT_VERTICAL): string[] {
  return [...VERTICAL_DEFAULT_SKILLS[vertical]];
}

export function isKnownSkillId(id: string): id is BuiltinSkillId {
  return (BUILTIN_SKILL_IDS as readonly string[]).includes(id);
}

/** Normalize a stored `skills.enabled` value into a clean list of known ids.
 * Unknown ids are dropped; an empty/invalid value falls back to `fallback`
 * (the vertical's defaults) except an intentional empty array (`[]` means
 * disable everything). */
export function normalizeEnabledSkills(
  raw: unknown,
  fallback: readonly string[] = defaultEnabledSkills(),
): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const ids = raw.filter((v): v is string => typeof v === 'string' && isKnownSkillId(v));
  if (raw.length === 0) return [];
  return [...new Set(ids)];
}

export function isValidEnabledSkills(raw: unknown): raw is string[] {
  return (
    Array.isArray(raw) &&
    raw.every((value) => typeof value === 'string' && isKnownSkillId(value))
  );
}
