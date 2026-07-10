import { catalogTools } from './catalog';
import { orderTools } from './orders';
import { paymentTools } from './payments';
import { handoffTools } from './handoff';
import type { ToolSpec } from '../agent/tool-spec';
import {
  BUILTIN_SKILL_IDS,
  DEFAULT_ENABLED_SKILLS,
  isKnownSkillId,
  normalizeEnabledSkills,
} from './ids';

export {
  BUILTIN_SKILL_IDS,
  DEFAULT_ENABLED_SKILLS,
  isKnownSkillId,
  normalizeEnabledSkills,
} from './ids';

/**
 * Built-in agent skills — each skill is a named bundle of OpenAI function
 * tools. Operators can enable/disable skills from the dashboard / setup
 * wizard without redeploying; the agent only advertises tools from enabled
 * skills (plus any MCP tools — see mcp/manager.ts).
 */

export interface SkillMeta {
  id: string;
  /** Stable English label for the API; the dashboard localizes via i18n. */
  label: string;
  description: string;
  /** Tool names this skill contributes. */
  toolNames: string[];
  tools: ToolSpec[];
}

export const BUILTIN_SKILLS: readonly SkillMeta[] = [
  {
    id: 'catalog',
    label: 'Catalog',
    description: 'Search products and view stock, prices, and variants from WooCommerce.',
    toolNames: catalogTools.map((t) => t.definition.function.name),
    tools: catalogTools,
  },
  {
    id: 'orders',
    label: 'Orders',
    description: 'Look up a customer order by number or phone.',
    toolNames: orderTools.map((t) => t.definition.function.name),
    tools: orderTools,
  },
  {
    id: 'payments',
    label: 'Payments',
    description: 'Confirm a transfer receipt against an order total.',
    toolNames: paymentTools.map((t) => t.definition.function.name),
    tools: paymentTools,
  },
  {
    id: 'handoff',
    label: 'Human handoff',
    description: 'Pause the bot and escalate the conversation to a human teammate.',
    toolNames: handoffTools.map((t) => t.definition.function.name),
    tools: handoffTools,
  },
] as const;

export const ALL_BUILTIN_TOOLS: ToolSpec[] = BUILTIN_SKILLS.flatMap((s) => s.tools);

export function toolsForEnabledSkills(enabledIds: readonly string[]): ToolSpec[] {
  const enabled = new Set(enabledIds);
  return BUILTIN_SKILLS.filter((s) => enabled.has(s.id)).flatMap((s) => s.tools);
}

export interface SkillCatalogEntry {
  id: string;
  label: string;
  description: string;
  toolNames: string[];
  enabled: boolean;
}

export function buildSkillCatalog(enabledIds: readonly string[]): SkillCatalogEntry[] {
  const enabled = new Set(enabledIds);
  return BUILTIN_SKILLS.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    toolNames: [...s.toolNames],
    enabled: enabled.has(s.id),
  }));
}
