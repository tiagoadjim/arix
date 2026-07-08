import type { MessageType } from '../../types';
import { esGuardrails } from './es';
import { enGuardrails } from './en';

/**
 * Language-specific behavioral backstops + copy the agent harness (agent.ts)
 * needs beyond the system prompt itself: garbled-reply / wrong-language
 * detection, the catalog-grounding heuristics, and every literal string the
 * harness may send that isn't part of the prompt template.
 */
export interface Guardrails {
  /** True if a would-be reply looks like leaked reasoning or the wrong
   * language — a non-Latin-script backstop, language-agnostic by nature (it
   * applies the same way regardless of which language is configured). */
  looksGarbled(text: string): boolean;
  /** The customer is asking about the catalog (stock/prices/flavors/…) — a
   * turn that MUST be answered from a catalog tool, never from memory. */
  asksAboutCatalog(text: string): boolean;
  /** The reply asserts a concrete product/price/stock fact (grounded or not). */
  makesProductClaim(text: string): boolean;
  /** Generic "something went wrong" reply. */
  fallback: string;
  /** Safe hedge when the model still won't ground an answer in a catalog
   * lookup even after being forced to make one. */
  ungroundedFallback: string;
  /** Sent when MAX_STEPS is hit without a final answer. */
  maxStepsFallback: string;
  /** System nudge pushed after a garbled reply, asking for a clean retry. */
  garbledRetryNudge: string;
  /** System nudge forcing a grounded catalog lookup before answering again. */
  forceCatalogNudge: string;
  /** Placeholder text for a non-text inbound message with no body (audio,
   * sticker, …) — feeding the model empty content makes it hallucinate. */
  placeholderForMedia(type: MessageType): string;
  /** Prefix added before the caption when an image is attached. */
  imageAttachedPrefix: string;
  /** Default caption used when a receipt image arrives with no text. */
  receiptCaption: string;
}

const REGISTRY = {
  es: esGuardrails,
  en: enGuardrails,
} satisfies Record<'es' | 'en', Guardrails>;

/** The guardrail set (regexes + fallback copy) for the configured agent language. */
export function getGuardrails(lang: 'es' | 'en'): Guardrails {
  return REGISTRY[lang];
}
