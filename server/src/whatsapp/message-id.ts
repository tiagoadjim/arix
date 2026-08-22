import { createHash } from 'node:crypto';

/**
 * Deterministic WhatsApp id derived from our durable idempotency key. Baileys
 * accepts a custom messageId, so an ambiguous retry reuses the same remote key
 * instead of creating a duplicate bubble.
 *
 * Lives apart from socket.ts on purpose: it is pure, and callers that only
 * need an id — the reminder dispatcher, tests — should not have to load the
 * whole Baileys stack (and its native bridge) to compute a hash.
 */
export function stableWhatsAppMessageId(clientId: string): string {
  return createHash('sha256').update(`arix-wa:${clientId}`).digest('hex').slice(0, 32).toUpperCase();
}
