-- One-click store connection: short-lived, single-use authorization requests.
--
-- WooCommerce's authentication endpoint hands the generated API credentials
-- back by POSTing them server-to-server to a callback URL that CANNOT be
-- session-authenticated (the store's PHP process has no dashboard cookie). The
-- row below is what makes that callback safe: it is minted by an authenticated
-- administrator, it carries the only store origin we will ever write, and it
-- can be redeemed exactly once inside a short window.

create table if not exists setup_auth_requests (
  id           uuid        primary key default gen_random_uuid(),
  account_id   text        not null,
  provider     text        not null,
  -- SHA-256 of the one-time state nonce, never the nonce itself: a database
  -- backup, replica or query log must not yield a redeemable credential.
  state_hash   text        not null unique,
  -- Origin captured when the request was minted. The callback persists THIS
  -- value; a store URL arriving in the callback body is never trusted.
  store_origin text        not null,
  created_by   uuid        references staff (id) on delete set null,
  expires_at   timestamptz not null,
  -- Set the instant the nonce is redeemed, by a conditional UPDATE, so two
  -- concurrent callbacks can never both succeed.
  consumed_at  timestamptz,
  -- Set only once credentials were actually stored, so the dashboard can tell
  -- "redeemed and connected" apart from "redeemed but rejected".
  connected_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists setup_auth_requests_expiry_idx
  on setup_auth_requests (expires_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'setup_auth_requests_provider_check'
      and conrelid = 'setup_auth_requests'::regclass
  ) then
    alter table setup_auth_requests
      add constraint setup_auth_requests_provider_check check (provider in ('woocommerce'));
  end if;
end $$;
