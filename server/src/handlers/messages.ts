import { isJidGroup, type WAMessage, type WASocket, type proto } from 'baileys';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { downloadMedia, isVisionImage, normalizeReceiptImage, sniffMediaMime } from '../whatsapp/media';
import { readReceiptImage, saveReceiptImage } from '../storage';
import { pdfFirstPageToPng } from '../pdf';
import {
  getConversation,
  getOrCreateConversation,
  getUnansweredBotConversations,
  getRecentMessages,
  getAgentOutboxForTurn,
  getRecoverableAgentOutbox,
  getRecoverableHumanOutbox,
  isAgentOutboxTurnCurrent,
  insertInboundMessage,
  claimMessageForSending,
  cancelAgentOutboxForTurn,
  cancelOutboundMessage,
  getMessageByClientId,
  markMessageFailed,
  markMessageSent,
  prepareOutboundBatch,
  touchConversation,
} from '../db/repo';
import { runAgent } from '../agent/agent';
import { llm } from '../config/runtime';
import { stableWhatsAppMessageId, type WhatsAppGateway } from '../whatsapp/socket';
import type { Conversation, Message, MessageType, ToolContext } from '../types';
import { publishEvent } from '../events';
import { recordDomainEvent } from '../metrics';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Conversation-list preview label for messages with no text (non-receipt media).
const MEDIA_PREVIEW: Record<MessageType, string> = {
  text: '[mensaje]',
  image: '📎 Comprobante',
  audio: '🎤 Audio',
  video: '🎬 Video',
  sticker: '💟 Sticker',
  document: '📎 Archivo',
  other: '[mensaje]',
};

type LastImage = NonNullable<ToolContext['lastImage']>;

// Keep a receipt image attached for this long (the photo and the order number
// often arrive in separate messages), then drop it so it isn't reused later.
const IMAGE_TTL_MS = 15 * 60 * 1000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function agentTurnCursor(row: Pick<Message, 'conversation_id' | 'client_id'>): string | null {
  const parts = row.client_id?.split(':');
  if (parts?.length !== 4 || parts[0] !== 'agent' || parts[1] !== row.conversation_id) return null;
  return parts[2] || null;
}

// Conversations we've already warned about once (LLM not configured yet) — so
// the flush loop doesn't log the same warning on every debounce cycle while
// an operator finishes onboarding.
const warnedUnconfigured = new Set<string>();

/**
 * Split the agent's reply into separate WhatsApp bubbles. The agent separates bubbles
 * with a line containing only `---`. Overflow beyond `max` is merged into the last.
 */
export function splitBubbles(text: string, max: number): string[] {
  const parts = text
    .split(/\n?\s*---\s*\n?/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [text.trim()].filter(Boolean);
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join('\n\n')];
}

export interface ConvState {
  timer: NodeJS.Timeout | null;
  processing: boolean;
  dirty: boolean;
  /** Monotonic, in-memory generation bumped after every accepted inbound. */
  inboundGeneration: number;
  /** Latest generation handled by a persisted reply or an intentional no-reply rule. */
  processedGeneration: number;
  /** DB message id of the inbound represented by inboundGeneration. */
  inboundCursor: string | null;
  lastImage: LastImage | null;
  imageAt: number;
  /** Last time this conversation had real activity (an inbound message).
   * Used only by evictIdleStates() below — never read for behavior. */
  lastTouchedAt: number;
}

/** How long a conversation's in-memory state may sit idle before it's evicted. */
export const STATE_IDLE_TTL_MS = 30 * 60 * 1000; // 30 min
/** How often the sweep runs. */
export const STATE_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 min

/**
 * Remove idle entries from `states` in place — the fix for MessageRouter's
 * states Map growing forever (one entry per conversation ever seen, never
 * freed). An entry is evicted only when it has no pending debounce timer and
 * isn't mid-flush() (either would be lost mid-flight otherwise) AND has had
 * no activity for at least `idleMs`. A later message for that conversation
 * simply re-creates a fresh entry via state() — eviction only trims memory,
 * it never changes observable behavior. Pure + exported so it's unit-testable
 * without a real gateway/timers; returns the number of entries evicted.
 */
export function evictIdleStates(
  states: Map<string, ConvState>,
  now: number,
  idleMs: number = STATE_IDLE_TTL_MS,
): number {
  let evicted = 0;
  for (const [id, s] of states) {
    if (s.timer || s.processing) continue;
    if (now - s.lastTouchedAt >= idleMs) {
      states.delete(id);
      evicted += 1;
    }
  }
  return evicted;
}

/**
 * Drop any `warned` (warnedUnconfigured) entry whose conversation ID no
 * longer has a live entry in `states` — the fix for warnedUnconfigured
 * growing forever alongside states (one entry per conversation ever warned
 * about, never freed on its own). Run this AFTER evictIdleStates() in the
 * same sweep, so an idle-evicted conversation's warning is pruned too. Pure +
 * exported so it's unit-testable without a real gateway/timers.
 */
export function pruneWarnedUnconfigured(warned: Set<string>, states: Map<string, ConvState>): void {
  for (const id of warned) {
    if (!states.has(id)) warned.delete(id);
  }
}

/**
 * True when the trailing run of unanswered customer messages is made up only of
 * stickers. We stay quiet in that case (a bare 👍 sticker doesn't need a reply),
 * but if the run also contains text/audio/etc. we answer and the sticker is just
 * extra context. Lives here (used by flush) so both the debounce path and
 * recoverUnanswered share one rule.
 */
export function isLoneStickerRun(history: Message[]): boolean {
  const trailing: Message[] = [];
  for (let i = history.length - 1; i >= 0 && history[i]?.direction === 'in'; i -= 1) {
    trailing.push(history[i] as Message);
  }
  return trailing.length > 0 && trailing.every((m) => m.msg_type === 'sticker');
}

/** Recursively unwrap ephemeral / view-once / caption wrappers to real content. */
function unwrap(content: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
  let c = content;
  for (let i = 0; i < 5 && c; i += 1) {
    const inner =
      c.ephemeralMessage?.message ??
      c.viewOnceMessage?.message ??
      c.viewOnceMessageV2?.message ??
      c.viewOnceMessageV2Extension?.message ??
      c.documentWithCaptionMessage?.message;
    if (!inner) break;
    c = inner;
  }
  return c;
}

function classify(content: proto.IMessage): { type: MessageType; isImage: boolean } {
  if (content.imageMessage) return { type: 'image', isImage: true };
  if (content.stickerMessage) return { type: 'sticker', isImage: false };
  if (content.videoMessage) return { type: 'video', isImage: false };
  if (content.audioMessage) return { type: 'audio', isImage: false };
  if (content.documentMessage) return { type: 'document', isImage: false };
  return { type: 'text', isImage: false };
}

function extractText(content: proto.IMessage): string {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ''
  );
}

async function jidToPhone(jid: string, sock: WASocket): Promise<string | null> {
  if (jid.endsWith('@s.whatsapp.net')) {
    return jid.split('@')[0]?.split(':')[0] ?? null;
  }
  if (jid.endsWith('@lid')) {
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) return pn.split('@')[0]?.split(':')[0] ?? null;
    } catch {
      /* best-effort */
    }
  }
  return null;
}

export class MessageRouter {
  private states = new Map<string, ConvState>();
  private readonly sweepTimer: NodeJS.Timeout;
  private stopped = false;
  private readonly recoveryTimer: NodeJS.Timeout;
  private recoveryRunning = false;
  private readonly activeTurnControllers = new Map<string, AbortController>();
  private readonly activeFlushes = new Set<Promise<void>>();

  constructor(private readonly gateway: WhatsAppGateway) {
    // unref()'d so an idle sweep timer never keeps the process (or a test)
    // alive on its own.
    this.sweepTimer = setInterval(() => {
      evictIdleStates(this.states, Date.now());
      pruneWarnedUnconfigured(warnedUnconfigured, this.states);
    }, STATE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    this.recoveryTimer = setInterval(() => {
      if (this.gateway.connected) void this.recoverUnanswered();
    }, config.OUTBOX_RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  private runFlush(conversationId: string): Promise<void> {
    const work = this.flush(conversationId);
    this.activeFlushes.add(work);
    void work.finally(() => this.activeFlushes.delete(work));
    return work;
  }

  private state(id: string): ConvState {
    let s = this.states.get(id);
    if (!s) {
      s = {
        timer: null,
        processing: false,
        dirty: false,
        inboundGeneration: 0,
        processedGeneration: 0,
        inboundCursor: null,
        lastImage: null,
        imageAt: 0,
        lastTouchedAt: Date.now(),
      };
      this.states.set(id, s);
    }
    return s;
  }

  /** Arm one tracked flush timer, replacing any older debounce/retry timer. */
  private scheduleFlush(conversationId: string, waitMs: number): void {
    const st = this.state(conversationId);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      void this.runFlush(conversationId);
    }, waitMs);
  }

  async handle(sock: WASocket, msg: WAMessage): Promise<void> {
    if (this.stopped) return;
    const jid = msg.key.remoteJid;
    if (!jid || isJidGroup(jid) || jid === 'status@broadcast') return;

    const content = unwrap(msg.message);
    if (!content) return;

    const { type, isImage } = classify(content);
    const text = extractText(content).trim();
    const waMessageId = msg.key.id ?? null;

    // Receipts often arrive as a PDF document — rasterize page 1 so the agent can read it.
    const docMime = content.documentMessage?.mimetype ?? '';
    const docName = content.documentMessage?.fileName ?? '';
    const isPdf = type === 'document' && (/pdf/i.test(docMime) || /\.pdf$/i.test(docName));

    // Skip empty non-media events (reactions, protocol, receipts…).
    if (type === 'text' && !text) return;

    const phone = await jidToPhone(jid, sock);
    const name = msg.pushName ?? null;

    // Download + store a receipt (image or PDF→PNG) so the agent can read it and the dashboard can show it.
    let mediaUrl: string | null = null;
    let mediaMime: string | null = null;
    let lastImage: LastImage | null = null;
    if (isImage || isPdf) {
      const media = await downloadMedia(
        sock,
        msg,
        content,
        isPdf ? Math.min(config.MAX_MEDIA_BYTES, config.MAX_PDF_BYTES) : config.MAX_MEDIA_BYTES,
      );
      if (media) {
        let decodedSource: Buffer | null = null;
        const sniffed = sniffMediaMime(media.buffer);
        if (isPdf && sniffed === 'application/pdf') {
          decodedSource = await pdfFirstPageToPng(media.buffer);
        } else if (isImage && sniffed && isVisionImage(sniffed) && isVisionImage(media.mime)) {
          decodedSource = media.buffer;
        } else {
          logger.warn(
            { declaredMime: media.mime, sniffedMime: sniffed },
            'discarding receipt media whose bytes do not match an allowed image/PDF type',
          );
        }
        const normalized = decodedSource ? await normalizeReceiptImage(decodedSource) : null;
        if (normalized) {
          // Persist using the MIME established from the bytes, not the
          // untrusted declared MIME. The authenticated media route derives its
          // response Content-Type from this extension and sends nosniff.
          const ext = EXT[normalized.mime] ?? 'jpg';
          const objectPath = `${config.WA_ACCOUNT_ID}/${jid.replace(/[^\w.-]/g, '_')}/${waMessageId ?? Date.now()}.${ext}`;
          mediaUrl = await saveReceiptImage(normalized.buffer, objectPath);
          mediaMime = normalized.mime;
          lastImage = {
            base64: normalized.buffer.toString('base64'),
            mime: normalized.mime,
            mediaUrl,
            messageId: null, // filled after we know the DB message id
            sha256: createHash('sha256').update(normalized.buffer).digest('hex'),
          };
        }
      }
    }

    const conv = await getOrCreateConversation({ jid, phone, name });

    const hasMedia = isImage || isPdf;
    const inserted = await insertInboundMessage({
      conversationId: conv.id,
      waMessageId,
      msgType: type,
      // Keep body null for any non-text media so the model's placeholder
      // (in agent/guardrails) is the single source of truth for what it "reads".
      body: text || (type === 'text' ? '' : null),
      mediaUrl,
      mediaMime,
    });
    if (!inserted) return; // duplicate — already processed

    // Advance the turn cursor immediately after the inbound is durably
    // accepted, before any further await. A flush already inside runAgent()
    // can now see that its snapshot is stale and must not be sent.
    const st = this.state(conv.id);
    st.lastTouchedAt = Date.now();
    st.inboundGeneration += 1;
    st.inboundCursor = inserted.id;
    // Stop spending provider/tool budget on an answer that is already stale.
    // Durable tools reconcile any ambiguous side effect before they settle.
    this.cancelConversationTurn(conv.id, 'new inbound message');

    await touchConversation(conv.id, {
      preview: text || (hasMedia ? '📎 Comprobante' : MEDIA_PREVIEW[type]),
      incomingFromCustomer: true,
    });
    recordDomainEvent('inbound_messages');
    publishEvent({ type: 'message.created', conversationId: conv.id });

    if (lastImage) {
      st.lastImage = { ...lastImage, messageId: inserted.id };
      st.imageAt = Date.now();
    }

    // Human has taken over → just record; the dashboard handles the reply.
    if (conv.mode === 'human') return;

    // Debounce rapid-fire messages, then let the agent answer with full context.
    this.scheduleFlush(conv.id, config.AGENT_DEBOUNCE_MS);
  }

  private async transportAgentOutbox(
    conv: Conversation,
    row: Message,
    turnChanged: () => boolean,
    scheduleRetry = true,
  ): Promise<'sent' | 'wait' | 'stale'> {
    if (row.send_status === 'sent') return 'sent';
    const claimed = await claimMessageForSending(row.id);
    if (!claimed) {
      const current = row.client_id ? await getMessageByClientId(row.client_id) : null;
      if (current?.send_status === 'sent') return 'sent';
      if (current?.send_status === 'cancelled') return 'stale';
      if (scheduleRetry) this.scheduleFlush(conv.id, 2_000);
      return 'wait';
    }
    const attemptId = claimed.send_attempt_id;
    if (!attemptId) throw new Error('claimed outbound message has no send attempt token');

    // All DB awaits (prepare + claim) are now behind us. Revalidate both the
    // inbound generation and takeover state, then invoke sendText immediately.
    const latestConversation = await getConversation(conv.id);
    if (this.stopped || turnChanged() || latestConversation?.mode !== 'bot') {
      await cancelOutboundMessage(claimed.id, latestConversation?.mode === 'human' ? 'human_takeover' : 'stale_turn');
      return 'stale';
    }

    const requestedWaId = claimed.wa_message_id ?? stableWhatsAppMessageId(claimed.client_id ?? claimed.id);
    try {
      const actualWaId = await this.gateway.sendText(conv.wa_jid, claimed.body ?? '', requestedWaId);
      const finalized = await markMessageSent(claimed.id, attemptId, actualWaId ?? requestedWaId);
      if (!finalized) {
        const current = claimed.client_id ? await getMessageByClientId(claimed.client_id) : null;
        if (current?.send_status === 'sent') return 'sent';
        if (current?.send_status === 'cancelled') return 'stale';
        return 'wait';
      }
      recordDomainEvent('outbound_messages');
      publishEvent({ type: 'message.updated', conversationId: conv.id });
      return 'sent';
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : 'send_failed';
      const finalized = await markMessageFailed(claimed.id, attemptId, error).catch(() => false);
      publishEvent({ type: 'message.updated', conversationId: conv.id });
      if (!finalized) {
        const current = claimed.client_id ? await getMessageByClientId(claimed.client_id) : null;
        if (current?.send_status === 'sent') return 'sent';
        if (current?.send_status === 'cancelled') return 'stale';
        return 'wait';
      }
      throw err;
    }
  }

  private async recoverHumanOutbound(row: Awaited<ReturnType<typeof getRecoverableHumanOutbox>>[number]): Promise<void> {
    if (this.stopped || !this.gateway.connected) return;
    const claimed = await claimMessageForSending(row.id);
    if (!claimed) return;
    const attemptId = claimed.send_attempt_id;
    if (!attemptId) throw new Error('claimed outbound message has no send attempt token');
    const conversation = await getConversation(claimed.conversation_id);
    if (conversation?.mode !== 'human') {
      await cancelOutboundMessage(claimed.id, 'conversation_not_human');
      return;
    }
    const requestedWaId = claimed.wa_message_id ?? stableWhatsAppMessageId(claimed.client_id ?? claimed.id);
    try {
      const actualWaId = await this.gateway.sendText(row.wa_jid, claimed.body ?? '', requestedWaId);
      if (!(await markMessageSent(claimed.id, attemptId, actualWaId ?? requestedWaId))) return;
      await touchConversation(claimed.conversation_id, { preview: claimed.body ?? '', incomingFromCustomer: false });
      recordDomainEvent('outbound_messages');
      publishEvent({ type: 'message.updated', conversationId: claimed.conversation_id });
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : 'send_failed';
      await markMessageFailed(claimed.id, attemptId, error).catch(() => false);
    }
  }

  private async recoverAgentOutboxTurn(candidate: Awaited<ReturnType<typeof getRecoverableAgentOutbox>>[number]): Promise<void> {
    const turnCursor = agentTurnCursor(candidate);
    if (!turnCursor || this.stopped || !this.gateway.connected) return;
    try {
      const conv = await getConversation(candidate.conversation_id);
      if (!conv || conv.mode !== 'bot') {
        await cancelAgentOutboxForTurn(candidate.conversation_id, turnCursor, 'conversation_not_bot');
        return;
      }
      if (!(await isAgentOutboxTurnCurrent(conv.id, turnCursor))) {
        await cancelAgentOutboxForTurn(conv.id, turnCursor, 'stale_turn');
        return;
      }

      const st = this.state(conv.id);
      const generation = st.inboundGeneration;
      const cursor = st.inboundCursor;
      const changed = () =>
        this.stopped || st.inboundGeneration !== generation || st.inboundCursor !== cursor;
      const rows = await getAgentOutboxForTurn(conv.id, turnCursor);
      let lastSentBody = rows.at(-1)?.body ?? '';
      for (const row of rows) {
        if (changed()) {
          await cancelAgentOutboxForTurn(conv.id, turnCursor, 'stale_turn');
          return;
        }
        const outcome = await this.transportAgentOutbox(conv, row, changed, false);
        if (outcome === 'wait') return;
        if (outcome === 'stale') {
          await cancelAgentOutboxForTurn(conv.id, turnCursor, 'stale_turn');
          return;
        }
        lastSentBody = row.body ?? lastSentBody;
      }
      if (rows.length > 0) {
        await touchConversation(conv.id, { preview: lastSentBody, incomingFromCustomer: false });
        publishEvent({ type: 'conversation.updated', conversationId: conv.id });
      }
    } catch (err) {
      logger.warn({ err, conversationId: candidate.conversation_id }, 'failed to recover agent outbox turn');
    }
  }

  private async flush(conversationId: string): Promise<void> {
    if (this.stopped) return;
    const st = this.state(conversationId);
    if (st.processing) {
      st.dirty = true;
      return;
    }
    st.processing = true;
    const turnController = new AbortController();
    this.activeTurnControllers.set(conversationId, turnController);
    // Cancel any armed debounce timer so it can't fire a second time after this run.
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    try {
      const conv = await getConversation(conversationId);
      if (!conv || conv.mode === 'human') return;

      // Drop a stale receipt image so it isn't attached to unrelated later turns.
      if (st.lastImage && Date.now() - st.imageAt > IMAGE_TTL_MS) {
        st.lastImage = null;
        st.imageAt = 0;
      }

      const persistedHistory = await getRecentMessages(conversationId);
      const tailCursorAtStart = persistedHistory[persistedHistory.length - 1]?.id ?? null;

      // Normally the DB tail is the inbound we're answering. There is one
      // important exception: an inbound can land while sendText() for an older
      // turn is in flight, so that old outbound is persisted *after* the new
      // inbound. The generation/cursor tells us the inbound still pending; cut
      // history at that cursor so the stale outbound cannot hide/reorder it.
      let history = persistedHistory;
      if (st.inboundCursor && st.inboundGeneration > st.processedGeneration) {
        const cursorIndex = persistedHistory.findIndex((m) => m.id === st.inboundCursor);
        if (cursorIndex >= 0) history = persistedHistory.slice(0, cursorIndex + 1);
      }

      // Idempotency: only answer if the latest message is still an unanswered
      // customer message. Guards against double replies when the normal debounce
      // and recoverUnanswered (on reconnect) both fire for the same turn.
      const last = history[history.length - 1];
      if (!last || last.direction !== 'in') return;

      // recoverUnanswered() may create a fresh in-memory state for a persisted
      // inbound. Adopt that DB cursor as generation 1 before starting the turn.
      if (st.inboundCursor !== last.id) {
        st.inboundGeneration += 1;
        st.inboundCursor = last.id;
      } else if (st.processedGeneration >= st.inboundGeneration) {
        // A no-reply terminal turn (currently a lone sticker) can leave the
        // inbound at the DB tail; don't reconsider the same generation forever.
        return;
      }
      const turnGeneration = st.inboundGeneration;
      const turnCursor = last.id;
      const turnChanged = () =>
        turnController.signal.aborted ||
        st.inboundGeneration !== turnGeneration ||
        st.inboundCursor !== turnCursor;

      // Don't reply to lone sticker(s) — like a real person, a bare 👍 sticker
      // doesn't deserve an answer. Any text/audio/etc. mixed in means we reply.
      if (isLoneStickerRun(history)) {
        st.processedGeneration = Math.max(st.processedGeneration, turnGeneration);
        return;
      }

      // A previous process may have durably prepared this turn's bubble before
      // crashing. Retry the stored payload directly instead of paying for a new
      // LLM turn (and potentially generating a different reply).
      const existingOutbox = await getAgentOutboxForTurn(conversationId, turnCursor);
      if (existingOutbox.length > 0) {
        let lastSentBody = existingOutbox.at(-1)?.body ?? '';
        for (const row of existingOutbox) {
          const outcome = await this.transportAgentOutbox(conv, row, turnChanged);
          if (outcome === 'wait') return;
          if (outcome === 'stale') {
            await cancelAgentOutboxForTurn(conversationId, turnCursor, 'stale_turn');
            if (turnChanged()) st.dirty = true;
            return;
          }
          lastSentBody = row.body ?? lastSentBody;
        }
        st.processedGeneration = Math.max(st.processedGeneration, turnGeneration);
        await touchConversation(conversationId, { preview: lastSentBody, incomingFromCustomer: false });
        publishEvent({ type: 'conversation.updated', conversationId });
        if (turnChanged()) st.dirty = true;
        return;
      }

      if (!st.lastImage && last.media_url && last.media_mime && isVisionImage(last.media_mime)) {
        const persistedImage = await readReceiptImage(last.media_url);
        if (persistedImage) {
          st.lastImage = {
            base64: persistedImage.toString('base64'),
            mime: last.media_mime,
            mediaUrl: last.media_url,
            messageId: last.id,
            sha256: createHash('sha256').update(persistedImage).digest('hex'),
          };
          st.imageAt = Date.now();
        }
      }
      const ctx: ToolContext = {
        conversationId,
        jid: conv.wa_jid,
        phone: conv.phone,
        customerName: conv.customer_name,
        lastImage: st.lastImage,
        // Clear the image only once a payment is actually confirmed. It stays
        // available across the photo→order-number exchange (separate messages).
        onReceiptConsumed: () => {
          // A newer inbound may have replaced lastImage while this turn was
          // running. An obsolete tool result must never consume that new image.
          if (turnChanged()) return;
          st.lastImage = null;
          st.imageAt = 0;
        },
      };

      // Unconfigured guard: no LLM API key set anywhere (env or dashboard) yet —
      // never attempt to answer. The conversation just stays visible/unanswered
      // in the inbox until an operator finishes onboarding; nothing crashes.
      if (!(await llm()).configured) {
        if (!warnedUnconfigured.has(conversationId)) {
          warnedUnconfigured.add(conversationId);
          logger.warn({ conversationId }, 'LLM is not configured yet — leaving the conversation unanswered');
        }
        return;
      }
      // Once the LLM becomes configured, every prior "unconfigured" warning is
      // moot — clear them all instead of leaving the set to only ever shrink
      // one conversation at a time via pruneWarnedUnconfigured().
      if (warnedUnconfigured.size > 0) warnedUnconfigured.clear();

      await this.gateway.indicateTyping(conv.wa_jid);
      const reply = await runAgent(ctx, history, { signal: turnController.signal });
      if (this.stopped || turnController.signal.aborted) {
        if (turnChanged()) st.dirty = true;
        return;
      }

      // A human may have taken over while the agent was thinking — don't talk over them.
      const after = await getConversation(conversationId);
      if (after?.mode === 'human') return;

      // The most common race: handle() accepted another inbound while
      // runAgent() was thinking. Never send the now-obsolete answer; explicitly
      // queue the latest generation so it is processed even if its long
      // debounce timer has not fired yet.
      if (turnChanged()) {
        st.dirty = true;
        return;
      }

      // Also validate the persisted tail. This catches an inbound written by
      // another router/process that did not advance this instance's generation.
      const currentTail = (await getRecentMessages(conversationId, 1))[0];
      if (turnChanged()) {
        st.dirty = true;
        return;
      }
      if (currentTail && currentTail.id !== tailCursorAtStart) {
        if (currentTail.direction === 'in') {
          if (st.inboundCursor !== currentTail.id) {
            st.inboundGeneration += 1;
            st.inboundCursor = currentTail.id;
          }
          st.dirty = true;
        } else {
          // Another sender answered while this model turn was running.
          st.processedGeneration = Math.max(st.processedGeneration, turnGeneration);
        }
        return;
      }

      // Send as up to N separate bubbles (feels more human than one long block).
      const bubbles = splitBubbles(reply, config.AGENT_MAX_BUBBLES);
      const batchInput = bubbles.map((bubble, index) => {
        const clientId = `agent:${conversationId}:${turnCursor}:${index}`;
        return {
          body: bubble,
          clientId,
          waMessageId: stableWhatsAppMessageId(clientId),
        };
      });
      const outbox = await prepareOutboundBatch({
        conversationId,
        sender: 'agent',
        messages: batchInput,
      });
      if (
        outbox.length !== batchInput.length ||
        outbox.some((row, index) =>
          row.conversation_id !== conversationId ||
          row.sender !== 'agent' ||
          row.body !== batchInput[index]?.body ||
          row.client_id !== batchInput[index]?.clientId)
      ) {
        throw new Error('agent outbox idempotency key collision');
      }
      let lastSentBody = reply;
      for (const [i, row] of outbox.entries()) {
        const bubble = row.body ?? '';
        if (i > 0) await delay(600 + Math.min(1400, bubble.length * 20));
        if (turnChanged()) {
          await cancelAgentOutboxForTurn(conversationId, turnCursor, 'stale_turn');
          st.dirty = true;
          return;
        }
        if (this.stopped) return;
        await this.gateway.indicateTyping(conv.wa_jid, 700);
        // No await between this final generation check and sendText(): once the
        // gateway call starts it cannot be cancelled safely.
        if (turnChanged()) {
          await cancelAgentOutboxForTurn(conversationId, turnCursor, 'stale_turn');
          st.dirty = true;
          return;
        }
        const outcome = await this.transportAgentOutbox(conv, row, turnChanged);
        if (outcome === 'wait') return;
        if (outcome === 'stale') {
          await cancelAgentOutboxForTurn(conversationId, turnCursor, 'stale_turn');
          if (turnChanged()) st.dirty = true;
          return;
        }
        lastSentBody = (await getMessageByClientId(batchInput[i]!.clientId))?.body ?? row.body ?? bubble;
        // Persisting the outbound is mandatory once WhatsApp accepted it. If a
        // new inbound arrived during sendText()/insert, mark the old generation
        // handled but stop the remaining bubbles and process the new cursor.
        st.processedGeneration = Math.max(st.processedGeneration, turnGeneration);
        if (turnChanged()) {
          await cancelAgentOutboxForTurn(conversationId, turnCursor, 'stale_turn');
          st.dirty = true;
          return;
        }
      }
      st.processedGeneration = Math.max(st.processedGeneration, turnGeneration);
      await touchConversation(conversationId, {
        preview: lastSentBody,
        incomingFromCustomer: false,
      });
      publishEvent({ type: 'conversation.updated', conversationId });
      if (turnChanged()) st.dirty = true;
    } catch (err) {
      logger.error({ err, conversationId }, 'failed to process conversation turn');
    } finally {
      if (this.activeTurnControllers.get(conversationId) === turnController) {
        this.activeTurnControllers.delete(conversationId);
      }
      st.processing = false;
      if (st.dirty && !this.stopped) {
        st.dirty = false;
        this.scheduleFlush(conversationId, 250);
      }
    }
  }

  /**
   * On (re)connect, answer customers whose last message went unanswered — e.g.
   * the process restarted within the debounce window, losing the in-memory timer.
   */
  async recoverUnanswered(): Promise<void> {
    if (this.stopped || this.recoveryRunning || !this.gateway.connected) return;
    this.recoveryRunning = true;
    try {
      const humanOutbox = await getRecoverableHumanOutbox(config.AGENT_RECOVERY_BATCH_SIZE);
      for (let index = 0; index < humanOutbox.length; index += config.AGENT_RECOVERY_CONCURRENCY) {
        const batch = humanOutbox.slice(index, index + config.AGENT_RECOVERY_CONCURRENCY);
        await Promise.all(batch.map((row) => this.recoverHumanOutbound(row)));
        if (this.stopped) return;
      }

      const agentCandidates = await getRecoverableAgentOutbox(config.AGENT_RECOVERY_BATCH_SIZE);
      const uniqueAgentTurns = new Map<string, (typeof agentCandidates)[number]>();
      for (const candidate of agentCandidates) {
        const cursor = agentTurnCursor(candidate);
        if (cursor) uniqueAgentTurns.set(`${candidate.conversation_id}:${cursor}`, candidate);
      }
      const agentTurns = [...uniqueAgentTurns.values()];
      for (let index = 0; index < agentTurns.length; index += config.AGENT_RECOVERY_CONCURRENCY) {
        const batch = agentTurns.slice(index, index + config.AGENT_RECOVERY_CONCURRENCY);
        await Promise.all(batch.map((row) => this.recoverAgentOutboxTurn(row)));
        if (this.stopped) return;
      }

      const convs = await getUnansweredBotConversations(config.AGENT_RECOVERY_BATCH_SIZE);
      let recovered = 0;
      for (let index = 0; index < convs.length; index += config.AGENT_RECOVERY_CONCURRENCY) {
        const batch = convs.slice(index, index + config.AGENT_RECOVERY_CONCURRENCY);
        await Promise.all(
          batch.map(async (c) => {
            const st = this.states.get(c.id);
            if (st && (st.timer || st.processing)) return;
            recovered += 1;
            await this.runFlush(c.id);
          }),
        );
        if (this.stopped) return;
      }
      if (recovered) logger.info({ recovered }, 'recovering unanswered conversations');
    } catch (err) {
      logger.error({ err }, 'recoverUnanswered failed');
    } finally {
      this.recoveryRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    clearInterval(this.recoveryTimer);
    for (const controller of this.activeTurnControllers.values()) {
      controller.abort(new Error('message router shutting down'));
    }
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.dirty = false;
    }
    if (this.activeFlushes.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.activeFlushes]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref();
        }),
      ]);
    }
  }

  /** Cancel the active LLM/tool budget for one conversation. Used by newer
   * inbound messages and explicit human takeover; final mode/generation checks
   * still fence transport even if a provider ignores AbortSignal. */
  cancelConversationTurn(conversationId: string, reason = 'conversation turn cancelled'): void {
    this.activeTurnControllers.get(conversationId)?.abort(new Error(reason));
  }
}
