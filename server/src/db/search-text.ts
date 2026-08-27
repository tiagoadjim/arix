/**
 * Search-text normalization for the knowledge base.
 *
 * Postgres can strip accents itself, but only through the `unaccent`
 * extension, which needs privileges a managed Postgres may not grant. Doing it
 * here instead keeps the migration runnable on any database, makes the
 * behaviour unit-testable without a server, and — most importantly — keeps the
 * WRITE path and the QUERY path provably identical: both call this function,
 * so an entry stored as "envíos" is found by someone typing "envios", which on
 * WhatsApp is most people.
 *
 * The stored `search_text` column is derived, never displayed: the original
 * question/answer are kept verbatim for the model to read.
 */

/** Combining diacritical marks, left over after an NFD decomposition.
 * Folds ñ → n and ü → u as well: those are distinct letters in Spanish, but
 * for SEARCH the fold is what the user wants — plenty of people type "nino"
 * or "manana" on a phone keyboard and still expect a hit. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalizeSearchText(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
