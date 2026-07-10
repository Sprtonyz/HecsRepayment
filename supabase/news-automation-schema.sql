-- Durable, server-only storage for the automated Deep Context news pipeline.
-- Apply after supabase/shared-review-schema.sql.

create extension if not exists pgcrypto;

create table if not exists public.news_collection_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  market_date date not null unique,
  status text not null check (status in ('processing', 'completed', 'failed')),
  target_count integer not null check (target_count > 0),
  selected_count integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  error_summary text,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.news_source_attempts (
  id text primary key,
  run_id uuid not null references public.news_collection_runs(id) on delete cascade,
  source_id text not null,
  symbol text not null,
  attempted_at timestamptz not null,
  candidate_count integer not null default 0,
  status text not null check (status in ('success', 'failed')),
  failure_reason text,
  unique (run_id, source_id, symbol)
);

create table if not exists public.news_articles (
  id text primary key,
  run_id uuid not null references public.news_collection_runs(id) on delete restrict,
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
  unique (symbol, market_date)
);

create index if not exists news_articles_symbol_market_date_idx
  on public.news_articles (symbol, market_date desc);
create index if not exists news_articles_content_hash_idx
  on public.news_articles (content_hash);
create index if not exists news_articles_duplicate_group_idx
  on public.news_articles (duplicate_group_id);

create table if not exists public.news_article_occurrences (
  id text primary key,
  article_id text not null references public.news_articles(id) on delete cascade,
  source_id text not null,
  source_method text not null,
  source_url text not null,
  discovered_at timestamptz not null,
  raw_source jsonb,
  unique (article_id, source_url)
);

create table if not exists public.news_article_rejections (
  id text primary key,
  run_id uuid not null references public.news_collection_runs(id) on delete cascade,
  symbol text not null,
  source_id text not null,
  title text not null,
  url text not null,
  rejection_reason text not null,
  rejected_at timestamptz not null,
  raw_candidate jsonb
);

-- Context below the strong-evidence threshold is retained separately. It is
-- available to monthly analysis only and never counts towards daily coverage.
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

create index if not exists news_article_rejections_run_id_idx
  on public.news_article_rejections (run_id, symbol);

create table if not exists public.monthly_news_reports (
  id text primary key,
  symbol text not null,
  review_month text not null check (review_month ~ '^\d{4}-\d{2}$'),
  status text not null check (status in ('processing', 'published', 'failed')),
  coverage_status text not null check (coverage_status in ('complete', 'limited')),
  collected_article_count integer not null default 0,
  shortfall_day_count integer not null default 0,
  model text,
  report jsonb,
  error_summary text,
  generated_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (symbol, review_month)
);

create or replace function public.claim_deep_context_news_collection(
  p_run_key text,
  p_market_date date,
  p_target_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.news_collection_runs%rowtype;
begin
  insert into public.news_collection_runs (run_key, market_date, status, target_count)
  values (p_run_key, p_market_date, 'processing', p_target_count)
  on conflict (run_key) do nothing
  returning * into v_run;

  if found then
    return jsonb_build_object('runId', v_run.id, 'claimed', true, 'status', v_run.status);
  end if;

  select * into v_run from public.news_collection_runs where run_key = p_run_key;
  if v_run.status = 'completed' or (
    v_run.status = 'processing' and v_run.started_at > timezone('utc', now()) - interval '45 minutes'
  ) then
    return jsonb_build_object('runId', v_run.id, 'claimed', false, 'status', v_run.status);
  end if;

  update public.news_collection_runs
  set status = 'processing', error_summary = null, started_at = timezone('utc', now()), finished_at = null,
      updated_at = timezone('utc', now())
  where id = v_run.id
  returning * into v_run;
  return jsonb_build_object('runId', v_run.id, 'claimed', true, 'status', v_run.status);
end;
$$;

revoke all on function public.claim_deep_context_news_collection(text, date, integer) from public, anon, authenticated;
grant execute on function public.claim_deep_context_news_collection(text, date, integer) to service_role;

alter table public.news_collection_runs enable row level security;
alter table public.news_source_attempts enable row level security;
alter table public.news_articles enable row level security;
alter table public.news_article_occurrences enable row level security;
alter table public.news_article_rejections enable row level security;
alter table public.news_supporting_contexts enable row level security;
alter table public.monthly_news_reports enable row level security;

revoke all on table public.news_collection_runs, public.news_source_attempts, public.news_articles,
  public.news_article_occurrences, public.news_article_rejections, public.monthly_news_reports
  , public.news_supporting_contexts
  from anon, authenticated;
grant select, insert, update, delete on table public.news_collection_runs, public.news_source_attempts,
  public.news_articles, public.news_article_occurrences, public.news_article_rejections,
  public.monthly_news_reports, public.news_supporting_contexts to service_role;
