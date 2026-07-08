import { config } from '../../config';
import type { ToolContext } from '../../types';
import { argentinaNow, deliveryStatusLine, getStoreStatus } from '../hours';
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

const TEMPLATES: Record<'es' | 'en', (p: PromptParams) => string> = {
  es: buildEsPrompt,
  en: buildEnPrompt,
};

/** Build the agent's system prompt for a given conversation. */
export function buildSystemPrompt(
  ctx: ToolContext,
  settings: Record<string, string> = {},
  now: Date = new Date(),
): string {
  const ar = argentinaNow(now);
  const status = getStoreStatus(now);
  // WC_FRONT_URL is optional — fall back to the REST domain when unset.
  const storefrontUrl = config.WC_FRONT_URL || config.WC_URL;

  const params: PromptParams = {
    agentName: config.AGENT_NAME,
    businessName: config.BUSINESS_NAME,
    storefrontUrl,
    customerName: safeName(ctx.customerName),
    now: {
      weekday: ar.weekday,
      day: ar.day,
      month: ar.month,
      year: ar.year,
      hour: ar.hour,
      minute: ar.minute,
    },
    deliveryStatusLine: deliveryStatusLine(status),
    infoBlocks: {
      payment: (settings.medios_de_pago ?? '').trim(),
      shipping: (settings.envios ?? '').trim(),
      general: (settings.info_general ?? '').trim(),
    },
    complianceRules: (settings.compliance_rules ?? '').trim(),
    discloseBot: config.AGENT_DISCLOSE_BOT,
    maxBubbles: config.AGENT_MAX_BUBBLES,
  };

  return TEMPLATES[config.AGENT_LANGUAGE](params);
}
