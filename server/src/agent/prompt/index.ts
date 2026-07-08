import { config } from '../../config';
import type { ToolContext } from '../../types';
import { deliveryStatusLine, getStoreStatus, nowInTimezone, type Language, type Schedule } from '../hours';
import { buildEsPrompt } from './es';
import { buildEnPrompt } from './en';

/**
 * The customer's WhatsApp display name (`pushName`) is attacker-controlled, so
 * we treat it as data: strip line breaks / markdown / angle brackets that could
 * be used to inject fake instructions, collapse whitespace and cap the length.
 */
function safeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/[\r\n`*_#<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/** Wall-clock parts for "now", already resolved to the store's timezone. */
export interface PromptDate {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  day: number;
  month: number;
  year: number;
  hour: number;
  minute: number;
}

/** Everything a language template needs to render the system prompt. */
export interface PromptParams {
  agentName: string;
  businessName: string;
  storefrontUrl: string;
  /** Sanitized WhatsApp display name of the customer, or '' when unknown. */
  customerName: string;
  now: PromptDate;
  /** One-line delivery status ("open until 17:00" / "closed until tomorrow…"). */
  deliveryStatusLine: string;
  infoBlocks: { payment: string; shipping: string; general: string };
  /** Business-specific compliance text (e.g. an age restriction). Empty by
   * default — when empty, nothing is injected. */
  complianceRules: string;
  /** When true, the persona openly discloses it's an AI assistant instead of
   * presenting as a human teammate. */
  discloseBot: boolean;
  maxBubbles: number;
}

/**
 * Everything buildSystemPrompt needs, already resolved by the runtime config
 * service (server/src/config/runtime.ts) — agent.ts assembles this once per
 * turn from businessProfile() + hoursConfig() + infoBlocks() +
 * complianceRules() + woo() so this module stays a pure, synchronous formatter.
 */
export interface ResolvedPromptConfig {
  businessName: string;
  agentName: string;
  language: Language;
  discloseBot: boolean;
  timezone: string;
  hoursSchedule: Schedule;
  /** Storefront URL to hand the customer (wc.front_url, falling back to wc.url). */
  storefrontUrl: string;
  infoBlocks: { payment: string; shipping: string; general: string };
  complianceRules: string;
}

const TEMPLATES: Record<Language, (p: PromptParams) => string> = {
  es: buildEsPrompt,
  en: buildEnPrompt,
};

/** Build the agent's system prompt for a given conversation. */
export function buildSystemPrompt(
  ctx: ToolContext,
  resolved: ResolvedPromptConfig,
  now: Date = new Date(),
): string {
  const ar = nowInTimezone(now, resolved.timezone);
  const status = getStoreStatus(now, resolved.hoursSchedule, resolved.timezone, resolved.language);

  const params: PromptParams = {
    agentName: resolved.agentName,
    businessName: resolved.businessName,
    storefrontUrl: resolved.storefrontUrl,
    customerName: safeName(ctx.customerName),
    now: {
      weekday: ar.weekday,
      day: ar.day,
      month: ar.month,
      year: ar.year,
      hour: ar.hour,
      minute: ar.minute,
    },
    deliveryStatusLine: deliveryStatusLine(status, resolved.language),
    infoBlocks: {
      payment: resolved.infoBlocks.payment.trim(),
      shipping: resolved.infoBlocks.shipping.trim(),
      general: resolved.infoBlocks.general.trim(),
    },
    complianceRules: resolved.complianceRules.trim(),
    discloseBot: resolved.discloseBot,
    // Stays env-driven (not a runtime/dashboard setting) — see server/src/config.ts.
    maxBubbles: config.AGENT_MAX_BUBBLES,
  };

  return TEMPLATES[resolved.language](params);
}
