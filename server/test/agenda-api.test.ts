import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

const {
  listAgenda,
  createAppointment,
  setAppointmentStatusAsStaff,
  cancelPendingReminders,
  getConversation,
  getStaffById,
  getSettings,
  insertAuditEvent,
  SlotTakenError,
} = vi.hoisted(() => ({
  listAgenda: vi.fn(),
  createAppointment: vi.fn(),
  setAppointmentStatusAsStaff: vi.fn(),
  cancelPendingReminders: vi.fn(),
  getConversation: vi.fn(),
  getStaffById: vi.fn(),
  getSettings: vi.fn(),
  insertAuditEvent: vi.fn(),
  SlotTakenError: class SlotTakenError extends Error {
    constructor() {
      super('slot_taken');
      this.name = 'SlotTakenError';
    }
  },
}));

vi.mock('../src/db/repo', () => ({
  listAgenda,
  createAppointment,
  setAppointmentStatusAsStaff,
  cancelPendingReminders,
  getConversation,
  getStaffById,
  getSettings,
  insertAuditEvent,
  SlotTakenError,
}));

import { createApiServer } from '../src/api/server';
import { signSession, SESSION_COOKIE } from '../src/api/auth';
import { invalidate } from '../src/config/runtime';
import type { WhatsAppGateway } from '../src/whatsapp/socket';

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@example.com',
  password_hash: 'x',
  name: 'Admin',
  role: 'admin' as const,
  session_version: 0,
};
const AGENT = { ...ADMIN, id: '22222222-2222-4222-8222-222222222222', role: 'agent' as const };
const APPT = '33333333-3333-4333-8333-333333333333';
const CONV = '44444444-4444-4444-8444-444444444444';

const cookie = async (staff = ADMIN) => `${SESSION_COOKIE}=${await signSession(staff)}`;

const app = () =>
  createApiServer({
    gateway: {
      connected: false,
      latestQR: null,
      sendText: vi.fn(),
      indicateTyping: vi.fn(),
      restart: vi.fn(),
    } as unknown as WhatsAppGateway,
  });

/** A row as listAgenda returns it, including the internal columns the DTO must
 * not leak. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: APPT,
    account_id: 'default',
    conversation_id: CONV,
    customer_name: 'Ana',
    customer_phone: '5491100000001',
    service: 'corte',
    starts_at: '2026-03-13T15:00:00.000Z',
    ends_at: '2026-03-13T16:00:00.000Z',
    status: 'booked',
    notes: null,
    reminders_enabled: true,
    created_at: '2026-03-11T00:00:00.000Z',
    updated_at: '2026-03-11T00:00:00.000Z',
    wa_jid: '5491100000001@s.whatsapp.net',
    conversation_name: 'Ana',
    ...over,
  };
}

beforeEach(() => {
  listAgenda.mockReset().mockResolvedValue([row()]);
  createAppointment.mockReset().mockImplementation(async () => row());
  setAppointmentStatusAsStaff.mockReset().mockResolvedValue(row({ status: 'completed' }));
  cancelPendingReminders.mockReset().mockResolvedValue(1);
  getConversation.mockReset().mockResolvedValue({ id: CONV });
  getStaffById.mockReset().mockImplementation(async (id: string) => (id === AGENT.id ? AGENT : ADMIN));
  getSettings.mockReset().mockResolvedValue({});
  insertAuditEvent.mockReset().mockResolvedValue(undefined);
  invalidate();
});

describe('agenda authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    await request(app()).get('/api/appointments?date=2026-03-13').expect(401);
  });

  it('lets a non-admin member of staff use it', async () => {
    // Deliberately not admin-only: looking at the day and taking a booking
    // over the phone is daily work, like the inbox — unlike /config.
    const c = await cookie(AGENT);
    await request(app()).get('/api/appointments?date=2026-03-13').set('Cookie', c).expect(200);
    await request(app())
      .post('/api/appointments')
      .set('Cookie', c)
      .send({ service: 'corte', starts_at: '2026-03-13T15:00:00.000Z' })
      .expect(201);
    await request(app())
      .patch(`/api/appointments/${APPT}/status`)
      .set('Cookie', c)
      .send({ status: 'completed' })
      .expect(200);
  });
});

describe('GET /api/appointments', () => {
  it('rejects a malformed date instead of guessing a day', async () => {
    for (const date of ['', 'today', '13-03-2026', '2026-3-1']) {
      const res = await request(app())
        .get(`/api/appointments?date=${date}`)
        .set('Cookie', await cookie())
        .expect(400);
      expect(res.body.error).toBe('invalid_date');
    }
  });

  it('never leaks internal columns', async () => {
    const res = await request(app())
      .get('/api/appointments?date=2026-03-13')
      .set('Cookie', await cookie())
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('account_id');
    expect(body).not.toContain('wa_jid');
    expect(body).not.toContain('conversation_name');
  });

  it('marks a hand-booked appointment as not from chat', async () => {
    // This drives the UI hint that such a customer gets no reminders.
    listAgenda.mockResolvedValueOnce([
      row({ conversation_id: null, wa_jid: null, conversation_name: null }),
    ]);

    const res = await request(app())
      .get('/api/appointments?date=2026-03-13')
      .set('Cookie', await cookie())
      .expect(200);

    expect(res.body.appointments[0].from_chat).toBe(false);
    expect(res.body.appointments[0].conversation_id).toBeNull();
  });

  it('reports from_chat for one that came from a conversation', async () => {
    const res = await request(app())
      .get('/api/appointments?date=2026-03-13')
      .set('Cookie', await cookie())
      .expect(200);

    expect(res.body.appointments[0].from_chat).toBe(true);
  });

  it('bounds how many days one request may sweep', async () => {
    await request(app())
      .get('/api/appointments?date=2026-03-13&days=9999')
      .set('Cookie', await cookie())
      .expect(200);

    const [from, to] = listAgenda.mock.calls[0] as [Date, Date];
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(31);
  });
});

describe('POST /api/appointments', () => {
  it('requires a service and a usable time', async () => {
    const c = await cookie();
    for (const body of [{}, { service: 'corte' }, { starts_at: '2026-03-13T15:00:00Z' }, { service: '  ', starts_at: '2026-03-13T15:00:00Z' }, { service: 'corte', starts_at: 'nope' }]) {
      const res = await request(app()).post('/api/appointments').set('Cookie', c).send(body).expect(400);
      expect(res.body.error).toBe('invalid_appointment');
    }
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('books with no conversation by default', async () => {
    await request(app())
      .post('/api/appointments')
      .set('Cookie', await cookie())
      .send({ service: 'corte', starts_at: '2026-03-13T15:00:00.000Z' })
      .expect(201);

    // Null conversation is what makes a walk-in unreachable by reminders.
    expect(createAppointment.mock.calls[0][0].conversationId).toBeNull();
  });

  it('rejects a conversation id that is not a uuid, and one that does not exist', async () => {
    const c = await cookie();
    await request(app())
      .post('/api/appointments')
      .set('Cookie', c)
      .send({ service: 'corte', starts_at: '2026-03-13T15:00:00.000Z', conversation_id: 'nope' })
      .expect(400);

    getConversation.mockResolvedValueOnce(null);
    await request(app())
      .post('/api/appointments')
      .set('Cookie', c)
      .send({ service: 'corte', starts_at: '2026-03-13T15:00:00.000Z', conversation_id: CONV })
      .expect(404);

    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('bounds the duration', async () => {
    await request(app())
      .post('/api/appointments')
      .set('Cookie', await cookie())
      .send({ service: 'corte', starts_at: '2026-03-13T15:00:00.000Z', duration_minutes: 99_999 })
      .expect(201);

    const { startsAt, endsAt } = createAppointment.mock.calls[0][0];
    const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
    expect(minutes).toBeLessThanOrEqual(480);
  });

  it('turns a lost race into 409, not a 500', async () => {
    createAppointment.mockRejectedValueOnce(new SlotTakenError());

    const res = await request(app())
      .post('/api/appointments')
      .set('Cookie', await cookie())
      .send({ service: 'corte', starts_at: '2026-03-13T15:00:00.000Z' })
      .expect(409);

    expect(res.body.error).toBe('slot_taken');
  });
});

describe('PATCH /api/appointments/:id/status', () => {
  it('rejects a bad id or an unknown status', async () => {
    const c = await cookie();
    await request(app()).patch('/api/appointments/nope/status').set('Cookie', c).send({ status: 'completed' }).expect(400);
    await request(app()).patch(`/api/appointments/${APPT}/status`).set('Cookie', c).send({ status: 'deleted' }).expect(400);
    // 'booked' is the initial state, not a transition target.
    await request(app()).patch(`/api/appointments/${APPT}/status`).set('Cookie', c).send({ status: 'booked' }).expect(400);
    expect(setAppointmentStatusAsStaff).not.toHaveBeenCalled();
  });

  it('only moves an appointment that is still on the books', async () => {
    await request(app())
      .patch(`/api/appointments/${APPT}/status`)
      .set('Cookie', await cookie())
      .send({ status: 'completed' })
      .expect(200);

    expect(setAppointmentStatusAsStaff).toHaveBeenCalledWith(APPT, 'completed', ['booked', 'confirmed']);
  });

  it('cancels pending reminders when the appointment is over or off', async () => {
    for (const status of ['completed', 'no_show', 'cancelled']) {
      cancelPendingReminders.mockClear();
      await request(app())
        .patch(`/api/appointments/${APPT}/status`)
        .set('Cookie', await cookie())
        .send({ status })
        .expect(200);
      // A reminder arriving after the fact is pure noise.
      expect(cancelPendingReminders).toHaveBeenCalledWith(APPT, `staff_marked_${status}`);
    }
  });

  it('keeps reminders when staff merely confirm', async () => {
    await request(app())
      .patch(`/api/appointments/${APPT}/status`)
      .set('Cookie', await cookie())
      .send({ status: 'confirmed' })
      .expect(200);

    expect(cancelPendingReminders).not.toHaveBeenCalled();
  });

  it('404s when there is nothing to move', async () => {
    setAppointmentStatusAsStaff.mockResolvedValueOnce(null);

    await request(app())
      .patch(`/api/appointments/${APPT}/status`)
      .set('Cookie', await cookie())
      .send({ status: 'completed' })
      .expect(404);
  });

  it('audits the change', async () => {
    await request(app())
      .patch(`/api/appointments/${APPT}/status`)
      .set('Cookie', await cookie())
      .send({ status: 'no_show' })
      .expect(200);

    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'appointment.status_changed' }),
    );
  });
});
