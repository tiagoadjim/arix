-- Administrative authorization.
--
-- Existing installations predate roles. Promote the oldest staff account
-- (the original bootstrap account) to admin and keep every other account as
-- regular staff. New installations also run this after 0001, so the setup
-- wizard's first account becomes the admin.

alter table staff
  add column if not exists role text not null default 'staff'
  check (role in ('admin', 'staff'));

update staff
set role = 'admin'
where id = (
  select id
  from staff
  order by created_at asc, id asc
  limit 1
);
