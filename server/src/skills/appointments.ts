import {
  ACTIVE_APPOINTMENT_STATUSES,
  createAppointment,
  disableAppointmentReminders,
  getBusyAppointments,
  getUpcomingAppointments,
  setAppointmentStatus,
  scheduleReminders,
  cancelPendingReminders,
  SlotTakenError,
  type Appointment,
} from '../db/repo';
import {
  appointmentSettings,
  businessProfile,
  hoursConfig,
  reminderSettings,
} from '../config/runtime';
import { availableSlots, type Slot } from '../agent/slots';
import { planReminders } from '../reminders/schedule';
import { logger } from '../logger';
import type { ToolSpec } from '../agent/tool-spec';
import type { ToolContext } from '../types';

/**
 * The appointments skill.
 *
 * The discipline the ecommerce vertical applies to prices applies here to free
 * slots: the agent may not name one it has not looked up. An invented opening
 * is worse than an invented price — it puts a customer outside a locked door.
 *
 * Identity needs no challenge in this skill. Every appointment is reached
 * through the conversation that created it (see migration 0008), so the caller
 * is by construction the owner; a hallucinated id from another chat simply
 * matches nothing.
 */

/** Cap on how many options one reply may carry. The prompt asks for 2-3; this
 * is the hard stop so a long list can never reach the customer. */
const MAX_OFFERED_SLOTS = 6;

/** Stable, language-neutral wire format. The persona prompt decides the reply
 * language; tool payloads stay machine-shaped, same as the catalog skill. */
function toWire(slot: Slot, timezone: string): { starts_at: string; local: string } {
  return {
    starts_at: slot.startsAt.toISOString(),
    local: new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(slot.startsAt),
  };
}

function appointmentWire(appointment: Appointment, timezone: string) {
  return {
    id: appointment.id,
    service: appointment.service,
    status: appointment.status,
    starts_at: appointment.starts_at,
    local: new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(appointment.starts_at)),
  };
}

/** Resolve everything a slot computation needs, in one place. */
async function agendaContext() {
  const [settings, schedule, profile] = await Promise.all([
    appointmentSettings(),
    hoursConfig(),
    businessProfile(),
  ]);
  return { settings, schedule, timezone: profile.timezone };
}

export const appointmentTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'check_availability',
        description:
          "Lists concrete free appointment slots. Call this BEFORE naming any day or time to the customer — never offer a slot you have not seen here. Optionally narrow to a service or to a date the customer asked for.",
        parameters: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: 'The service the customer wants, if they said one.',
            },
            date: {
              type: 'string',
              description:
                'A specific day the customer asked about, as YYYY-MM-DD in the local time of the business. Omit to get the soonest slots.',
            },
          },
          required: [],
        },
      },
    },
    handler: async (args, ctx) => {
      const { settings, schedule, timezone } = await agendaContext();
      if (ctx.signal?.aborted) throw ctx.signal.reason;

      const now = new Date();
      let from = now;
      let horizonDays = settings.horizonDays;

      // A requested date narrows the search to that day rather than filtering
      // afterwards, so "do you have anything Thursday?" cannot come back with
      // Wednesday's leftovers.
      const requested = String(args.date ?? '').trim();
      if (requested) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return { error: 'invalid_date' };
        const dayStart = new Date(`${requested}T00:00:00Z`);
        if (Number.isNaN(dayStart.getTime())) return { error: 'invalid_date' };
        from = dayStart > now ? dayStart : now;
        horizonDays = 1;
      }

      const windowEnd = new Date(from.getTime() + (horizonDays + 1) * 86_400_000);
      const busy = await getBusyAppointments(from, windowEnd);
      if (ctx.signal?.aborted) throw ctx.signal.reason;

      const slots = availableSlots({
        from,
        schedule,
        timezone,
        slotMinutes: settings.slotMinutes,
        horizonDays,
        busy: busy.map((a) => ({ startsAt: new Date(a.starts_at), endsAt: new Date(a.ends_at) })),
        leadMinutes: settings.leadMinutes,
        limit: MAX_OFFERED_SLOTS,
      });

      return {
        found: slots.length,
        timezone,
        slot_minutes: settings.slotMinutes,
        services: settings.services,
        slots: slots.map((slot) => toWire(slot, timezone)),
      };
    },
  },

  {
    definition: {
      type: 'function',
      function: {
        name: 'book_appointment',
        description:
          "Books one of the slots returned by check_availability. Pass the slot's exact starts_at value. Only treat the appointment as booked if this returns ok: true — if it returns slot_taken, apologise, call check_availability again and offer what is actually left.",
        parameters: {
          type: 'object',
          properties: {
            starts_at: {
              type: 'string',
              description: "The chosen slot's starts_at, copied exactly from check_availability.",
            },
            service: { type: 'string', description: 'What the appointment is for.' },
            customer_name: { type: 'string', description: "The customer's name, if they gave one." },
            notes: { type: 'string', description: 'Anything the business should know beforehand.' },
          },
          required: ['starts_at', 'service'],
        },
      },
    },
    handler: async (args, ctx) => {
      const startsAt = new Date(String(args.starts_at ?? ''));
      if (Number.isNaN(startsAt.getTime())) return { error: 'invalid_starts_at' };
      const service = String(args.service ?? '').trim();
      if (!service) return { error: 'invalid_service' };

      const { settings, schedule, timezone } = await agendaContext();
      if (ctx.signal?.aborted) throw ctx.signal.reason;

      // Re-derive the slot from the schedule instead of trusting the argument.
      // The model could otherwise book 03:00 on a closed Sunday by inventing a
      // timestamp, and the customer would be told it was confirmed.
      const windowEnd = new Date(startsAt.getTime() + settings.slotMinutes * 60_000);
      const busy = await getBusyAppointments(
        new Date(startsAt.getTime() - settings.slotMinutes * 60_000),
        new Date(windowEnd.getTime() + settings.slotMinutes * 60_000),
      );
      if (ctx.signal?.aborted) throw ctx.signal.reason;

      const legal = availableSlots({
        from: new Date(),
        schedule,
        timezone,
        slotMinutes: settings.slotMinutes,
        horizonDays: settings.horizonDays,
        busy: busy.map((a) => ({ startsAt: new Date(a.starts_at), endsAt: new Date(a.ends_at) })),
        leadMinutes: settings.leadMinutes,
        limit: 5_000,
      }).some((slot) => slot.startsAt.getTime() === startsAt.getTime());

      if (!legal) return { ok: false, reason: 'slot_unavailable' };

      if (settings.services.length > 0) {
        const match = settings.services.find(
          (name) => name.toLowerCase() === service.toLowerCase(),
        );
        if (!match) return { ok: false, reason: 'unknown_service', services: settings.services };
      }

      try {
        const appointment = await createAppointment({
          conversationId: ctx.conversationId,
          customerName: String(args.customer_name ?? '').trim() || ctx.customerName || null,
          customerPhone: ctx.phone ?? null,
          service,
          startsAt,
          endsAt: windowEnd,
          notes: String(args.notes ?? '').trim() || null,
        });
        // Reminders are planned right after the booking that justifies them.
        // A failure here must not un-book a confirmed appointment, so it is
        // logged and swallowed: the customer has their slot either way.
        try {
          const reminders = await reminderSettings();
          const planned = planReminders({
            startsAt,
            now: new Date(),
            settings: reminders,
            schedule,
            timezone,
          });
          if (planned.length > 0) {
            await scheduleReminders(
              appointment.id,
              planned.map((p) => ({ kind: p.kind, sendAt: p.sendAt })),
            );
          }
        } catch (err) {
          logger.error({ err, appointmentId: appointment.id }, 'failed to plan reminders');
        }

        logger.info(
          { conversationId: ctx.conversationId, appointmentId: appointment.id },
          'appointment booked',
        );
        return { ok: true, appointment: appointmentWire(appointment, timezone) };
      } catch (err) {
        // Lost the race to another customer between quoting and booking.
        if (err instanceof SlotTakenError) return { ok: false, reason: 'slot_taken' };
        throw err;
      }
    },
  },

  {
    definition: {
      type: 'function',
      function: {
        name: 'find_appointment',
        description:
          "Looks up this customer's upcoming appointments. Call it before confirming or cancelling when it is not obvious which appointment the customer means.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async (_args, ctx) => {
      const { timezone } = await agendaContext();
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const appointments = await getUpcomingAppointments(ctx.conversationId);
      return {
        found: appointments.length,
        appointments: appointments.map((a) => appointmentWire(a, timezone)),
      };
    },
  },

  {
    definition: {
      type: 'function',
      function: {
        name: 'confirm_appointment',
        description:
          "Marks an appointment as confirmed by the customer — use it when they reply to a reminder saying they will be there. Pass the appointment id from find_appointment, or omit it when the customer has exactly one upcoming appointment.",
        parameters: {
          type: 'object',
          properties: { appointment_id: { type: 'string', description: 'From find_appointment.' } },
          required: [],
        },
      },
    },
    handler: async (args, ctx) => {
      const { timezone } = await agendaContext();
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const id = await resolveAppointmentId(args, ctx);
      if (!id.ok) return id.result;

      const appointment = await setAppointmentStatus(id.value, ctx.conversationId, 'confirmed', [
        'booked',
        'confirmed',
      ]);
      if (!appointment) return { ok: false, reason: 'appointment_not_found' };
      return { ok: true, appointment: appointmentWire(appointment, timezone) };
    },
  },

  {
    definition: {
      type: 'function',
      function: {
        name: 'cancel_appointment',
        description:
          "Cancels an appointment and frees the slot. Pass the appointment id from find_appointment, or omit it when the customer has exactly one upcoming appointment. After cancelling, offer to book another time.",
        parameters: {
          type: 'object',
          properties: {
            appointment_id: { type: 'string', description: 'From find_appointment.' },
            reason: { type: 'string', description: 'Why, if the customer said.' },
          },
          required: [],
        },
      },
    },
    handler: async (args, ctx) => {
      const { timezone } = await agendaContext();
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const id = await resolveAppointmentId(args, ctx);
      if (!id.ok) return id.result;

      const appointment = await setAppointmentStatus(id.value, ctx.conversationId, 'cancelled');
      if (!appointment) return { ok: false, reason: 'appointment_not_found' };
      // A reminder for an appointment that no longer exists is pure spam.
      await cancelPendingReminders(appointment.id, 'appointment_cancelled').catch((err) => {
        logger.error({ err, appointmentId: appointment.id }, 'failed to cancel reminders');
      });
      logger.info(
        { conversationId: ctx.conversationId, appointmentId: appointment.id },
        'appointment cancelled',
      );
      return { ok: true, appointment: appointmentWire(appointment, timezone) };
    },
  },

  {
    definition: {
      type: 'function',
      function: {
        name: 'stop_appointment_reminders',
        description:
          "Stops all automatic appointment reminders for this customer. Call it as soon as they ask not to be messaged — 'no me escribas más', 'stop', 'unsubscribe' — even mid-conversation, and confirm warmly that they won't get any more.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler: async (_args, ctx) => {
      const affected = await disableAppointmentReminders(ctx.conversationId);
      logger.info({ conversationId: ctx.conversationId, affected }, 'reminders opt-out honored');
      return { ok: true, stopped: affected };
    },
  },
];

/**
 * Resolve which appointment the customer means.
 *
 * With exactly one upcoming appointment, requiring an id would make the agent
 * interrogate someone who obviously means "my appointment". With several, it
 * must ask rather than guess — cancelling the wrong one is not recoverable by
 * an apology.
 */
async function resolveAppointmentId(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: true; value: string } | { ok: false; result: Record<string, unknown> }> {
  const explicit = String(args.appointment_id ?? '').trim();
  if (explicit) return { ok: true, value: explicit };

  const upcoming = await getUpcomingAppointments(ctx.conversationId);
  const only = upcoming.length === 1 ? upcoming[0] : undefined;
  if (only) return { ok: true, value: only.id };
  if (upcoming.length === 0) return { ok: false, result: { ok: false, reason: 'no_appointments' } };
  return {
    ok: false,
    result: {
      ok: false,
      reason: 'ambiguous',
      count: upcoming.length,
      hint: 'Ask the customer which one, then call again with appointment_id.',
    },
  };
}

export { ACTIVE_APPOINTMENT_STATUSES };
