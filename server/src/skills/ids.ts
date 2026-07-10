/**
 * Skill ids + enable-list normalization — kept free of tool-module imports so
 * config/runtime.ts can depend on this without creating a cycle
 * (runtime → registry → catalog/orders/… → runtime).
 */

export const BUILTIN_SKILL_IDS = ['catalog', 'orders', 'payments', 'handoff'] as const;
export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number];

/** Default: every built-in skill is enabled. */
export const DEFAULT_ENABLED_SKILLS: string[] = [...BUILTIN_SKILL_IDS];

export function isKnownSkillId(id: string): id is BuiltinSkillId {
  return (BUILTIN_SKILL_IDS as readonly string[]).includes(id);
}

/** Normalize a stored `skills.enabled` value into a clean list of known ids.
 * Unknown ids are dropped; an empty/invalid value falls back to all skills
 * except an intentional empty array (`[]` means disable everything). */
export function normalizeEnabledSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ENABLED_SKILLS];
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
