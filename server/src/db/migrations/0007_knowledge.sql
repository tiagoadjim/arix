-- Knowledge base: the business facts the agent may state.
--
-- This is what lets Arix serve a business that has no product catalog behind
-- it. Where the ecommerce vertical grounds every price in a live WooCommerce
-- lookup, a gym or an accountant grounds every answer here: the agent is told
-- to call search_knowledge before stating a price, a requirement or a
-- turnaround, so it cannot invent one.

create table if not exists knowledge_entries (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null,
  question    text        not null,
  answer      text        not null,
  tags        text[]      not null default '{}',
  -- Set when the entry came from the website scan, so an operator can see
  -- where a fact was learned and re-check it against the page.
  source_url  text,
  created_by  uuid        references staff (id) on delete set null,
  -- Accent-folded, lowercased haystack maintained by the application
  -- (db/search-text.ts) so the write and query paths normalize identically
  -- without depending on the `unaccent` extension being installable.
  search_text text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 'simple' rather than a language dictionary on purpose: the dictionary would
-- have to be fixed at migration time, but agent.language is a runtime setting
-- and a deployment can switch it. Accent folding already happens upstream.
create index if not exists knowledge_entries_fts_idx
  on knowledge_entries using gin (to_tsvector('simple', search_text));

create index if not exists knowledge_entries_account_idx
  on knowledge_entries (account_id, updated_at desc);
