-- Let an appointment exist without a WhatsApp conversation.
--
-- 0008 required one, because every appointment came from a chat. But a real
-- agenda is not only what the bot booked: in a salon or a clinic a large share
-- of appointments arrive by phone or over the counter. An agenda that shows
-- half the day is not an agenda, and the team keeps its paper book.
--
-- This also buys a safety property for free rather than for code: the reminder
-- dispatcher's claim query INNER JOINs conversations (see claimDueReminders in
-- db/repo.ts), so an appointment with no conversation can never produce a
-- reminder. The guarantee that Arix only ever messages a number that wrote
-- first is therefore enforced by the schema, not by a check someone could
-- forget to write.

alter table appointments
  alter column conversation_id drop not null;
