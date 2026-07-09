import { isJidGroup, type WAMessage, type WASocket, type proto } from 'baileys';
import { config } from '../config';
import { logger } from '../logger';
import { downloadMedia, isVisionImage } from '../whatsapp/media';
import { saveReceiptImage } from '../storage';
import { pdfFirstPageToPng } from '../pdf';
import {
  getConversation,
  getOrCreateConversation,
  getRecentBotConversations,
  getRecentMessages,
  insertInboundMessage,
  insertOutboundMessage,
  touchConversation,
} from '../db/repo';
import { runAgent } from '../agent/agent';
import { llm } from '../config/runtime';
import type { WhatsAppGateway } from '../whatsapp/socket';
import type { Message, MessageType, ToolContext } from '../types';

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

  constructor(private readonly gateway: WhatsAppGateway) {
    // unref()'d so an idle sweep timer never keeps the process (or a test)
    // alive on its own.
    this.sweepTimer = setInterval(() => {
      evictIdleStates(this.states, Date.now());
      pruneWarnedUnconfigured(warnedUnconfigured, this.states);
    }, STATE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private state(id: string): ConvState {
    let s = this.states.get(id);
    if (!s) {
      s = { timer: null, processing: false, dirty: false, lastImage: null, imageAt: 0, lastTouchedAt: Date.now() };
      this.states.set(id, s);
    }
    return s;
  }

  async handle(sock: WASocket, msg: WAMessage): Promise<void> {
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
      const media = await downloadMedia(sock, msg, content);
      if (media) {
        let visionBuf: Buffer | null = null;
        let visionMime = 'image/png';
        if (isPdf) {
          visionBuf = await pdfFirstPageToPng(media.buffer);
        } else if (isVisionImage(media.mime)) {
          visionBuf = media.buffer;
          visionMime = media.mime;
        }
        if (visionBuf) {
          const ext = isPdf ? 'png' : EXT[media.mime.toLowerCase()] ?? 'jpg';
          const objectPath = `${config.WA_ACCOUNT_ID}/${jid.replace(/[^\w.-]/g, '_')}/${waMessageId ?? Date.now()}.${ext}`;
          mediaUrl = await saveReceiptImage(visionBuf, objectPath);
          mediaMime = visionMime;
          lastImage = {
            base64: visionBuf.toString('base64'),
            mime: visionMime,
            mediaUrl,
            messageId: null, // filled after we know the DB message id
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

    await touchConversation(conv.id, {
      preview: text || (hasMedia ? '📎 Comprobante' : MEDIA_PREVIEW[type]),
      incomingFromCustomer: true,
    });

    const st = this.state(conv.id);
    st.lastTouchedAt = Date.now();
    if (lastImage) {
      st.lastImage = { ...lastImage, messageId: inserted.id };
      st.imageAt = Date.now();
    }

    // Human has taken over → just record; the dashboard handles the reply.
    if (conv.mode === 'human') return;

    // Debounce rapid-fire messages, then let the agent answer with full context.
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      void this.flush(conv.id);
    }, config.AGENT_DEBOUNCE_MS);
  }

  private async flush(conversationId: string): Promise<void> {
    const st = this.state(conversationId);
    if (st.processing) {
      st.dirty = true;
      return;
    }
    st.processing = true;
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

      const history = await getRecentMessages(conversationId);
      // Idempotency: only answer if the latest message is still an unanswered
      // customer message. Guards against double replies when the normal debounce
      // and recoverUnanswered (on reconnect) both fire for the same turn.
      const last = history[history.length - 1];
      if (!last || last.direction !== 'in') return;
      // Don't reply to lone sticker(s) — like a real person, a bare 👍 sticker
      // doesn't deserve an answer. Any text/audio/etc. mixed in means we reply.
      if (isLoneStickerRun(history)) return;
      const ctx: ToolContext = {
        conversationId,
        jid: conv.wa_jid,
        phone: conv.phone,
        customerName: conv.customer_name,
        lastImage: st.lastImage,
        // Clear the image only once a payment is actually confirmed. It stays
        // available across the photo→order-number exchange (separate messages).
        onReceiptConsumed: () => {
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
      const reply = await runAgent(ctx, history);

      // A human may have taken over while the agent was thinking — don't talk over them.
      const after = await getConversation(conversationId);
      if (after?.mode === 'human') return;

      // Send as up to N separate bubbles (feels more human than one long block).
      const bubbles = splitBubbles(reply, config.AGENT_MAX_BUBBLES);
      for (const [i, bubble] of bubbles.entries()) {
        if (i > 0) await delay(600 + Math.min(1400, bubble.length * 20));
        await this.gateway.indicateTyping(conv.wa_jid, 700);
        const waId = await this.gateway.sendText(conv.wa_jid, bubble);
        await insertOutboundMessage({
          conversationId,
          sender: 'agent',
          body: bubble,
          sendStatus: 'sent',
          waMessageId: waId,
        });
      }
      await touchConversation(conversationId, {
        preview: bubbles[bubbles.length - 1] ?? reply,
        incomingFromCustomer: false,
      });
    } catch (err) {
      logger.error({ err, conversationId }, 'failed to process conversation turn');
    } finally {
      st.processing = false;
      if (st.dirty) {
        st.dirty = false;
        setTimeout(() => void this.flush(conversationId), 250);
      }
    }
  }

  /**
   * On (re)connect, answer customers whose last message went unanswered — e.g.
   * the process restarted within the debounce window, losing the in-memory timer.
   */
  async recoverUnanswered(): Promise<void> {
    try {
      const convs = await getRecentBotConversations(100);
      let recovered = 0;
      for (const c of convs) {
        const st = this.states.get(c.id);
        if (st && (st.timer || st.processing)) continue; // the normal path will handle it
        const recent = await getRecentMessages(c.id, 1);
        const last = recent[0];
        if (last && last.direction === 'in') {
          recovered += 1;
          void this.flush(c.id);
        }
      }
      if (recovered) logger.info({ recovered }, 'recovering unanswered conversations');
    } catch (err) {
      logger.error({ err }, 'recoverUnanswered failed');
    }
  }
}
