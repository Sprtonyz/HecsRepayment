-- Apply to existing Deep Context installations after news-automation-schema.sql.
alter table public.news_articles
  drop constraint if exists news_articles_source_method_check;
alter table public.news_articles
  add constraint news_articles_source_method_check
  check (source_method in ('rss', 'directFeed', 'directPage', 'api'));

create table if not exists public.news_supporting_contexts (
  id text primary key,
  run_id uuid not null references public.news_collection_runs(id) on delete cascade,
  market_date date not null,
  symbol text not null,
  title text not null,
  publisher text not null,
  author text,
  original_url text not null,
  canonical_url text not null,
  published_at timestamptz,
  retrieved_at timestamptz not null,
  cleaned_text text,
  excerpt text,
  topic text not null,
  source_method text not null check (source_method in ('rss', 'directFeed', 'directPage', 'api')),
  source_id text not null,
  content_hash text not null,
  duplicate_group_id text,
  retrieval_status text not null check (retrieval_status in ('read', 'summaryOnly', 'unavailable', 'paywalled', 'blocked')),
  failure_reason text,
  relevance_score double precision not null default 0,
  quality_score double precision not null default 0,
  signal text not null check (signal in ('positive', 'neutral', 'negative')),
  signal_score double precision not null default 0,
  matched_terms jsonb not null default '[]'::jsonb,
  raw_source jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (symbol, market_date, canonical_url)
);

create index if not exists news_supporting_contexts_symbol_market_date_idx
  on public.news_supporting_contexts (symbol, market_date desc);

alter table public.news_supporting_contexts enable row level security;
revoke all on table public.news_supporting_contexts from anon, authenticated;
grant select, insert, update, delete on table public.news_supporting_contexts to service_role;
