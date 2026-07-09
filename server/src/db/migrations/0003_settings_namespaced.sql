-- Rename legacy free-form `settings` keys to the dot-namespaced runtime-config
-- keys the settings service now reads (see server/src/config/settings-schema.ts).
-- Values are preserved by renaming the row in place (UPDATE ... SET key = ...),
-- not by copy+delete, so nothing is lost if this runs on a DB with real data.
--
-- Idempotent: if a namespaced row already exists for some reason (e.g. this
-- file is re-applied against a hand-edited DB), the legacy row is dropped
-- instead of overwriting the newer value — never a silent data loss either way.

update settings set key = 'info.payment', updated_at = now()
where key = 'medios_de_pago' and not exists (select 1 from settings where key = 'info.payment');
delete from settings where key = 'medios_de_pago';

update settings set key = 'info.shipping', updated_at = now()
where key = 'envios' and not exists (select 1 from settings where key = 'info.shipping');
delete from settings where key = 'envios';

update settings set key = 'info.general', updated_at = now()
where key = 'info_general' and not exists (select 1 from settings where key = 'info.general');
delete from settings where key = 'info_general';

update settings set key = 'dispatch.template', updated_at = now()
where key = 'envio_template' and not exists (select 1 from settings where key = 'dispatch.template');
delete from settings where key = 'envio_template';

update settings set key = 'compliance.rules', updated_at = now()
where key = 'compliance_rules' and not exists (select 1 from settings where key = 'compliance.rules');
delete from settings where key = 'compliance_rules';

-- Seed any of the renamed keys that are still missing (e.g. a legacy row never
-- existed on this DB). Matches the 0001_init defaults/placeholders exactly:
-- blank, brand-neutral placeholders — the agent falls back to a neutral,
-- language-aware template at send time (see skills/orders.ts's
-- DEFAULT_DELIVERY_TEMPLATE) when `dispatch.template` is empty.
insert into settings (key, value) values
  ('info.payment', ''),
  ('info.shipping', ''),
  ('info.general', ''),
  ('compliance.rules', ''),
  ('dispatch.template', '')
on conflict (key) do nothing;
