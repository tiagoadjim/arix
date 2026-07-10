-- Production hardening: authorization/session revocation, durable outbound
-- idempotency, receipt review, auditability, usage analytics and inbox cursors.

-- Existing staff historically had full administrative access. Preserve that
-- access on upgrade; newly-created staff default to the least-privileged role.
alter table staff add column if not exists role text;
update staff set role = 'admin' where role is null;
-- 0004_staff_roles called the least-privileged role `staff`; the hardened
-- runtime calls it `agent`. Keep the oldest-admin promotion from 0004 and
-- translate every remaining account before replacing its check constraint.
update staff set role = 'agent' where role = 'staff';
alter table staff alter column role set default 'agent';
alter table staff alter column role set not null;
alter table staff add column if not exists session_version integer not null default 0;
alter table staff drop constraint if exists staff_role_check;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'staff_role_check' and conrelid = 'staff'::regclass
  ) then
    alter table staff add constraint staff_role_check check (role in ('admin', 'agent'));
  end if;
end $$;

-- A caller-supplied idempotency key maps to exactly one outbound row. The
-- WhatsApp message id is derived from the same key, allowing a safe retry to
-- reuse the same remote message identifier after an ambiguous transport error.
alter table messages add column if not exists client_id text;
alter table messages add column if not exists send_lease_until timestamptz;
alter table messages add column if not exists send_attempts integer not null default 0;
-- A lease timestamp prevents simultaneous claims under normal latency, while
-- this opaque generation token fences a worker whose remote send completes
-- after its lease expired and another worker reclaimed the same row.
alter table messages add column if not exists send_attempt_id uuid;
alter table messages drop constraint if exists messages_send_status_check;
alter table messages add constraint messages_send_status_check
  check (send_status in ('pending','sending','sent','failed','cancelled'));
create unique index if not exists messages_account_client_id_uidx
  on messages (account_id, client_id) where client_id is not null;
create index if not exists messages_conversation_cursor_idx
  on messages (conversation_id, created_at desc, id desc);
create index if not exists messages_conversation_inbound_cursor_idx
  on messages (conversation_id, created_at desc, id desc) where direction = 'in';
create index if not exists messages_outbox_recovery_idx
  on messages (account_id, send_status, send_lease_until, created_at)
  where direction = 'out' and send_status in ('pending', 'sending', 'failed');
create index if not exists conversations_account_activity_cursor_idx
  on conversations (account_id, (coalesce(last_message_at, created_at)) desc, id desc);

-- Explicit per-staff read cursors. The existing conversations.unread_count is
-- retained as the shared-team badge for backwards compatibility.
create table if not exists conversation_reads (
  conversation_id uuid        not null references conversations (id) on delete cascade,
  staff_id         uuid        not null references staff (id) on delete cascade,
  last_message_id  uuid        references messages (id) on delete set null,
  read_at          timestamptz not null default now(),
  primary key (conversation_id, staff_id)
);

-- A receipt amount match is only a triage result. Order mutation is tracked as
-- a separate review decision, defaulting to pending/manual approval.
alter table receipts add column if not exists review_status text not null default 'pending';
alter table receipts add column if not exists reviewed_by uuid references staff (id) on delete set null;
alter table receipts add column if not exists reviewed_at timestamptz;
alter table receipts add column if not exists media_sha256 text;
alter table receipts add column if not exists transaction_reference text;
alter table receipts add column if not exists review_attempt_id uuid;
-- Immutable destination of the Woo status mutation represented by an active
-- review. Reconciliation must never read a setting that may have changed
-- since the side effect was attempted.
alter table receipts add column if not exists review_target_status text;
-- Before this migration, a successful amount match immediately updated Woo.
-- Preserve that semantic instead of presenting historical payments as pending.
update receipts
set review_status = case when match_status = 'match' then 'approved' else 'rejected' end,
    reviewed_at = coalesce(reviewed_at, created_at),
    note = concat_ws(' ', note, '[Migrated legacy receipt review state]')
where reviewed_at is null and review_status = 'pending';
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'receipts_review_status_check' and conrelid = 'receipts'::regclass
  ) then
    alter table receipts add constraint receipts_review_status_check
      check (review_status in ('pending', 'processing', 'approved', 'rejected'));
  end if;
end $$;
drop index if exists receipts_approved_media_sha256_uidx;
create unique index if not exists receipts_account_media_sha256_uidx
  on receipts (account_id, media_sha256)
  where media_sha256 is not null;
create unique index if not exists receipts_account_transaction_reference_uidx
  on receipts (account_id, transaction_reference)
  where transaction_reference is not null;
-- Older versions could associate more than one approved/processing receipt
-- with the same order. Keep the oldest approved claim (or oldest processing
-- claim when none is approved), reject the rest, then make both the known
-- duplicate case and concurrent claims race-safe before any Woo side effect.
with ranked_order_reviews as (
  select id,
         row_number() over (
           partition by account_id, woo_order_id
           order by case when review_status = 'approved' then 0 else 1 end,
                    reviewed_at asc nulls last, created_at asc, id asc
         ) as rn
  from receipts
  where woo_order_id is not null and review_status in ('processing', 'approved')
)
update receipts r
set review_status = 'rejected',
    review_attempt_id = null,
    note = concat_ws(' ', r.note, '[Duplicate order receipt rejected during hardening migration]')
from ranked_order_reviews ranked
where r.id = ranked.id and ranked.rn > 1;
create unique index if not exists receipts_account_active_order_uidx
  on receipts (account_id, woo_order_id)
  where woo_order_id is not null and review_status in ('processing', 'approved');
create index if not exists receipts_processing_reconciliation_idx
  on receipts (account_id, reviewed_at)
  where review_status = 'processing';

create table if not exists audit_events (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null,
  actor_id    uuid        references staff (id) on delete set null,
  action      text        not null,
  target_type text,
  target_id   text,
  request_id  text,
  ip_hash     text,
  metadata    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_events_account_created_idx
  on audit_events (account_id, created_at desc);

create table if not exists llm_usage (
  id                uuid        primary key default gen_random_uuid(),
  account_id        text        not null,
  conversation_id   uuid        references conversations (id) on delete set null,
  provider          text        not null,
  model             text        not null,
  prompt_tokens     integer     not null default 0,
  completion_tokens integer     not null default 0,
  total_tokens      integer     not null default 0,
  estimated_cost_usd numeric(14,6),
  created_at        timestamptz not null default now()
);
create index if not exists llm_usage_account_created_idx
  on llm_usage (account_id, created_at desc);
