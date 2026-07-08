import type { MessageType } from '../../types';
import type { Guardrails } from './index';

// Cyrillic, Greek, Hiragana/Katakana, CJK and Hangul — none of which a
// Spanish-speaking customer ever legitimately receives. Used as a backstop to
// catch leaked reasoning / wrong-language replies that slip past reasoning_split.
const SUSPECT_SCRIPT = /[Ѐ-ԯͰ-Ͽ぀-ヿ㐀-䶿一-鿿가-힣]/;

/** True if a would-be reply looks like leaked reasoning or the wrong language. */
function looksGarbled(text: string): boolean {
  if (!text) return false;
  if (SUSPECT_SCRIPT.test(text)) return true; // non-Latin script → not Spanish
  if (/<\/?think>/i.test(text)) return true; // leftover reasoning tag
  return false;
}

// The customer is asking about the catalog (what's in stock, prices, flavors,
// brands/models…) — a turn that MUST be answered from 'search_catalog', never
// from the model's memory.
const ASKS_CATALOG =
  /\b(qu[eé]\s+(tienen|hay|ten[eé]s)|ten[eé]s|tienen|hay|precio|precios|cu[aá]nto|sale|cuesta|stock|disponib|sabor|sabores|marca|marcas|modelo|vape|vapes|pod|pods|descartab|elf\s*bar|recomend[aá])/i;

// The reply is asserting a concrete product fact (a price, a stock status, a
// "we have/carry"): if it wasn't grounded in a catalog lookup it may be invented.
const CLAIMS_PRODUCT =
  /(\$\s*\d|\d\s*(pesos|mil)|en\s+stock|sin\s+stock|disponible|tenemos|contamos\s+con)/i;

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
      return '[El cliente te envió un mensaje de audio que no podés escuchar]';
    case 'sticker':
      return '[El cliente te envió un sticker]';
    case 'video':
      return '[El cliente te envió un video]';
    case 'image':
      return '[El cliente te envió una imagen]';
    case 'document':
      return '[El cliente te envió un archivo]';
    default:
      return '[El cliente te envió un mensaje que no podés interpretar]';
  }
}

export const esGuardrails: Guardrails = {
  looksGarbled,
  asksAboutCatalog,
  makesProductClaim,
  fallback:
    'Perdón, tuve un problemita para procesar eso 🙈. ¿Lo podés repetir? Si seguís con problemas, te paso con una persona del equipo.',
  // Sent when the model insists on talking about products without ever querying the
  // catalog (even after we force the tool): better a hedge than a fabricated price/stock.
  ungroundedFallback: 'Uy, dejame chequear bien el stock y los precios y te confirmo al toque 🙏',
  maxStepsFallback: 'Dame un momentito que estoy procesando tu consulta 🙏',
  garbledRetryNudge:
    'IMPORTANTE: respondé ÚNICAMENTE en español rioplatense, solo con el mensaje final para el cliente, sin razonamiento, sin otro idioma ni otro alfabeto.',
  forceCatalogNudge:
    'IMPORTANTE: no des nombres de productos, precios, stock ni sabores sin consultar el catálogo real. Llamá a search_catalog y respondé SOLO con lo que devuelva.',
  placeholderForMedia,
  imageAttachedPrefix: '[imagen adjunta] ',
  receiptCaption: 'Te mando el comprobante de la transferencia.',
};
