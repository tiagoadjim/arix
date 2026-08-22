import { vi, describe, it, expect, beforeEach } from 'vitest';

const {
  getBusyAppointments,
  createAppointment,
  getUpcomingAppointments,
  setAppointmentStatus,
  disableAppointmentReminders,
  appointmentSettings,
  hoursConfig,
  businessProfile,
  SlotTakenError,
} = vi.hoisted(() => ({
  // Declared inside the hoisted block: vi.mock's factory is lifted above every
  // top-level statement, so a class defined out here is still in its temporal
  // dead zone when the factory runs.
  SlotTakenError: class SlotTakenError extends Error {
    constructor() {
      super('slot_taken');
      this.name = 'SlotTakenError';
    }
  },
  getBusyAppointments: vi.fn(),
  createAppointment: vi.fn(),
  getUpcomingAppointments: vi.fn(),
  setAppointmentStatus: vi.fn(),
  disableAppointmentReminders: vi.fn(),
  appointmentSettings: vi.fn(),
  hoursConfig: vi.fn(),
  businessProfile: vi.fn(),
}));

vi.mock('../src/db/repo', () => ({
  ACTIVE_APPOINTMENT_STATUSES: ['booked', 'confirmed'],
  SlotTakenError,
  getBusyAppointments,
  createAppointment,
  getUpcomingAppointments,
  setAppointmentStatus,
  disableAppointmentReminders,
}));

vi.mock('../src/config/runtime', () => ({ appointmentSettings, hoursConfig, businessProfile }));

import { appointmentTools } from '../src/skills/appointments';
import type { ToolContext } from '../src/types';

const AR = 'America/Argentina/Buenos_Aires';
const SCHEDULE = [null, [540, 1020], [540, 1020], [540, 1020], [540, 1020], [540, 1020], [600, 840]];

const ctx = {
  conversationId: 'conv-1',
  jid: 'j',
  phone: '5491100000001',
  customerName: 'Ana',
  lastImage: null,
} as ToolContext;

const tool = (name: string) =>
  appointmentTools.find((t) => t.definition.function.name === name)!;

function appointment(over: Record<string, unknown> = {}) {
  return {
    id: 'appt-1',
    account_id: 'default',
    conversation_id: 'conv-1',
    customer_name: 'Ana',
    customer_phone: '5491100000001',
    service: 'corte',
    starts_at: '2026-03-12T13:00:00.000Z',
    ends_at: '2026-03-12T14:00:00.000Z',
    status: 'booked',
    notes: null,
    reminders_enabled: true,
    created_at: '2026-03-11T00:00:00.000Z',
    updated_at: '2026-03-11T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Wednesday 2026-03-11, 08:00 local (11:00Z) — before opening.
  vi.setSystemTime(new Date('2026-03-11T11:00:00Z'));
  getBusyAppointments.mockReset().mockResolvedValue([]);
  createAppointment.mockReset().mockImplementation(async () => appointment());
  getUpcomingAppointments.mockReset().mockResolvedValue([]);
  setAppointmentStatus.mockReset().mockResolvedValue(appointment({ status: 'confirmed' }));
  disableAppointmentReminders.mockReset().mockResolvedValue(1);
  appointmentSettings.mockReset().mockResolvedValue({
    slotMinutes: 60,
    horizonDays: 14,
    leadMinutes: 120,
    services: [],
  });
  hoursConfig.mockReset().mockResolvedValue(SCHEDULE);
  businessProfile.mockReset().mockResolvedValue({ timezone: AR, language: 'es' });
});

describe('check_availability', () => {
  it('offers a bounded number of slots, never a wall of options', async () => {
    const result = (await tool('check_availability').handler({}, ctx)) as {
      found: number;
      slots: unknown[];
    };
    expect(result.found).toBeGreaterThan(0);
    expect(result.slots.length).toBeLessThanOrEqual(6);
  });

  it('rejects a malformed date instead of guessing one', async () => {
    for (const date of ['tomorrow', '11-03-2026', '2026-3-1']) {
      expect(await tool('check_availability').handler({ date }, ctx)).toEqual({
        error: 'invalid_date',
      });
    }
  });

  it('returns found: 0 rather than an error when a day is fully booked', async () => {
    // Every slot that day is taken.
    getBusyAppointments.mockResolvedValueOnce(
      Array.from({ length: 12 }, (_, i) => ({
        starts_at: new Date(Date.UTC(2026, 2, 12, 12 + i)).toISOString(),
        ends_at: new Date(Date.UTC(2026, 2, 12, 13 + i)).toISOString(),
      })),
    );
    const result = (await tool('check_availability').handler({ date: '2026-03-12' }, ctx)) as {
      found: number;
    };
    expect(result.found).toBe(0);
  });
});

describe('book_appointment', () => {
  async function firstFreeSlot(): Promise<string> {
    const result = (await tool('check_availability').handler({}, ctx)) as {
      slots: Array<{ starts_at: string }>;
    };
    return result.slots[0].starts_at;
  }

  it('books a slot the schedule actually offers', async () => {
    const starts_at = await firstFreeSlot();
    const result = (await tool('book_appointment').handler(
      { starts_at, service: 'corte' },
      ctx,
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(createAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', service: 'corte' }),
    );
  });

  it('refuses a time the model invented outside opening hours', async () => {
    // 03:00 local on a Thursday — never offered by check_availability. Trusting
    // the argument here would tell a customer 3am was confirmed.
    const result = (await tool('book_appointment').handler(
      { starts_at: '2026-03-12T06:00:00.000Z', service: 'corte' },
      ctx,
    )) as { ok: boolean; reason: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('slot_unavailable');
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('refuses a Sunday, when the business is closed', async () => {
    const result = (await tool('book_appointment').handler(
      { starts_at: '2026-03-15T15:00:00.000Z', service: 'corte' },
      ctx,
    )) as { ok: boolean; reason: string };

    expect(result.reason).toBe('slot_unavailable');
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('refuses a slot inside the lead time', async () => {
    // 09:00 local today is inside the 120-minute lead from 08:00.
    const result = (await tool('book_appointment').handler(
      { starts_at: '2026-03-11T12:00:00.000Z', service: 'corte' },
      ctx,
    )) as { reason: string };

    expect(result.reason).toBe('slot_unavailable');
  });

  it('reports a lost race as slot_taken so the agent re-quotes', async () => {
    const starts_at = await firstFreeSlot();
    createAppointment.mockRejectedValueOnce(new SlotTakenError());

    const result = (await tool('book_appointment').handler(
      { starts_at, service: 'corte' },
      ctx,
    )) as { ok: boolean; reason: string };

    expect(result).toEqual({ ok: false, reason: 'slot_taken' });
  });

  it('rejects a service the business does not offer, and says what it does', async () => {
    appointmentSettings.mockResolvedValue({
      slotMinutes: 60,
      horizonDays: 14,
      leadMinutes: 120,
      services: ['Corte', 'Color'],
    });
    const starts_at = await firstFreeSlot();

    const result = (await tool('book_appointment').handler(
      { starts_at, service: 'masaje' },
      ctx,
    )) as { ok: boolean; reason: string; services: string[] };

    expect(result.reason).toBe('unknown_service');
    expect(result.services).toEqual(['Corte', 'Color']);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('matches a configured service case-insensitively', async () => {
    appointmentSettings.mockResolvedValue({
      slotMinutes: 60,
      horizonDays: 14,
      leadMinutes: 120,
      services: ['Corte'],
    });
    const starts_at = await firstFreeSlot();

    const result = (await tool('book_appointment').handler(
      { starts_at, service: 'CORTE' },
      ctx,
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
  });

  it('validates its arguments before touching the agenda', async () => {
    expect(await tool('book_appointment').handler({ starts_at: 'nope', service: 'x' }, ctx)).toEqual(
      { error: 'invalid_starts_at' },
    );
    const starts_at = await firstFreeSlot();
    expect(await tool('book_appointment').handler({ starts_at, service: '  ' }, ctx)).toEqual({
      error: 'invalid_service',
    });
  });
});

describe('confirm / cancel', () => {
  it('acts without an id when there is exactly one upcoming appointment', async () => {
    getUpcomingAppointments.mockResolvedValue([appointment()]);

    const result = (await tool('confirm_appointment').handler({}, ctx)) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(setAppointmentStatus).toHaveBeenCalledWith('appt-1', 'conv-1', 'confirmed', [
      'booked',
      'confirmed',
    ]);
  });

  it('asks instead of guessing when several are upcoming', async () => {
    // Cancelling the wrong appointment is not recoverable by an apology.
    getUpcomingAppointments.mockResolvedValue([appointment(), appointment({ id: 'appt-2' })]);

    const result = (await tool('cancel_appointment').handler({}, ctx)) as { reason: string };

    expect(result.reason).toBe('ambiguous');
    expect(setAppointmentStatus).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to act on', async () => {
    getUpcomingAppointments.mockResolvedValue([]);

    expect(await tool('cancel_appointment').handler({}, ctx)).toEqual({
      ok: false,
      reason: 'no_appointments',
    });
  });

  it('scopes every write to the calling conversation', async () => {
    // A hallucinated id from another customer's chat must find nothing.
    setAppointmentStatus.mockResolvedValueOnce(null);

    const result = (await tool('cancel_appointment').handler(
      { appointment_id: 'someone-elses' },
      ctx,
    )) as { reason: string };

    // The conversation id is the scope: whatever id the model supplies, the
    // UPDATE is still bounded to the chat the agent is actually in.
    expect(setAppointmentStatus).toHaveBeenCalledWith('someone-elses', 'conv-1', 'cancelled');
    expect(result.reason).toBe('appointment_not_found');
  });
});

describe('stop_appointment_reminders', () => {
  it('honors the opt-out immediately and reports how many it stopped', async () => {
    disableAppointmentReminders.mockResolvedValueOnce(2);

    expect(await tool('stop_appointment_reminders').handler({}, ctx)).toEqual({
      ok: true,
      stopped: 2,
    });
    expect(disableAppointmentReminders).toHaveBeenCalledWith('conv-1');
  });
});
