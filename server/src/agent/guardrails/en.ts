import type { MessageType } from '../../types';
import type { Guardrails } from './index';

// Cyrillic, Greek, Hiragana/Katakana, CJK and Hangul — none of which an
// English-speaking customer ever legitimately receives. Used as a backstop to
// catch leaked reasoning / wrong-language replies that slip past reasoning_split.
const SUSPECT_SCRIPT = /[Ѐ-ԯͰ-Ͽ぀-ヿ㐀-䶿一-鿿가-힣]/;

/** True if a would-be reply looks like leaked reasoning or the wrong language. */
function looksGarbled(text: string): boolean {
  if (!text) return false;
  if (SUSPECT_SCRIPT.test(text)) return true; // non-Latin script → not English
  if (/<\/?think>/i.test(text)) return true; // leftover reasoning tag
  return false;
}

// The customer is asking about the catalog (what's in stock, prices, flavors,
// brands/models…) — a turn that MUST be answered from 'search_catalog', never
// from the model's memory.
const ASKS_CATALOG =
  /\b(what.*\b(do you have|have you got|is there)\b|do you have|got any|have any|price|prices|how much|cost|costs|in stock|stock|available|availability|flavou?r|flavou?rs|brand|brands|model|models|recommend)/i;

// The reply is asserting a concrete product fact (a price, a stock status, a
// "we have/carry"): if it wasn't grounded in a catalog lookup it may be invented.
const CLAIMS_PRODUCT =
  /(\$\s*\d|\d+\s*(dollars|bucks|usd)|in\s+stock|out\s+of\s+stock|available|we\s+have|we\s+carry|we\s+offer)/i;

/** Customer intent that requires a catalog lookup before answering. */
function asksAboutCatalog(text: string): boolean {
  return !!text && ASKS_CATALOG.test(text);
}

/** A reply that states a product/price/stock fact (grounded or not). */
function makesProductClaim(text: string): boolean {
  return !!text && CLAIMS_PRODUCT.test(text);
}

/**
 * A non-text message (sticker, audio, …) arrives with no body. Feeding the model
 * an empty user turn makes a thinking model emit degenerate output / leaked
 * reasoning, sometimes in another language. Give it a clear note instead so it
 * answers naturally (the prompt tells the agent not to echo these bracketed notes).
 */
function placeholderForMedia(type: MessageType): string {
  switch (type) {
    case 'audio':
      return '[The customer sent a voice note you cannot listen to]';
    case 'sticker':
      return '[The customer sent a sticker]';
    case 'video':
      return '[The customer sent a video]';
    case 'image':
      return '[The customer sent an image]';
    case 'document':
      return '[The customer sent a file]';
    default:
      return '[The customer sent a message you cannot interpret]';
  }
}

export const enGuardrails: Guardrails = {
  looksGarbled,
  asksAboutCatalog,
  makesProductClaim,
  fallback:
    "Sorry, I had a little hiccup processing that 🙈. Could you say that again? If it keeps happening, I'll get a teammate to jump in.",
  // Sent when the model insists on talking about products without ever querying the
  // catalog (even after we force the tool): better a hedge than a fabricated price/stock.
  ungroundedFallback: "Let me double check the stock and prices and I'll confirm right away 🙏",
  maxStepsFallback: "Give me just a moment, I'm working on your question 🙏",
  garbledRetryNudge:
    'IMPORTANT: reply ONLY in English, with just the final message for the customer — no reasoning, no other language or alphabet.',
  forceCatalogNudge:
    "IMPORTANT: don't give product names, prices, stock or flavors without checking the real catalog. Call search_catalog and answer ONLY with what it returns.",
  placeholderForMedia,
  imageAttachedPrefix: '[image attached] ',
  receiptCaption: "Here's the transfer receipt.",
  visionUnsupportedAskDetails:
    "IMPORTANT: you can't see the image the customer sent (this AI provider has no vision support). Ask them in text for their order number and the amount they paid so you can confirm it yourself.",
  visionUnsupportedHandoff:
    "IMPORTANT: you can't see the image the customer sent (this AI provider has no vision support). Call handoff_to_human so a teammate can review the receipt.",
};
