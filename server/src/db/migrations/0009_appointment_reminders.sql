-- Appointment reminders: the part of the appointments vertical that a business
-- actually pays for. The dolor is the no-show, and the channel already exists.
--
-- Arix already sends proactive messages (the order-dispatch notification), so
-- this is not a new category of behaviour. What IS new is the trigger: time
-- rather than a member of staff clicking. Everything below exists to make that
-- difference safe — see server/src/reminders/dispatcher.ts.

create table if not exists appointment_reminders (
  id             uuid        primary key default gen_random_uuid(),
  account_id     text        not null,
  appointment_id uuid        not null references appointments (id) on delete cascade,
  -- 'booked'       — confirmation the moment it is booked
  -- 'day_before'   — the one that actually prevents the no-show
  -- 'hours_before' — final nudge
  kind           text        not null,
  send_at        timestamptz not null,
  status         text        not null default 'pending',
  -- The outbox row this became, once sent. Null until then.
  message_id     uuid        references messages (id) on delete set null,
  -- Lease + fencing token, exactly as receipts/0005 does for review claims:
  -- two dispatchers can run (a restart overlapping the old process, a second
  -- container) and only the holder of the current attempt_id may finalize.
  lease_until    timestamptz,
  attempt_id     uuid,
  attempts       integer     not null default 0,
  -- Why a reminder was not sent, when it was not. Kept so an operator can see
  -- "deferred past the appointment" or "customer opted out" rather than
  -- silence.
  skip_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_reminders_kind_check'
      and conrelid = 'appointment_reminders'::regclass
  ) then
    alter table appointment_reminders
      add constraint appointment_reminders_kind_check
      check (kind in ('booked', 'day_before', 'hours_before'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_reminders_status_check'
      and conrelid = 'appointment_reminders'::regclass
  ) then
    alter table appointment_reminders
      add constraint appointment_reminders_status_check
      check (status in ('pending', 'sending', 'sent', 'cancelled', 'skipped', 'failed'));
  end if;
end $$;

-- One reminder of each kind per appointment, ever. Rescheduling deletes the
-- pending rows and plans fresh ones, so a customer cannot accumulate three
-- copies of the same nudge by moving their appointment three times.
create unique index if not exists appointment_reminders_unique_kind_idx
  on appointment_reminders (appointment_id, kind);

-- The dispatcher's only query: what is due now.
create index if not exists appointment_reminders_due_idx
  on appointment_reminders (account_id, status, send_at);
