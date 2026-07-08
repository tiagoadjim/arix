-- Rename the messages.sender allowed value 'nico' -> 'agent': the bot no
-- longer has a hardcoded persona name baked into the schema. The constraint
-- name below is Postgres's auto-generated name for the inline CHECK defined
-- on `messages.sender` in 0001_init.sql (table_column_check).
alter table messages drop constraint if exists messages_sender_check;
update messages set sender = 'agent' where sender = 'nico';
alter table messages add constraint messages_sender_check check (sender in ('customer','agent','human','system'));
