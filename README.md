# AAPL Catch-Up Tracker

A local-first personal finance app for tracking an AAPL rebuild portfolio against the USD value of the original AAPL position had it been held.

It also includes a school debt decision model for comparing an AAPL cash-out and rebuild path against continuing monthly study-loan repayments, using configurable AUD income, balance, repayment, and June indexation assumptions.

## Setup

Use Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Optional live market data:

```bash
FINNHUB_API_KEY=your_key_here
ALPHA_VANTAGE_API_KEY=
OPENAI_API_KEY=
OPENAI_NEWS_ANALYSIS_MODE=testing
```

Finnhub is used when `FINNHUB_API_KEY` exists. Without it, the app uses the manual provider and demo fallback data. Frankfurter is used for USD/AUD and AUD/USD FX rates. The deposit guide also fetches free RSS headlines from Yahoo Finance, Google News, and, for AAPL, Apple Newsroom through the server-side `/api/news` route. If `OPENAI_API_KEY` is configured, `/api/news/analyze` runs in Testing Mode by default: up to 20 new articles are analyzed with `gpt-5-nano` and no escalation. Set `OPENAI_NEWS_ANALYSIS_MODE=performance` to use Performance Mode, which analyzes with `gpt-5.4-mini` and escalates high-impact or uncertain articles to `gpt-5.4`. Results are cached locally by article and mode.

The dashboard can also prepare a monthly Codex review bundle from the This Month Deposit Guide. It writes up to 40 current-month articles, collected timestamps, readable article excerpts where available, cached API analysis, and guide context to `data/news-review-queue/YYYY-MM-aapl-codex-review.json` for a deeper local review.

For the exact analyst workflow behind the `Review Latest` chat command, read [`REVIEW_LATEST.md`](./REVIEW_LATEST.md). That file is also referenced from `AGENTS.md` so future Codex chats know to use it first.

## Shared Sync

If you want the app to keep the setup and core tracker data available across devices, enable the shared sync layer:

1. Create a Supabase project.
2. Run [`supabase/shared-review-schema.sql`](./supabase/shared-review-schema.sql) in the Supabase SQL editor.
3. Add `SUPABASE_URL` and either `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` to your Vercel project environment variables.
4. Optionally set `SHARED_REVIEW_TOKEN` on Vercel if you want the `Review Latest` endpoint protected.
5. Set `REVIEW_SOURCE_URL=https://hecs-repayment.vercel.app` in your local `.env.local` if you want the local helper script to pull from production.

Once that is configured:

- The deployed app will keep the core tracker snapshot in Supabase so a new phone, tablet, or browser can hydrate the setup instead of starting from scratch.
- Clicking `Fetch AAPL articles` on the deployed app will still cache locally on that device, and it will also upsert the fetched articles into Supabase.
- AI article analyses from `/api/news/analyze` will also sync into Supabase when they run.
- On your local machine, run `npm run review:latest` to pull the latest shared bundle into `data/news-review-queue/YYYY-MM-aapl-codex-review.json`.
- After Codex adds a `codexReview` into that local bundle, run `npm run review:publish` to push the finished review back into the shared backend.
- No extra database migration is needed for review publishing if shared article sync is already working; the published review is stored alongside the shared news records.
- The deployed app will read a shared Codex review from Supabase first, then fall back to the local file route if no shared review exists yet.
- If `SHARED_REVIEW_TOKEN` is set, both helper scripts send it as `x-review-token` automatically.

## Automated Deep Context news

The Deep Context collector is server-side and uses the five configured tickers (`AAPL`, `NVDA`, `AMZN`, `TSLA`, and `SPCX`) by default. It targets one qualified article per ticker for each US market day, records a shortfall instead of adding weak articles, stores cleaned text where permitted, and automatically publishes the monthly Codex review.

1. Run [`supabase/news-automation-schema.sql`](./supabase/news-automation-schema.sql) after the shared-review schema.
2. Set `CRON_SECRET` and `OPENAI_MONTHLY_NEWS_MODEL` in Vercel, as well as the existing Supabase secret key and `OPENAI_API_KEY`.
3. Deploy [`vercel.json`](./vercel.json). It runs collection after the US market close at 21:30 UTC Monday–Friday and retries the previous month's report on the first three days of each month.

The monitor data is stored in `news_collection_runs`, `news_source_attempts`, `news_article_rejections`, and `monthly_news_reports`. These capture targets, selected articles, full-text outcomes, attempted sources, rejection reasons, duplicate removal, shortfall days, retries and publication status. The cron endpoints require `Authorization: Bearer $CRON_SECRET`; they are not dashboard actions.

## Scripts

```bash
npm run test
npm run lint
npm run build
npm run review:latest
npm run review:publish
```

## Market Data Notes

All browser market-data, news, and AI-analysis calls go through Next.js route handlers under `app/api`, so provider API keys are not exposed client-side. Quotes, daily prices, dividends, splits, FX rates, recent news headlines, and AI article analyses are cached in IndexedDB. If a provider request fails, the UI keeps using the last cached value or manual fallback.

Market data can be delayed, incomplete, adjusted differently by each provider, or unavailable for some historical dividend/split ranges. News RSS feeds can be delayed, unavailable, or noisy. Testing Mode AI analysis is deliberately cheap and should be treated as a plumbing check rather than a high-confidence investment judgement. The app ignores tax entirely.

## School Debt Model

The study-loan repayment estimate uses the 2025-26 Australian marginal repayment structure:

- Nil up to A$67,000 repayment income.
- A$67,001 to A$125,000: 15c per A$1 above A$67,000.
- A$125,001 to A$179,285: A$8,700 plus 17c per A$1 above A$125,000.
- A$179,286 and over: 10% of total repayment income.

The model also lets you enter the observed payroll deduction, such as A$594/month, and use that instead of the formula estimate. Indexation is modelled once per year in June using your configured annual assumption.

## Storage

The core tracker still stores user-specific portfolio data locally in IndexedDB through `lib/storage/indexedDb.ts`, behind the `StorageAdapter` interface in `lib/storage/types.ts`.

When shared review sync is configured, AAPL article fetches and AI article analyses are also mirrored into Supabase so a different machine can pull the latest review bundle later without manually exporting JSON from the browser first.
