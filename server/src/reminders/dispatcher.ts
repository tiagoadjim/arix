import {
  claimDueReminders,
  claimMessageForSending,
  deferReminder,
  finalizeReminder,
  markMessageFailed,
  markMessageSent,
  prepareOutboundMessage,
  touchConversation,
  type DueReminder,
} from '../db/repo';
import { businessProfile, hoursConfig, reminderSettings, type ReminderKind } from '../config/runtime';
import { nextTimeWithinSchedule } from '../agent/slots';
import { stableWhatsAppMessageId } from '../whatsapp/message-id';
import type { WhatsAppGateway } from '../whatsapp/socket';
import { buildReminderMessage, DEFAULT_REMINDER_TEMPLATES } from './templates';
import { publishEvent } from '../events';
import { recordDomainEvent } from '../metrics';
import { logger } from '../logger';

/**
 * Sends appointment reminders.
 *
 * Arix already sends proactive messages — the order-dispatch notification does
 * exactly this. What is new here is that TIME pulls the trigger instead of a
 * member of staff, and that is the whole risk: automatic outbound on an
 * unofficial WhatsApp client is the clearest way to get a number banned. The
 * README says Arix is for answering inbound conversations, not for blasts, and
 * this module is what keeps that true.
 *
 * A transactional reminder to someone who booked through this very chat is
 * different in kind from a marketing blast. That difference is enforced here,
 * in code, rather than left to the operator's judgement:
 *
 *   - only conversations that already exist (a booking implies one)
 *   - only while the operator has explicitly turned reminders on
 *   - only while the customer has not opted out
 *   - never outside opening hours — deferred, not sent at 3am
 *   - never more than one message per reminder row, ever
 *   - jittered, so a hundred appointments do not emit a burst on the hour
 *
 * Delivery reuses the existing durable outbox rather than calling the socket
 * directly. The client_id is derived from the reminder's own id, so the
 * `on conflict (account_id, client_id) do nothing` guarantee in
 * prepareOutboundMessage makes a double send impossible by construction —
 * including across a crash between claiming the row and sending it.
 */

/** How long a dispatcher owns a claimed reminder before another may retry it.
 * Comfortably longer than a send, short enough that a killed process does not
 * strand a reminder past the appointment it is about. */
const LEASE_SECONDS = 120;

/** Ceiling per tick. Keeps a backlog draining steadily instead of emitting a
 * burst that looks exactly like the bulk messaging Arix must not do. */
const BATCH_SIZE = 10;

/** Spread sends over this window so appointments sharing a slot time do not
 * fire simultaneously. Deterministic per reminder id — no Math.random, so a
 * replay behaves identically. */
const JITTER_MS = 45_000;

/** Give up on a reminder that could not be sent this many times. */
const MAX_ATTEMPTS = 5;

function jitterFor(id: string): number {
  // FNV-1a over the uuid: stable, uniform enough for spreading, and free.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % JITTER_MS;
}

/** The outbox key for a reminder. Deterministic on purpose — this is what makes
 * a second delivery attempt a no-op instead of a second message. */
export function reminderClientId(reminderId: string): string {
  return `reminder:${reminderId}`;
}

function formatParts(startsAt: Date, timezone: string, locale: 'es' | 'en') {
  const tag = locale === 'es' ? 'es-AR' : 'en-GB';
  return {
    date: new Intl.DateTimeFormat(tag, {
      timeZone: timezone,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
    }).format(startsAt),
    time: new Intl.DateTimeFormat(tag, {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(startsAt),
  };
}

export class ReminderDispatcher {
  private running = false;
  private stopped = false;

  constructor(private readonly gateway: WhatsAppGateway) {}

  stop(): void {
    this.stopped = true;
  }

  /** One pass. Safe to call concurrently with itself — the second call returns
   * immediately rather than double-claiming. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const settings = await reminderSettings();
      // The operator's opt-in. While this is off nothing is even claimed, so
      // turning it off is an immediate stop, not a drain.
      if (!settings.enabled) return;
      if (!this.gateway.connected) return;

      const claimed = await claimDueReminders(now, LEASE_SECONDS, BATCH_SIZE);
      if (claimed.length === 0) return;

      const [profile, schedule] = await Promise.all([businessProfile(), hoursConfig()]);

      for (const reminder of claimed) {
        if (this.stopped) return;
        await this.deliver(reminder, {
          now,
          timezone: profile.timezone,
          language: profile.language,
          businessName: profile.businessName,
          schedule,
          templates: settings.templates,
        }).catch((err) => {
          logger.error(
            { err, reminderId: reminder.id },
            'reminder dispatch threw — releasing for retry',
          );
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(
    reminder: DueReminder,
    ctx: {
      now: Date;
      timezone: string;
      language: 'es' | 'en';
      businessName: string;
      schedule: Awaited<ReturnType<typeof hoursConfig>>;
      templates: Record<ReminderKind, string>;
    },
  ): Promise<void> {
    const attemptId = reminder.attempt_id;
    if (!attemptId) return;

    const skip = async (reason: string): Promise<void> => {
      await finalizeReminder(reminder.id, attemptId, { status: 'skipped', skipReason: reason });
      logger.info({ reminderId: reminder.id, reason }, 'reminder skipped');
    };

    // --- guards, cheapest and most important first -------------------------
    if (!reminder.reminders_enabled) return skip('customer_opted_out');
    if (reminder.appointment_status !== 'booked' && reminder.appointment_status !== 'confirmed') {
      return skip(`appointment_${reminder.appointment_status}`);
    }
    const startsAt = new Date(reminder.starts_at);
    if (startsAt <= ctx.now) return skip('appointment_already_started');
    if (reminder.attempts > MAX_ATTEMPTS) return skip('too_many_attempts');

    // A conversation that a human has taken over must not receive an automated
    // message underneath them.
    if (reminder.conversation_mode !== 'bot') return skip('conversation_in_human_mode');

    // Quiet hours: defer rather than send. Deferring past the appointment
    // leaves no useful moment, so drop it instead.
    const sendWindow = nextTimeWithinSchedule(ctx.now, ctx.schedule, ctx.timezone);
    if (!sendWindow) return skip('no_opening_hours_configured');
    if (sendWindow.getTime() !== ctx.now.getTime()) {
      if (sendWindow >= startsAt) return skip('quiet_hours_past_appointment');
      await deferReminder(reminder.id, attemptId, sendWindow, 'deferred_quiet_hours');
      return;
    }

    // Jitter: hold this one back a little so a batch does not go out in lockstep.
    const jitter = jitterFor(reminder.id);
    const jitteredAt = new Date(new Date(reminder.send_at).getTime() + jitter);
    if (jitteredAt > ctx.now) {
      await deferReminder(reminder.id, attemptId, jitteredAt, 'jitter');
      return;
    }

    // --- render ------------------------------------------------------------
    const kind = reminder.kind as ReminderKind;
    const template =
      ctx.templates[kind]?.trim() || DEFAULT_REMINDER_TEMPLATES[ctx.language][kind];
    if (!template) return skip('no_template');
    const { date, time } = formatParts(startsAt, ctx.timezone, ctx.language);
    const body = buildReminderMessage(template, {
      service: reminder.service,
      date,
      time,
      business: ctx.businessName,
    });

    // --- deliver through the durable outbox --------------------------------
    const clientId = reminderClientId(reminder.id);
    const waMessageId = stableWhatsAppMessageId(clientId);
    const { message, created } = await prepareOutboundMessage({
      conversationId: reminder.conversation_id,
      sender: 'agent',
      body,
      clientId,
      waMessageId,
    });

    // Not created means this reminder already produced an outbox row on an
    // earlier attempt — the crash-between-claim-and-send case. Adopt that row
    // rather than making a second one.
    if (!created && message.send_status === 'sent') {
      await finalizeReminder(reminder.id, attemptId, { status: 'sent', messageId: message.id });
      return;
    }

    const claimedMessage = await claimMessageForSending(message.id);
    if (!claimedMessage) {
      // Another worker holds it; leave the reminder for the next tick.
      return;
    }
    const sendAttempt = claimedMessage.send_attempt_id;
    if (!sendAttempt) throw new Error('claimed reminder message has no send attempt token');

    try {
      const actual = await this.gateway.sendText(reminder.wa_jid, body, waMessageId);
      await markMessageSent(claimedMessage.id, sendAttempt, actual ?? waMessageId);
      await finalizeReminder(reminder.id, attemptId, {
        status: 'sent',
        messageId: claimedMessage.id,
      });
      await touchConversation(reminder.conversation_id, {
        preview: body,
        incomingFromCustomer: false,
      });
      recordDomainEvent('outbound_messages');
      publishEvent({ type: 'message.updated', conversationId: reminder.conversation_id });
      logger.info(
        { reminderId: reminder.id, kind: reminder.kind },
        'appointment reminder sent',
      );
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : 'send_failed';
      await markMessageFailed(claimedMessage.id, sendAttempt, error).catch(() => false);
      await finalizeReminder(reminder.id, attemptId, { status: 'pending', skipReason: error });
    }
  }
}
