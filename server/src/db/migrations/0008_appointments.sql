-- Appointments: the agenda the `appointments` vertical books against.
--
-- Deliberately Arix's own table rather than a calendar integration. A booking
-- has to be readable and writable inside the agent turn that is talking to the
-- customer, and an external calendar would put an OAuth handshake between a
-- business and its first booked appointment.

create table if not exists appointments (
  id             uuid        primary key default gen_random_uuid(),
  account_id     text        not null,
  -- The conversation IS the identity here. Unlike a WooCommerce order, which
  -- can be looked up by anyone who guesses a number, an appointment is only
  -- ever reachable from the chat that created it — so there is no email
  -- challenge to run before showing or changing it.
  conversation_id uuid       not null references conversations (id) on delete cascade,
  customer_name  text,
  customer_phone text,
  service        text        not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text        not null default 'booked',
  notes          text,
  -- Per-appointment kill switch for reminders, flipped by the customer asking
  -- to be left alone. The operator's own opt-in is the separate, default-off
  -- `reminders.enabled` setting; BOTH must be true for anything to be sent.
  reminders_enabled boolean  not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_status_check'
      and conrelid = 'appointments'::regclass
  ) then
    alter table appointments
      add constraint appointments_status_check
      check (status in ('booked', 'confirmed', 'cancelled', 'completed', 'no_show'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_range_check'
      and conrelid = 'appointments'::regclass
  ) then
    alter table appointments
      add constraint appointments_range_check check (ends_at > starts_at);
  end if;
end $$;

-- Double-booking is prevented by the database, not by a check-then-insert in
-- application code: two customers asking for "the 15:00" at the same moment
-- would both pass a pre-check before either committed. Slots are generated on
-- a fixed grid (agent/slots.ts), so competing bookings collide on an identical
-- starts_at and exactly one insert survives. Cancelled and completed rows are
-- excluded so a freed slot becomes bookable again.
create unique index if not exists appointments_active_slot_idx
  on appointments (account_id, starts_at)
  where status in ('booked', 'confirmed');

-- Availability lookups scan a date range; reminders scan by conversation.
create index if not exists appointments_account_starts_idx
  on appointments (account_id, starts_at);

create index if not exists appointments_conversation_idx
  on appointments (conversation_id, starts_at desc);
