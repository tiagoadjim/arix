-- Arix — self-hosted Postgres schema baseline.
--
-- This file is migration 0001: it captures the schema exactly as it existed
-- before the versioned migration runner (see server/src/db/pool.ts) was
-- introduced. Every statement below is idempotent (safe to re-run), matching
-- the original single-file schema.sql this replaces.
--
-- IMPORTANT: do NOT edit the `messages.sender` check constraint below to add
-- 'agent' — that rename (and the data backfill from the old 'nico' value) is
-- handled by 0002_sender_agent.sql so existing databases migrate correctly.
-- New migrations go in new NNNN_*.sql files; never edit an applied one.

create extension if not exists pgcrypto;

-- Staff (dashboard login).
create table if not exists staff (
  id            uuid        primary key default gen_random_uuid(),
  email         text        unique not null,
  password_hash text        not null,
  name          text,
  created_at    timestamptz not null default now()
);

-- Baileys auth state (one row per Signal key).
create table if not exists wa_auth_state (
  account_id  text        not null,
  id          text        not null,
  category    text        not null,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (account_id, id)
);
create index if not exists wa_auth_state_category_idx on wa_auth_state (account_id, category);

-- Conversations (one per WhatsApp chat).
create table if not exists conversations (
  id                   uuid        primary key default gen_random_uuid(),
  account_id           text        not null,
  wa_jid               text        not null,
  phone                text,
  customer_name        text,
  customer_email       text,
  mode                 text        not null default 'bot' check (mode in ('bot','human')),
  assigned_to          uuid        references staff (id) on delete set null,
  status               text        not null default 'open' check (status in ('open','closed')),
  escalation_reason    text,
  unread_count         integer     not null default 0,
  last_message_at      timestamptz,
  last_message_preview text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (account_id, wa_jid)
);
-- For DBs created before customer_email existed.
alter table conversations add column if not exists customer_email text;
create index if not exists conversations_account_lastmsg_idx
  on conversations (account_id, last_message_at desc);
create index if not exists conversations_mode_idx on conversations (account_id, mode);

-- Messages.
create table if not exists messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references conversations (id) on delete cascade,
  account_id      text        not null,
  direction       text        not null check (direction in ('in','out')),
  sender          text        not null check (sender in ('customer','nico','human','system')),
  wa_message_id   text,
  msg_type        text        not null default 'text'
                              check (msg_type in ('text','image','audio','video','document','sticker','other')),
  body            text,
  media_url       text,
  media_mime      text,
  send_status     text        check (send_status in ('pending','sending','sent','failed')),
  sent_by         uuid        references staff (id) on delete set null,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, created_at);
create unique index if not exists messages_wa_id_uidx
  on messages (account_id, wa_message_id) where wa_message_id is not null;

-- Receipts (transfer proofs validated against WooCommerce).
create table if not exists receipts (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null references conversations (id) on delete cascade,
  message_id       uuid        references messages (id) on delete set null,
  account_id       text        not null,
  order_number     text,
  woo_order_id     bigint,
  media_url        text,
  extracted_amount numeric(12,2),
  woo_total        numeric(12,2),
  currency         text,
  match_status     text        not null default 'pending'
                              check (match_status in ('match','mismatch','unreadable','pending')),
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists receipts_conversation_idx on receipts (conversation_id, created_at desc);

-- updated_at trigger for conversations.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists conversations_set_updated_at on conversations;
create trigger conversations_set_updated_at
  before update on conversations
  for each row execute function set_updated_at();

-- Atomic conversation bump (no read-modify-write race on unread_count).
create or replace function bump_conversation(conv_id uuid, preview text, from_customer boolean)
returns void language sql as $$
  update conversations
  set last_message_at = now(),
      last_message_preview = left(preview, 160),
      unread_count = case when from_customer then unread_count + 1 else 0 end
  where id = conv_id;
$$;

-- Store settings: editable info blocks (payment methods, shipping, etc.) that the
-- dashboard maintains and the agent reads to answer FAQs. Key/value text.
create table if not exists settings (
  key        text        primary key,
  value      text        not null default '',
  updated_at timestamptz not null default now()
);

-- Seed defaults only if absent (editable later from the dashboard). Values are
-- intentionally blank/generic placeholders for a fresh, brand-neutral install —
-- a real deployment fills these in from the dashboard.
insert into settings (key, value) values
  ('medios_de_pago', ''),
  ('envios', ''),
  ('info_general', ''),
  ('compliance_rules', ''),
  ('uber_envio_template',
   '🛵 ¡Tu pedido #{numero} ya salió para entrega!

Seguí al repartidor en tiempo real acá:
{link}

Tu código de entrega es: *{codigo}*
Decíselo al repartidor cuando llegue para recibir tu pedido. ¡Gracias por tu compra! 💚')
on conflict (key) do nothing;
